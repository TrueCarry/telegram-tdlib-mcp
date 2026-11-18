/**
 * Sequence-numbered ring buffer for TDLib updates.
 *
 * Why this exists: `tdl`'s `client.on('update')` does not buffer. Any update
 * emitted while no listener is attached is silently dropped. MCP tools are
 * request/response, so without a buffer an agent would miss every update that
 * arrived between two tool calls.
 *
 * Each update is stamped with a monotonically increasing `seq`. Consumers poll
 * with a cursor (`since_seq`) and receive everything newer, plus a `next_seq`
 * to use on the following call. Nothing is lost between polls, and if the
 * buffer wraps past a consumer's cursor we report that explicitly rather than
 * letting the consumer silently observe a gap.
 */

export interface BufferedUpdate {
  seq: number
  /** Unix ms at which the update was received. */
  at: number
  update: Record<string, unknown>
}

export interface PollResult {
  updates: BufferedUpdate[]
  /** Cursor to pass as `since_seq` on the next poll. */
  next_seq: number
  /**
   * True when updates newer than the requested cursor were evicted from the
   * buffer before they could be read.
   */
  dropped: boolean
  /** Lowest seq still retained; useful to understand how much was lost. */
  oldest_seq: number
  /** Highest seq ever assigned. */
  latest_seq: number
  /** Total updates evicted since startup. */
  total_dropped: number
}

export interface UpdateFilter {
  /**
   * Update type names. Supports a trailing `*` wildcard, e.g. `updateMessage*`
   * matches updateMessageContent, updateMessageEdited, ...
   */
  types?: string[]
  /** Only updates that reference this chat. */
  chatId?: number
}

type Waiter = {
  matches: (u: BufferedUpdate) => boolean
  sinceSeq: number
  resolve: (updates: BufferedUpdate[]) => void
  timer: NodeJS.Timeout
}

/** Extracts a chat_id from an update, if it has one at a well-known location. */
export function extractChatId(update: Record<string, unknown>): number | undefined {
  const direct = update.chat_id
  if (typeof direct === 'number') return direct

  const message = update.message as Record<string, unknown> | undefined
  if (message && typeof message.chat_id === 'number') return message.chat_id

  const chat = update.chat as Record<string, unknown> | undefined
  if (chat && typeof chat.id === 'number') return chat.id

  return undefined
}

export function matchesType(typeName: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (p.endsWith('*')) {
      if (typeName.startsWith(p.slice(0, -1))) return true
    } else if (typeName === p) {
      return true
    }
  }
  return false
}

export function buildMatcher(filter: UpdateFilter): (u: BufferedUpdate) => boolean {
  const { types, chatId } = filter
  return (entry: BufferedUpdate) => {
    if (types && types.length > 0) {
      const name = typeof entry.update._ === 'string' ? entry.update._ : ''
      if (!matchesType(name, types)) return false
    }
    if (chatId !== undefined) {
      if (extractChatId(entry.update) !== chatId) return false
    }
    return true
  }
}

export class UpdateBuffer {
  private readonly capacity: number
  private buffer: BufferedUpdate[] = []
  private seqCounter = 0
  private totalDropped = 0
  private waiters = new Set<Waiter>()

  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity)
  }

  get latestSeq(): number {
    return this.seqCounter
  }

  get oldestSeq(): number {
    return this.buffer.length > 0 ? this.buffer[0]!.seq : this.seqCounter
  }

  get size(): number {
    return this.buffer.length
  }

  push(update: Record<string, unknown>): void {
    const entry: BufferedUpdate = {
      seq: ++this.seqCounter,
      at: Date.now(),
      update,
    }
    this.buffer.push(entry)
    while (this.buffer.length > this.capacity) {
      this.buffer.shift()
      this.totalDropped++
    }

    if (this.waiters.size === 0) return
    // Notify any long-poll waiting for a matching update.
    for (const waiter of [...this.waiters]) {
      if (entry.seq > waiter.sinceSeq && waiter.matches(entry)) {
        this.waiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.resolve([entry])
      }
    }
  }

  /** Returns buffered updates newer than `sinceSeq` that match the filter. */
  poll(sinceSeq: number, filter: UpdateFilter = {}): PollResult {
    const matches = buildMatcher(filter)
    const updates = this.buffer.filter(e => e.seq > sinceSeq && matches(e))

    // If the caller's cursor is older than everything we still hold, updates
    // they had not yet read were evicted.
    const dropped = this.buffer.length > 0 && sinceSeq < this.buffer[0]!.seq - 1

    return {
      updates,
      next_seq: this.seqCounter,
      dropped,
      oldest_seq: this.oldestSeq,
      latest_seq: this.seqCounter,
      total_dropped: this.totalDropped,
    }
  }

  /**
   * Poll, and if nothing matches, wait up to `waitMs` for the first matching
   * update to arrive. Resolves immediately when buffered matches already exist.
   */
  async pollWithWait(sinceSeq: number, filter: UpdateFilter, waitMs: number): Promise<PollResult> {
    const immediate = this.poll(sinceSeq, filter)
    if (immediate.updates.length > 0 || waitMs <= 0) return immediate

    const matches = buildMatcher(filter)
    const arrived = await new Promise<BufferedUpdate[]>(resolve => {
      const waiter: Waiter = {
        matches,
        sinceSeq,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter)
          resolve([])
        }, waitMs),
      }
      this.waiters.add(waiter)
    })

    if (arrived.length === 0) {
      // Timed out: report the current cursor so the consumer stays in sync.
      return { ...immediate, next_seq: this.seqCounter, latest_seq: this.seqCounter }
    }

    // Re-poll so that any updates that landed alongside the trigger are included.
    return this.poll(sinceSeq, filter)
  }

  /** Rejects all pending waiters, e.g. during shutdown. */
  clearWaiters(): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve([])
    }
    this.waiters.clear()
  }
}
