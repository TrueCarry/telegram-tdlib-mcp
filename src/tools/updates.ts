import { z } from 'zod'

import { getSession } from '../tdlib.js'
import { jsonResult, errorResult, type ToolResult } from './common.js'

/**
 * MCP clients commonly enforce a 60s request timeout that progress
 * notifications do not reset, so a blocking poll must finish well inside it.
 */
const DEFAULT_WAIT_MS = 25_000
const MAX_WAIT_MS = 50_000

export const updatesInputSchema = {
  since_seq: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Cursor: return only updates newer than this sequence number. Pass the `next_seq` from ' +
        'your previous call. Omit or pass 0 on the first call to read everything buffered.',
    ),
  types: z
    .array(z.string())
    .optional()
    .describe(
      'Filter by update type name. A trailing "*" is a prefix wildcard. ' +
        'Example: ["updateNewMessage", "updateMessage*"].',
    ),
  chat_id: z.number().optional().describe('Only return updates relating to this chat.'),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .max(MAX_WAIT_MS)
    .optional()
    .describe(
      `Long-poll: if no matching update is buffered, wait up to this many ms for one to arrive ` +
        `(default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}). Pass 0 to return immediately.`,
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Maximum number of updates to return. Default 100.'),
}

const UpdatesArgs = z.object(updatesInputSchema)

export const updatesToolDescription =
  'Read Telegram updates (incoming messages, message edits, etc). Updates are buffered by the ' +
  'server the moment they arrive, so nothing is missed between calls. This is cursor-based: pass ' +
  'the `next_seq` from the previous response as `since_seq` to get only what is new. ' +
  'By default it long-polls, returning as soon as a matching update arrives. ' +
  'IMPORTANT: when a bot responds to a button press it usually EDITS its existing message rather ' +
  'than sending a new one, so watch updateMessageContent and updateMessageEdited, not just ' +
  'updateNewMessage.'

export async function handleUpdates(rawArgs: unknown): Promise<ToolResult> {
  const args = UpdatesArgs.parse(rawArgs)
  const session = getSession()

  try {
    // Ensure TDLib is running so updates actually flow.
    await session.start()

    const sinceSeq = args.since_seq ?? 0
    const waitMs = args.wait_ms ?? DEFAULT_WAIT_MS
    const limit = args.limit ?? 100

    const result = await session.updates.pollWithWait(
      sinceSeq,
      { types: args.types, chatId: args.chat_id },
      waitMs,
    )

    let updates = result.updates
    let truncated = false
    if (updates.length > limit) {
      updates = updates.slice(0, limit)
      truncated = true
    }

    const payload: Record<string, unknown> = {
      ok: true,
      count: updates.length,
      // When truncated, resume from the last delivered update rather than the
      // buffer head, so the remainder is not skipped.
      next_seq: truncated ? updates[updates.length - 1]!.seq : result.next_seq,
      latest_seq: result.latest_seq,
      updates: updates.map(u => ({ seq: u.seq, at: u.at, update: u.update })),
    }

    if (truncated) {
      payload.truncated = true
      payload.hint = 'More updates are buffered. Call again with the returned next_seq.'
    }

    if (result.dropped) {
      payload.dropped = true
      payload.oldest_seq = result.oldest_seq
      payload.total_dropped = result.total_dropped
      payload.warning =
        'Some updates were evicted from the buffer before being read. Poll more frequently or ' +
        'increase TG_UPDATE_BUFFER_SIZE.'
    }

    if (updates.length === 0) {
      payload.hint =
        'No matching updates. The cursor is still valid - call again with the returned next_seq.'
    }

    return jsonResult(payload)
  } catch (err) {
    return errorResult(err)
  }
}
