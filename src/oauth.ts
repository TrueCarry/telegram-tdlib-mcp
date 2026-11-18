/**
 * Minimal OAuth 2.1 authorization server for the public HTTP deployment.
 *
 * MCP clients such as Claude discover this via the standard metadata
 * endpoints, register themselves dynamically, and send the user here to
 * approve access. The only "login" is a single shared access code taken from
 * the environment (TG_OAUTH_ACCESS_CODE): whoever knows it may connect.
 *
 * Protocol mechanics (discovery metadata, dynamic client registration, PKCE
 * verification, rate limiting) are handled by the MCP SDK's mcpAuthRouter.
 * This module only supplies storage and the consent step.
 *
 * Everything is held in memory. A restart invalidates all tokens and client
 * registrations; MCP clients recover by re-running the flow automatically.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'

import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js'
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import {
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'

const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000
const AUTH_CODE_TTL_MS = 5 * 60 * 1000
const MAX_CLIENTS = 1000
const MAX_PENDING = 1000

export interface OAuthOptions {
  /** The shared secret a user must type to approve a connection. */
  accessCode: string
  /** Access token lifetime in seconds. */
  accessTokenTtlSeconds: number
  /** Refresh token lifetime in seconds. */
  refreshTokenTtlSeconds: number
  /** Canonical MCP endpoint URL; tokens are bound to it (RFC 8707). */
  resourceUrl: URL
}

interface PendingAuthorization {
  clientId: string
  params: AuthorizationParams
  expiresAt: number
}

interface IssuedCode {
  clientId: string
  codeChallenge: string
  redirectUri: string
  scopes: string[]
  resource?: URL
  expiresAt: number
}

interface IssuedToken {
  clientId: string
  scopes: string[]
  resource?: URL
  expiresAt: number
}

function newSecret(): string {
  return randomBytes(32).toString('base64url')
}

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Drops the oldest entries once a map exceeds its cap (Maps keep insertion order). */
function capMap<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value as K
    map.delete(oldest)
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

class InMemoryClientsStore implements OAuthRegisteredClientsStore {
  private readonly clients = new Map<string, OAuthClientInformationFull>()

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.clients.get(clientId)
  }

  registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
    // Registration is open by design (MCP clients self-register), so cap the
    // store to keep anonymous registrations from growing memory without bound.
    this.clients.set(client.client_id, client)
    capMap(this.clients, MAX_CLIENTS)
    return client
  }
}

export class AccessCodeOAuthProvider implements OAuthServerProvider {
  readonly clientsStore = new InMemoryClientsStore()

  private readonly pending = new Map<string, PendingAuthorization>()
  private readonly codes = new Map<string, IssuedCode>()
  private readonly accessTokens = new Map<string, IssuedToken>()
  private readonly refreshTokens = new Map<string, IssuedToken>()

  constructor(private readonly options: OAuthOptions) {}

  /** Shows the consent page. The real decision happens in handleApproval(). */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.sweep()
    const requestId = newSecret()
    this.pending.set(requestId, {
      clientId: client.client_id,
      params,
      expiresAt: Date.now() + AUTH_REQUEST_TTL_MS,
    })
    capMap(this.pending, MAX_PENDING)
    sendConsentPage(res, {
      requestId,
      clientName: client.client_name ?? client.client_id,
      redirectUri: params.redirectUri,
    })
  }

  /**
   * POST handler for the consent form. Validates the access code and, on
   * success, redirects back to the client with an authorization code.
   */
  handleApproval = (req: Request, res: Response): void => {
    res.setHeader('Cache-Control', 'no-store')
    const body = (req.body ?? {}) as Record<string, unknown>
    const requestId = typeof body.request_id === 'string' ? body.request_id : ''
    const code = typeof body.access_code === 'string' ? body.access_code.trim() : ''
    const action = body.action === 'deny' ? 'deny' : 'approve'

    const request = this.pending.get(requestId)
    if (!request || request.expiresAt < Date.now()) {
      this.pending.delete(requestId)
      res
        .status(400)
        .type('html')
        .send(page('Request expired', '<p>This sign-in request has expired. Start the connection again from your MCP client.</p>'))
      return
    }

    const redirect = new URL(request.params.redirectUri)
    if (request.params.state !== undefined) redirect.searchParams.set('state', request.params.state)

    if (action === 'deny') {
      this.pending.delete(requestId)
      redirect.searchParams.set('error', 'access_denied')
      redirect.searchParams.set('error_description', 'The user denied the request')
      res.redirect(302, redirect.href)
      return
    }

    if (!secretsMatch(code, this.options.accessCode)) {
      // Keep the pending request so the user can retry; the SDK's rate limiter
      // on /authorize plus the one on this route bound guessing.
      const client = this.clientsStore.getClient(request.clientId)
      sendConsentPage(
        res,
        {
          requestId,
          clientName: client?.client_name ?? request.clientId,
          redirectUri: request.params.redirectUri,
          error: 'Incorrect access code.',
        },
        401,
      )
      return
    }

    this.pending.delete(requestId)
    const authCode = newSecret()
    this.codes.set(authCode, {
      clientId: request.clientId,
      codeChallenge: request.params.codeChallenge,
      redirectUri: request.params.redirectUri,
      scopes: request.params.scopes ?? [],
      resource: request.params.resource,
      expiresAt: Date.now() + AUTH_CODE_TTL_MS,
    })
    capMap(this.codes, MAX_PENDING)

    redirect.searchParams.set('code', authCode)
    res.redirect(302, redirect.href)
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const issued = this.codes.get(authorizationCode)
    if (!issued || issued.clientId !== client.client_id || issued.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code')
    }
    return issued.codeChallenge
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const issued = this.codes.get(authorizationCode)
    // Single use: remove before any further checks so a replay always fails.
    this.codes.delete(authorizationCode)

    if (!issued || issued.clientId !== client.client_id || issued.expiresAt < Date.now()) {
      throw new InvalidGrantError('Invalid or expired authorization code')
    }
    if (redirectUri !== undefined && redirectUri !== issued.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request')
    }
    this.assertResource(resource ?? issued.resource)

    return this.issueTokens(client.client_id, issued.scopes, resource ?? issued.resource)
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const issued = this.refreshTokens.get(refreshToken)
    if (!issued || issued.clientId !== client.client_id || issued.expiresAt < Date.now()) {
      this.refreshTokens.delete(refreshToken)
      throw new InvalidGrantError('Invalid or expired refresh token')
    }
    if (scopes && scopes.some(s => !issued.scopes.includes(s))) {
      throw new InvalidGrantError('Requested scopes exceed the original grant')
    }
    this.assertResource(resource ?? issued.resource)

    // Rotate refresh tokens so a leaked one stops working after its next use.
    this.refreshTokens.delete(refreshToken)
    return this.issueTokens(client.client_id, scopes ?? issued.scopes, resource ?? issued.resource)
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const issued = this.accessTokens.get(token)
    if (!issued || issued.expiresAt < Date.now()) {
      this.accessTokens.delete(token)
      throw new InvalidTokenError('Invalid or expired access token')
    }
    return {
      token,
      clientId: issued.clientId,
      scopes: issued.scopes,
      expiresAt: Math.floor(issued.expiresAt / 1000),
      resource: issued.resource,
    }
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    for (const store of [this.accessTokens, this.refreshTokens]) {
      const issued = store.get(request.token)
      if (issued && issued.clientId === client.client_id) store.delete(request.token)
    }
  }

  /** Removes expired entries; called opportunistically and on a timer. */
  sweep(): void {
    const now = Date.now()
    for (const [k, v] of this.pending) if (v.expiresAt < now) this.pending.delete(k)
    for (const [k, v] of this.codes) if (v.expiresAt < now) this.codes.delete(k)
    for (const [k, v] of this.accessTokens) if (v.expiresAt < now) this.accessTokens.delete(k)
    for (const [k, v] of this.refreshTokens) if (v.expiresAt < now) this.refreshTokens.delete(k)
  }

  private assertResource(resource: URL | undefined): void {
    // Clients that send `resource` must target this server; tokens minted for
    // another resource must not be accepted here.
    if (resource && resource.href !== this.options.resourceUrl.href) {
      throw new InvalidRequestError(`Token requested for unknown resource: ${resource.href}`)
    }
  }

  private issueTokens(clientId: string, scopes: string[], resource?: URL): OAuthTokens {
    const now = Date.now()
    const accessToken = newSecret()
    const refreshToken = newSecret()
    this.accessTokens.set(accessToken, {
      clientId,
      scopes,
      resource,
      expiresAt: now + this.options.accessTokenTtlSeconds * 1000,
    })
    this.refreshTokens.set(refreshToken, {
      clientId,
      scopes,
      resource,
      expiresAt: now + this.options.refreshTokenTtlSeconds * 1000,
    })
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.options.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(' ') || undefined,
    }
  }
}

/**
 * CSP source expression for the client's redirect target.
 *
 * Browsers apply `form-action` to every redirect that follows a form
 * submission, not just the form's own target. Approving POSTs to this server
 * and then 302s to the client's callback (e.g. https://claude.ai/...), so that
 * origin must be allowed or the browser blocks the final hop. The redirect URI
 * has already been checked against the client's registered redirect_uris.
 *
 * Returns undefined for anything that cannot be expressed safely, so a strange
 * value can never inject extra directives into the header.
 */
export function redirectFormActionSource(uri: string): string | undefined {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return undefined
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    // origin is scheme://host[:port], which is a valid host-source.
    return url.origin
  }
  // Native apps register custom schemes (e.g. cursor://). Only a scheme-source
  // can express those; allow just that scheme, and only if it is well formed.
  return /^[a-z][a-z0-9+.-]*:$/i.test(url.protocol) ? url.protocol : undefined
}

export function consentPageCsp(redirectUri: string): string {
  const target = redirectFormActionSource(redirectUri)
  const formAction = target ? `'self' ${target}` : "'self'"
  return `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'`
}

function safeHost(uri: string): string {
  try {
    return new URL(uri).host
  } catch {
    return uri
  }
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#f4f5f7;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,.08);max-width:380px;width:100%}
  h1{font-size:1.25rem;margin:0 0 1rem}
  p{color:#444;line-height:1.45}
  .warn{background:#fff6e5;border:1px solid #f0c36d;padding:.75rem;border-radius:8px;font-size:.9rem}
  .err{color:#b00020;font-weight:600}
  input{width:100%;box-sizing:border-box;padding:.6rem;font-size:1rem;border:1px solid #ccc;border-radius:8px;margin:.5rem 0 1rem}
  .row{display:flex;gap:.5rem}
  button{flex:1;padding:.6rem;font-size:1rem;border-radius:8px;border:0;cursor:pointer}
  .ok{background:#2563eb;color:#fff}.no{background:#e5e7eb}
</style></head><body><div class="card">${body}</div></body></html>`
}

function sendConsentPage(
  res: Response,
  view: { requestId: string; clientName: string; redirectUri: string; error?: string },
  status = 200,
): void {
  res.setHeader('Cache-Control', 'no-store')
  // The page holds a single-use request id; never let it be framed.
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Content-Security-Policy', consentPageCsp(view.redirectUri))
  res
    .status(status)
    .type('html')
    .send(
      page(
        'Authorize access',
        `<h1>Connect to Telegram MCP</h1>
<p><strong>${escapeHtml(view.clientName)}</strong> wants access to this server and will
be able to read chats, send messages and press bot buttons as the logged-in Telegram account.</p>
<p class="warn">After approval you will be returned to <strong>${escapeHtml(safeHost(view.redirectUri))}</strong>.</p>
${view.error ? `<p class="err">${escapeHtml(view.error)}</p>` : ''}
<form method="post" action="/authorize/approve">
  <input type="hidden" name="request_id" value="${escapeHtml(view.requestId)}">
  <label for="code">Access code</label>
  <input id="code" name="access_code" type="password" autocomplete="off" autofocus>
  <div class="row">
    <button class="no" type="submit" name="action" value="deny">Deny</button>
    <button class="ok" type="submit" name="action" value="approve">Approve</button>
  </div>
</form>`,
      ),
    )
}
