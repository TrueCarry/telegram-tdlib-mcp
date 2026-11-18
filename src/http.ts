#!/usr/bin/env node
/**
 * Streamable HTTP transport for the Telegram TDLib MCP server.
 *
 * Unlike the stdio entry point, this is a SINGLE long-running process shared by
 * all clients. That is a hard requirement, not a preference: TDLib takes an
 * exclusive lock on `td.binlog`, so a second instance pointed at the same
 * database directory cannot start. All HTTP sessions therefore multiplex onto
 * one authorized Telegram account.
 *
 * Authentication (at least one is required):
 *   - OAuth 2.1 (TG_OAUTH_ACCESS_CODE + TG_PUBLIC_URL) for interactive MCP
 *     clients such as Claude. Users approve a connection by entering the
 *     access code on a consent page.
 *   - Static bearer token (TG_HTTP_TOKEN) for bots and scripts.
 * Both may be enabled at once; either credential is accepted on /mcp.
 *
 * Endpoints:
 *   POST   /mcp     JSON-RPC requests (initialize, tools/list, tools/call, ...)
 *   GET    /mcp     SSE stream for server-initiated messages (needs session id)
 *   DELETE /mcp     terminate a session
 *   GET    /health  liveness probe (no auth, no identifying details)
 *   OAuth discovery, /register, /authorize, /token, /revoke when OAuth is on
 */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Server } from 'node:http'

import express, { type NextFunction, type Request, type Response } from 'express'
import { rateLimit } from 'express-rate-limit'

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js'

import { getCatalog } from './catalog.js'
import { getHttpConfig, type HttpConfig } from './config.js'
import { AccessCodeOAuthProvider } from './oauth.js'
import {
  SERVER_NAME,
  buildServer,
  installShutdownHandlers,
  startVersionCheck,
} from './server.js'

interface Session {
  transport: StreamableHTTPServerTransport
  createdAt: number
  lastSeenAt: number
  client: string
}

/** Active MCP sessions, keyed by the session id issued at initialize time. */
const sessions = new Map<string, Session>()

function describeAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}

/**
 * Closes sessions that are idle or too old.
 *
 * MCP clients are not obliged to send `DELETE /mcp`, and in practice most just
 * disconnect. Without expiry each abandoned session keeps an McpServer and its
 * transport alive for the lifetime of the process.
 */
function sweepSessions(idleMs: number, maxLifetimeMs: number): void {
  if (idleMs <= 0 && maxLifetimeMs <= 0) return
  const now = Date.now()

  for (const [id, session] of [...sessions]) {
    const idleFor = now - session.lastSeenAt
    const ageFor = now - session.createdAt

    const expiredIdle = idleMs > 0 && idleFor > idleMs
    const expiredAge = maxLifetimeMs > 0 && ageFor > maxLifetimeMs
    if (!expiredIdle && !expiredAge) continue

    const reason = expiredIdle ? `idle ${describeAge(idleFor)}` : `age ${describeAge(ageFor)}`
    sessions.delete(id)
    console.error(
      `[${SERVER_NAME}] expiring session ${id} (${reason}, client=${session.client}); ` +
        `${sessions.size} active`,
    )
    // close() triggers onclose, which is already a no-op once removed.
    void session.transport.close().catch(err => {
      console.error(`[${SERVER_NAME}] error closing expired session ${id}:`, err)
    })
  }
}

/** Compares tokens in constant time so the endpoint cannot be probed byte-wise. */
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** JSON-RPC shaped error, which MCP clients understand better than bare text. */
function sendRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null })
}

function bearerFrom(req: Request): string | undefined {
  const header = req.headers.authorization
  if (!header) return undefined
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1]!.trim() : undefined
}

/** Best-effort client name from an initialize body, for log lines. */
function describeClient(body: unknown): string {
  const messages = Array.isArray(body) ? body : [body]
  for (const m of messages) {
    const info = (m as { params?: { clientInfo?: { name?: unknown; version?: unknown } } })?.params
      ?.clientInfo
    if (info && typeof info.name === 'string') {
      return typeof info.version === 'string' ? `${info.name}/${info.version}` : info.name
    }
  }
  return 'unknown'
}

/** True if the body is an `initialize` request (single or batched). */
function isInitialize(body: unknown): boolean {
  const one = (m: unknown) =>
    typeof m === 'object' && m !== null && (m as { method?: unknown }).method === 'initialize'
  return Array.isArray(body) ? body.some(one) : one(body)
}

/**
 * Accepts either a static TG_HTTP_TOKEN or an OAuth access token.
 *
 * On failure, advertises the protected-resource metadata URL in
 * WWW-Authenticate so OAuth-capable clients can discover how to sign in.
 */
function authMiddleware(
  cfg: HttpConfig,
  oauth: AccessCodeOAuthProvider | undefined,
  resourceMetadataUrl: string | undefined,
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!cfg.token && !oauth) return next() // explicitly disabled via TG_HTTP_ALLOW_NO_AUTH

    const presented = bearerFrom(req)
    if (presented) {
      if (cfg.token && tokenMatches(presented, cfg.token)) return next()
      if (oauth) {
        try {
          await oauth.verifyAccessToken(presented)
          return next()
        } catch {
          // fall through to 401
        }
      }
    }

    const challenge = resourceMetadataUrl
      ? `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`
      : 'Bearer'
    res.setHeader('WWW-Authenticate', challenge)
    sendRpcError(res, 401, -32001, 'Unauthorized')
  }
}

async function main() {
  const cfg = getHttpConfig()

  const catalog = getCatalog()
  console.error(
    `[${SERVER_NAME}] catalog: TDLib ${catalog.tdlibVersion} ` +
      `(${catalog.methods.length} methods, ${catalog.types.length} types)`,
  )

  const app = express()
  app.disable('x-powered-by')
  // Behind Coolify/Traefik (or any proxy), trust X-Forwarded-* from the first
  // hop so rate limiting keys on the real client address.
  app.set('trust proxy', 1)

  // Liveness probe: deliberately free of account details so it can be polled
  // by an unauthenticated monitor without leaking who is logged in.
  app.get('/health', (_req, res) => {
    const now = Date.now()
    res.json({
      status: 'ok',
      server: SERVER_NAME,
      transport: 'streamable-http',
      oauth: Boolean(oauth),
      sessions: sessions.size,
      max_sessions: cfg.maxSessions || null,
      session_idle_timeout_ms: cfg.sessionIdleMs || null,
      session_max_lifetime_ms: cfg.sessionMaxLifetimeMs || null,
      oldest_session_age_ms:
        sessions.size === 0
          ? null
          : Math.max(...[...sessions.values()].map(s => now - s.createdAt)),
    })
  })

  // --- OAuth ---------------------------------------------------------------
  let oauth: AccessCodeOAuthProvider | undefined
  let resourceMetadataUrl: string | undefined
  let oauthSweep: NodeJS.Timeout | undefined

  if (cfg.oauthAccessCode && cfg.publicUrl) {
    const resourceUrl = new URL(cfg.path, cfg.publicUrl)
    oauth = new AccessCodeOAuthProvider({
      accessCode: cfg.oauthAccessCode,
      accessTokenTtlSeconds: cfg.oauthAccessTokenTtlSeconds,
      refreshTokenTtlSeconds: cfg.oauthRefreshTokenTtlSeconds,
      resourceUrl,
    })
    resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl)

    // Discovery metadata, /register, /authorize, /token, /revoke.
    app.use(
      mcpAuthRouter({
        provider: oauth,
        issuerUrl: cfg.publicUrl,
        resourceServerUrl: resourceUrl,
        resourceName: 'Telegram TDLib MCP',
      }),
    )

    // Consent form submission. Tightly rate limited: this is where the access
    // code is checked, so it is the only place worth brute-forcing.
    app.post(
      '/authorize/approve',
      rateLimit({
        windowMs: 15 * 60 * 1000,
        limit: 10,
        standardHeaders: true,
        legacyHeaders: false,
        message: 'Too many attempts. Try again later.',
      }),
      express.urlencoded({ extended: false, limit: '4kb' }),
      oauth.handleApproval,
    )

    oauthSweep = setInterval(() => oauth?.sweep(), 60_000)
    oauthSweep.unref()
  }

  // --- MCP endpoint --------------------------------------------------------
  app.all(
    cfg.path,
    authMiddleware(cfg, oauth, resourceMetadataUrl),
    express.json({ limit: cfg.maxBodyBytes }),
    async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id']
      const sid = Array.isArray(sessionId) ? sessionId[0] : sessionId

      // --- existing session: hand straight to its transport ------------------
      if (sid) {
        const existing = sessions.get(sid)
        if (!existing) {
          sendRpcError(
            res,
            404,
            -32001,
            'Unknown or expired session id. Sessions expire after inactivity; send initialize again.',
          )
          return
        }
        // Refresh on entry and again on exit: a long-poll can finish well after
        // it began, and must not be reaped as idle while it was in fact busy.
        existing.lastSeenAt = Date.now()
        await existing.transport.handleRequest(req, res, req.method === 'POST' ? req.body : undefined)
        existing.lastSeenAt = Date.now()
        return
      }

      // --- no session id: only a fresh initialize is acceptable --------------
      if (req.method !== 'POST') {
        sendRpcError(res, 400, -32000, 'Missing mcp-session-id header')
        return
      }

      const body: unknown = req.body
      if (!isInitialize(body)) {
        sendRpcError(res, 400, -32000, 'Missing mcp-session-id header; send initialize first')
        return
      }

      // Reap before the cap check so expired slots are reclaimed first, and a
      // burst of abandoned sessions cannot lock out a legitimate client.
      sweepSessions(cfg.sessionIdleMs, cfg.sessionMaxLifetimeMs)

      if (cfg.maxSessions > 0 && sessions.size >= cfg.maxSessions) {
        console.error(
          `[${SERVER_NAME}] refusing new session: ${sessions.size}/${cfg.maxSessions} in use`,
        )
        sendRpcError(
          res,
          503,
          -32000,
          `Too many active sessions (${sessions.size}/${cfg.maxSessions}). Existing sessions ` +
            `expire after inactivity; retry shortly, or have clients send DELETE when done.`,
        )
        return
      }

      const clientName = describeClient(body)

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: cfg.jsonResponse,
        // Rejects requests whose Host header is not ours (DNS rebinding).
        enableDnsRebindingProtection: cfg.dnsRebindingProtection,
        allowedHosts: cfg.allowedHosts,
        onsessioninitialized: id => {
          const now = Date.now()
          sessions.set(id, { transport, createdAt: now, lastSeenAt: now, client: clientName })
          console.error(
            `[${SERVER_NAME}] session opened: ${id} (client=${clientName}, ${sessions.size} active)`,
          )
        },
        onsessionclosed: id => {
          if (sessions.delete(id)) {
            console.error(`[${SERVER_NAME}] session closed: ${id} (${sessions.size} active)`)
          }
        },
      })

      transport.onclose = () => {
        const id = transport.sessionId
        if (id && sessions.delete(id)) {
          console.error(`[${SERVER_NAME}] session closed: ${id} (${sessions.size} active)`)
        }
      }

      // A fresh McpServer per session keeps per-connection state (capabilities,
      // request ids) isolated. They all share the single TelegramSession.
      const server = buildServer()
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    },
  )

  app.use((_req, res) => {
    sendRpcError(res, 404, -32601, `Not found. MCP endpoint is ${cfg.path}`)
  })

  // Malformed JSON and oversized bodies land here from express.json().
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { status?: number; type?: string; message?: string }
    if (e?.type === 'entity.too.large') {
      sendRpcError(res, 413, -32700, 'Request body too large')
    } else if (e?.type === 'entity.parse.failed') {
      sendRpcError(res, 400, -32700, 'Parse error: invalid JSON')
    } else {
      console.error(`[${SERVER_NAME}] request failed:`, err)
      if (!res.headersSent) sendRpcError(res, 500, -32603, 'Internal server error')
      else res.end()
    }
  })

  const httpServer = await new Promise<Server>((resolvePromise, reject) => {
    const s = app.listen(cfg.port, cfg.host, () => resolvePromise(s))
    s.once('error', reject)
  })

  const shown = cfg.host === '0.0.0.0' || cfg.host === '::' ? 'localhost' : cfg.host
  console.error(`[${SERVER_NAME}] listening on http://${shown}:${cfg.port}${cfg.path}`)
  console.error(`[${SERVER_NAME}] health:    http://${shown}:${cfg.port}/health`)
  if (cfg.publicUrl) {
    console.error(`[${SERVER_NAME}] public:    ${new URL(cfg.path, cfg.publicUrl).href}`)
  }
  const modes = [
    oauth ? 'OAuth (access code)' : undefined,
    cfg.token ? 'static bearer token' : undefined,
  ].filter(Boolean)
  console.error(
    modes.length
      ? `[${SERVER_NAME}] auth: ${modes.join(' + ')}`
      : `[${SERVER_NAME}] auth: DISABLED (TG_HTTP_ALLOW_NO_AUTH) - anyone who can reach ` +
          `this port controls the Telegram account`,
  )

  console.error(
    `[${SERVER_NAME}] sessions: idle timeout ` +
      `${cfg.sessionIdleMs ? describeAge(cfg.sessionIdleMs) : 'off'}, ` +
      `max lifetime ${cfg.sessionMaxLifetimeMs ? describeAge(cfg.sessionMaxLifetimeMs) : 'off'}, ` +
      `limit ${cfg.maxSessions || 'unlimited'}`,
  )

  // unref() so the timer never keeps the process alive on its own.
  const sweepTimer = setInterval(
    () => sweepSessions(cfg.sessionIdleMs, cfg.sessionMaxLifetimeMs),
    cfg.sweepIntervalMs,
  )
  sweepTimer.unref()

  startVersionCheck()

  installShutdownHandlers(async () => {
    clearInterval(sweepTimer)
    if (oauthSweep) clearInterval(oauthSweep)
    for (const [id, session] of sessions) {
      try {
        await session.transport.close()
      } catch (err) {
        console.error(`[${SERVER_NAME}] failed closing session ${id}:`, err)
      }
    }
    sessions.clear()
    await new Promise<void>(done => httpServer.close(() => done()))
  })
}

main().catch(err => {
  console.error(`[${SERVER_NAME}] fatal:`, err)
  process.exit(1)
})
