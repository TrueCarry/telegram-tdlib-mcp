import { TdlibRequestError } from '../tdlib.js'

/**
 * Shape of an MCP tool response. The index signature matches the SDK's
 * `CallToolResult`, which permits arbitrary extra fields.
 */
export interface ToolResult {
  [key: string]: unknown
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

/** Serializes a payload as pretty JSON in a single text content block. */
export function jsonResult(value: unknown, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    isError: isError || undefined,
  }
}

/**
 * Renders an error as a structured payload rather than throwing.
 *
 * TDLib's numeric codes are meaningful to a caller driving bot flows - notably
 * 502 (the bot did not answer a callback query in time) and 429 with a
 * "Too Many Requests: retry after N" message - so they must survive to the
 * agent instead of collapsing into an opaque stack trace.
 */
export function errorResult(err: unknown, context?: Record<string, unknown>): ToolResult {
  if (err instanceof TdlibRequestError) {
    const payload: Record<string, unknown> = {
      ok: false,
      error: { code: err.code, message: err.message },
      ...context,
    }

    const retryAfter = parseRetryAfter(err.message)
    if (retryAfter !== undefined) {
      payload.retry_after_seconds = retryAfter
      payload.hint = `Flood wait: retry this request after ${retryAfter} seconds.`
    } else if (err.code === 502) {
      payload.hint =
        'The bot did not answer the callback query before it timed out. The bot may be ' +
        'offline, slow, or may not handle this button. Consider retrying.'
    }

    return jsonResult(payload, true)
  }

  const message = err instanceof Error ? err.message : String(err)
  return jsonResult({ ok: false, error: { code: 0, message }, ...context }, true)
}

/** Extracts N from TDLib's "Too Many Requests: retry after N" message. */
export function parseRetryAfter(message: string): number | undefined {
  const m = /retry after (\d+)/i.exec(message)
  if (!m) return undefined
  const n = Number.parseInt(m[1]!, 10)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Normalizes a request object to tdl's `_` discriminator.
 *
 * tdl uses `_` where TDLib's JSON interface uses `@type`. Accepting both means
 * an agent can paste a payload straight out of the official TDLib docs. The
 * rename is applied recursively because nested objects (e.g. the
 * `input_message_content` of `sendMessage`) carry their own discriminator.
 *
 * Every other field is passed through untouched, preserving TDLib's snake_case
 * exactly as documented.
 */
export function normalizeDiscriminator(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeDiscriminator)
  if (value === null || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    // `@extra` is reserved by tdl for request correlation; drop it so a pasted
    // payload cannot interfere with response routing.
    if (key === '@extra') continue
    const nextKey = key === '@type' ? '_' : key
    out[nextKey] = normalizeDiscriminator(val)
  }
  return out
}
