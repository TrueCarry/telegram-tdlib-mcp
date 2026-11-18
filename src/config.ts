import { readFileSync } from 'node:fs'
import { resolve, isAbsolute } from 'node:path'

/**
 * Minimal .env loader. Avoids a dotenv dependency; only parses `KEY=value`
 * lines and never overrides variables already present in the environment.
 */
function loadDotEnv(path: string): void {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return // no .env file is fine - env vars may come from the MCP client config
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    // Strip matching surrounding quotes
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

loadDotEnv(resolve(process.cwd(), '.env'))

export interface Config {
  apiId: number
  apiHash: string
  databaseDirectory: string
  filesDirectory: string
  updateBufferSize: number
  useTestDc: boolean
}

function requireInt(name: string): number {
  const raw = process.env[name]
  if (!raw) {
    throw new Error(
      `${name} is not set. Obtain api_id/api_hash from https://my.telegram.org/apps ` +
        `and set them in .env or in your MCP client's server env config.`,
    )
  }
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`)
  }
  return n
}

function requireString(name: string): string {
  const raw = process.env[name]
  if (!raw) {
    throw new Error(
      `${name} is not set. Obtain api_id/api_hash from https://my.telegram.org/apps ` +
        `and set them in .env or in your MCP client's server env config.`,
    )
  }
  return raw
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Like optionalInt but accepts 0, which callers use to mean "no limit".
 * Negative and malformed values fall back rather than disabling silently.
 */
function optionalIntAllowZero(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * Update buffer size, readable without requiring credentials so that the
 * server can start (and serve tg_schema) before it is configured to log in.
 */
export function getUpdateBufferSize(): number {
  return optionalInt('TG_UPDATE_BUFFER_SIZE', 1000)
}

export interface HttpConfig {
  host: string
  port: number
  path: string
  /** Bearer token; undefined only when auth is explicitly disabled. */
  token: string | undefined
  jsonResponse: boolean
  dnsRebindingProtection: boolean
  allowedHosts: string[] | undefined
  maxBodyBytes: number
  /** Close a session after this long with no requests. 0 disables. */
  sessionIdleMs: number
  /** Close a session this long after it opened, active or not. 0 disables. */
  sessionMaxLifetimeMs: number
  /** Reject new sessions past this many concurrently. 0 disables. */
  maxSessions: number
  /** How often the reaper runs. */
  sweepIntervalMs: number
  /** Public base URL (e.g. https://tg.example.com); required for OAuth. */
  publicUrl: URL | undefined
  /** OAuth is enabled when set: users approve connections by entering it. */
  oauthAccessCode: string | undefined
  oauthAccessTokenTtlSeconds: number
  oauthRefreshTokenTtlSeconds: number
}

/**
 * HTTP transport settings.
 *
 * Defaults are deliberately closed: loopback only, and a token is mandatory.
 * The endpoint drives a logged-in Telegram account with no per-caller
 * permission model, so an unauthenticated listener is a full account takeover
 * for anyone who can reach the port. Opting out requires TG_HTTP_ALLOW_NO_AUTH.
 */
export function getHttpConfig(): HttpConfig {
  const host = process.env.TG_HTTP_HOST ?? '127.0.0.1'
  const port = optionalInt('TG_HTTP_PORT', 8787)

  let path = process.env.TG_HTTP_PATH ?? '/mcp'
  if (!path.startsWith('/')) path = `/${path}`

  const token = process.env.TG_HTTP_TOKEN?.trim() || undefined
  const allowNoAuth =
    process.env.TG_HTTP_ALLOW_NO_AUTH === '1' || process.env.TG_HTTP_ALLOW_NO_AUTH === 'true'

  const oauthAccessCode = process.env.TG_OAUTH_ACCESS_CODE?.trim() || undefined
  const publicUrlRaw = process.env.TG_PUBLIC_URL?.trim() || undefined
  let publicUrl: URL | undefined
  if (publicUrlRaw) {
    try {
      publicUrl = new URL(publicUrlRaw.replace(/\/+$/, '') + '/')
    } catch {
      throw new Error(`TG_PUBLIC_URL is not a valid URL: ${publicUrlRaw}`)
    }
    if (publicUrl.search || publicUrl.hash) {
      throw new Error('TG_PUBLIC_URL must not contain a query string or fragment')
    }
  }

  if (oauthAccessCode) {
    if (!publicUrl) {
      throw new Error(
        'TG_OAUTH_ACCESS_CODE is set but TG_PUBLIC_URL is not.\n' +
          'OAuth needs the externally visible URL of this server (e.g. https://tg.example.com) ' +
          'to advertise in its discovery metadata.',
      )
    }
    // The code is the only barrier in front of a real Telegram account on a
    // public URL, so refuse trivially guessable values.
    if (oauthAccessCode.length < 12) {
      throw new Error(
        'TG_OAUTH_ACCESS_CODE is too short (minimum 12 characters). ' +
          'Generate one with: openssl rand -base64 18',
      )
    }
  }

  if (!token && !oauthAccessCode && !allowNoAuth) {
    throw new Error(
      'No authentication configured.\n' +
        'The HTTP endpoint can send messages and spend money as the logged-in Telegram user.\n' +
        'Set one of:\n' +
        '  TG_OAUTH_ACCESS_CODE + TG_PUBLIC_URL   OAuth for clients like Claude\n' +
        '  TG_HTTP_TOKEN                          static bearer token (openssl rand -hex 32)\n' +
        'To run without auth anyway (only sane on an isolated loopback interface), ' +
        'set TG_HTTP_ALLOW_NO_AUTH=1.',
    )
  }

  const isLoopback = host === '127.0.0.1' || host === '::1' || host === 'localhost'
  if (!token && !oauthAccessCode && allowNoAuth && !isLoopback) {
    throw new Error(
      `Refusing to start: auth is disabled and the server would bind to ${host}, which is not ` +
        `loopback. That exposes full control of the Telegram account to the network. ` +
        `Set TG_HTTP_TOKEN, or bind to 127.0.0.1.`,
    )
  }

  const allowedHostsRaw = process.env.TG_HTTP_ALLOWED_HOSTS?.trim()
  const allowedHosts = allowedHostsRaw
    ? allowedHostsRaw.split(',').map(h => h.trim()).filter(Boolean)
    : isLoopback
      ? [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
      : publicUrl
        ? // Behind a reverse proxy the Host header is the public host.
          [publicUrl.host, `127.0.0.1:${port}`, `localhost:${port}`]
        : undefined

  return {
    host,
    port,
    path,
    token,
    // JSON replies are easier for simple HTTP clients than parsing an SSE
    // stream; streaming is still used for server-initiated messages on GET.
    jsonResponse: process.env.TG_HTTP_SSE === '1' ? false : true,
    dnsRebindingProtection: allowedHosts !== undefined,
    allowedHosts,
    maxBodyBytes: optionalInt('TG_HTTP_MAX_BODY_BYTES', 4 * 1024 * 1024),
    // MCP clients frequently disconnect without sending DELETE, so sessions
    // must expire on their own or they accumulate for the life of the process.
    // 30 minutes is comfortably longer than the longest tg_updates long-poll
    // (50s) plus normal think time.
    sessionIdleMs: optionalIntAllowZero('TG_HTTP_SESSION_IDLE_MS', 30 * 60 * 1000),
    sessionMaxLifetimeMs: optionalIntAllowZero('TG_HTTP_SESSION_MAX_MS', 12 * 60 * 60 * 1000),
    maxSessions: optionalIntAllowZero('TG_HTTP_MAX_SESSIONS', 100),
    sweepIntervalMs: optionalInt('TG_HTTP_SWEEP_INTERVAL_MS', 60 * 1000),
    publicUrl,
    oauthAccessCode,
    oauthAccessTokenTtlSeconds: optionalInt('TG_OAUTH_ACCESS_TOKEN_TTL', 60 * 60),
    oauthRefreshTokenTtlSeconds: optionalInt('TG_OAUTH_REFRESH_TOKEN_TTL', 30 * 24 * 60 * 60),
  }
}

/**
 * Resolved lazily so that tools which do not need credentials (e.g. tg_schema)
 * still work when the server is started without them configured.
 */
let cached: Config | undefined

export function getConfig(): Config {
  if (cached) return cached

  const dbDirRaw = process.env.TDLIB_DB_DIR ?? './tdlib-data'
  const dbDir = isAbsolute(dbDirRaw) ? dbDirRaw : resolve(process.cwd(), dbDirRaw)

  cached = {
    apiId: requireInt('TDLIB_API_ID'),
    apiHash: requireString('TDLIB_API_HASH'),
    databaseDirectory: dbDir,
    filesDirectory: resolve(dbDir, 'files'),
    updateBufferSize: optionalInt('TG_UPDATE_BUFFER_SIZE', 1000),
    useTestDc: process.env.TDLIB_USE_TEST_DC === '1' || process.env.TDLIB_USE_TEST_DC === 'true',
  }
  return cached
}
