import * as tdl from 'tdl'
import { getTdjson, getTdlibInfo } from 'prebuilt-tdlib'
import { mkdirSync } from 'node:fs'

import { getConfig, getUpdateBufferSize } from './config.js'
import { UpdateBuffer } from './updates.js'
import { getCatalog } from './catalog.js'

/** True if a TDLib error is the "another instance owns this database" case. */
export function isDatabaseLockError(err: unknown): boolean {
  const message =
    typeof err === 'string'
      ? err
      : ((err as { message?: unknown } | null)?.message ?? '')
  return typeof message === 'string' && /can't lock file|already in use/i.test(message)
}

/**
 * TDLib is loaded from `prebuilt-tdlib`, so no compilation step is required.
 * `configure` must be called before `createClient`.
 */
let configured = false
function configureOnce(): void {
  if (configured) return
  tdl.configure({ tdjson: getTdjson() })
  configured = true
}

export interface TdError {
  code: number
  message: string
}

export class TdlibRequestError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.name = 'TdlibRequestError'
    this.code = code
  }
}

export interface VersionCheck {
  binaryVersion: string
  catalogVersion: string
  matches: boolean
}

/**
 * Owns the single TDLib client, its update buffer, and lifecycle.
 *
 * A closed TDLib client cannot be reused, so `close()` is terminal for this
 * instance.
 */
export class TelegramSession {
  private client: tdl.Client | undefined
  private startPromise: Promise<tdl.Client> | undefined
  readonly updates: UpdateBuffer
  private lastAuthorizationState: Record<string, unknown> | undefined
  private closed = false
  /** Set when TDLib reports the database is held by another process. */
  private databaseLocked = false
  /** Temporary sendMessage id -> permanent id, from updateMessageSendSucceeded. */
  private sentMessageIds = new Map<number, number>()

  constructor() {
    // Deliberately does not read credentials: the server must be able to start
    // and serve tg_schema before it has been configured to log in.
    this.updates = new UpdateBuffer(getUpdateBufferSize())
  }

  /** True once the TDLib client has been created. */
  get isStarted(): boolean {
    return this.client !== undefined
  }

  get authorizationState(): Record<string, unknown> | undefined {
    return this.lastAuthorizationState
  }

  private rememberSentMessageId(oldId: number, newId: number): void {
    this.sentMessageIds.set(oldId, newId)
    // Bound the map; these are only useful shortly after sending.
    if (this.sentMessageIds.size > 500) {
      const oldest = this.sentMessageIds.keys().next()
      if (!oldest.done) this.sentMessageIds.delete(oldest.value)
    }
  }

  /**
   * Resolves the temporary id returned by sendMessage to the permanent id
   * assigned by the server, if the confirmation has arrived.
   */
  resolveMessageId(messageId: number): number | undefined {
    return this.sentMessageIds.get(messageId)
  }

  /**
   * Creates the TDLib client and attaches the update listener.
   *
   * The listener is attached synchronously immediately after `createClient` -
   * never after an `await` - because tdl does not buffer updates and would
   * otherwise drop everything emitted before the listener exists.
   */
  async start(): Promise<tdl.Client> {
    if (this.closed) {
      throw new Error('This TDLib client has been closed and cannot be reused. Restart the server.')
    }
    if (this.client) return this.client
    if (this.startPromise) return this.startPromise

    this.startPromise = (async () => {
      configureOnce()
      const config = getConfig()

      // TDLib creates these itself, but failing early with a clear error beats
      // an opaque TDLib failure if the path is not writable.
      mkdirSync(config.databaseDirectory, { recursive: true })
      mkdirSync(config.filesDirectory, { recursive: true })

      const client = tdl.createClient({
        apiId: config.apiId,
        apiHash: config.apiHash,
        databaseDirectory: config.databaseDirectory,
        filesDirectory: config.filesDirectory,
        useTestDc: config.useTestDc,
        tdlibParameters: {
          application_version: '0.1.0',
          device_model: 'telegram-tdlib-mcp',
          system_language_code: 'en',
        },
      })

      // Attach synchronously - see doc comment above.
      client.on('update', (update: unknown) => {
        const u = update as Record<string, unknown>
        if (u._ === 'updateAuthorizationState') {
          this.lastAuthorizationState = u.authorization_state as Record<string, unknown>
        }
        // sendMessage returns a message with a temporary id that is replaced
        // once the server confirms the send. Record the mapping so callers can
        // resolve the id they were given to the permanent one.
        if (u._ === 'updateMessageSendSucceeded') {
          const message = u.message as Record<string, unknown> | undefined
          const oldId = u.old_message_id
          const newId = message?.id
          if (typeof oldId === 'number' && typeof newId === 'number') {
            this.rememberSentMessageId(oldId, newId)
          }
        }
        this.updates.push(u)
      })

      client.on('error', (err: unknown) => {
        // Never let a TDLib error become an unhandled rejection and kill the
        // server; surface it on stderr (stdout is the MCP transport).
        if (isDatabaseLockError(err)) {
          // The database is owned by another process. Every request will fail,
          // so record it and make the reason explicit rather than letting the
          // server look healthy while nothing works.
          this.databaseLocked = true
          this.updates.clearWaiters()
          console.error(
            `[tdlib] FATAL: another process is using ${config.databaseDirectory}. ` +
              `Only one instance may use a TDLib database at a time. ` +
              `Stop the other instance, or point this one at a different ` +
              `TDLIB_DB_DIR (note: a fresh directory requires a new login).`,
          )
          return
        }
        console.error('[tdlib] error:', err)
      })

      this.client = client
      return client
    })()

    try {
      return await this.startPromise
    } catch (err) {
      this.startPromise = undefined
      throw err
    }
  }

  /**
   * Sends a request to TDLib verbatim.
   *
   * `request` must already use tdl's `_` discriminator; normalization from
   * TDLib's native `@type` happens at the tool boundary.
   */
  async invoke(request: Record<string, unknown>): Promise<unknown> {
    const client = await this.start()
    this.assertUsable()
    try {
      return await client.invoke(request as never)
    } catch (err) {
      throw toRequestError(err)
    }
  }

  /**
   * Rejects requests once the database is known to be locked.
   *
   * Without this a caller waits for a TDLib response that can never arrive,
   * and eventually sees a timeout that says nothing about the real cause.
   */
  private assertUsable(): void {
    if (!this.databaseLocked) return
    const dir = getConfig().databaseDirectory
    throw new TdlibRequestError(
      409,
      `TDLib database at ${dir} is locked by another process. Only one instance may use a ` +
        `database at a time. Stop the other server, or start this one with a different ` +
        `TDLIB_DB_DIR (a fresh directory starts unauthorized and needs its own login).`,
    )
  }

  /**
   * Calls a TDLib method synchronously. Only valid for the handful of methods
   * TDLib marks as synchronous (e.g. getTextEntities, parseTextEntities).
   */
  execute(request: Record<string, unknown>): unknown {
    configureOnce()
    return tdl.execute(request as never)
  }

  /**
   * Compares the running TDLib binary against the version the catalog was
   * generated from. Signatures drift between releases, so a mismatch means the
   * catalog may describe parameters the binary does not accept.
   */
  async checkVersion(): Promise<VersionCheck> {
    const catalog = getCatalog()
    const info = getTdlibInfo()
    let binaryVersion = info.version

    // Starting the client requires credentials; let that error propagate so the
    // caller can report it distinctly from a failed version read.
    await this.start()

    try {
      const opt = (await this.invoke({ _: 'getOption', name: 'version' })) as {
        value?: string
      }
      if (opt && typeof opt.value === 'string') binaryVersion = opt.value
    } catch {
      // Fall back to the version reported by prebuilt-tdlib.
    }
    return {
      binaryVersion,
      catalogVersion: catalog.tdlibVersion,
      matches: binaryVersion === catalog.tdlibVersion,
    }
  }

  async close(): Promise<void> {
    this.updates.clearWaiters()
    if (!this.client) {
      this.closed = true
      return
    }
    try {
      await this.client.close()
    } catch (err) {
      console.error('[tdlib] error during close:', err)
    } finally {
      this.closed = true
      this.client = undefined
    }
  }
}

/**
 * Converts a thrown tdl error into a structured error carrying TDLib's own
 * numeric code, so tools can report it rather than losing it in a stack trace.
 */
export function toRequestError(err: unknown): TdlibRequestError {
  if (err instanceof tdl.TDLibError) {
    return new TdlibRequestError(err.code ?? 0, err.message)
  }
  if (err instanceof Error) {
    return new TdlibRequestError(0, err.message)
  }
  return new TdlibRequestError(0, String(err))
}

let session: TelegramSession | undefined

export function getSession(): TelegramSession {
  if (!session) session = new TelegramSession()
  return session
}
