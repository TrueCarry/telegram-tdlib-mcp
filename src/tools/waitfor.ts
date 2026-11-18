import { z } from 'zod'

import { getSession } from '../tdlib.js'
import { messageText, listButtons, summarizeButton } from '../messages.js'
import { jsonResult, errorResult, type ToolResult } from './common.js'
import type { BufferedUpdate } from '../updates.js'

const DEFAULT_TIMEOUT_MS = 25_000
const MAX_TIMEOUT_MS = 50_000

export const waitForInputSchema = {
  chat_id: z.number().describe('Chat to watch, typically the private chat with the bot.'),
  since_seq: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Only consider updates newer than this cursor. Pass the `updates_cursor` returned by ' +
        'tg_click_button, or a `next_seq` from tg_updates, so you do not match a stale message.',
    ),
  contains: z
    .string()
    .optional()
    .describe('Wait until the message text contains this substring (case-insensitive).'),
  from_bot_only: z
    .boolean()
    .optional()
    .describe('Ignore your own outgoing messages. Defaults to true.'),
  include_edits: z
    .boolean()
    .optional()
    .describe(
      'Treat edits of existing messages as a response. Defaults to true, because bots usually ' +
        'edit their message after a button press.',
    ),
  timeout_ms: z
    .number()
    .int()
    .min(0)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`How long to wait (default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}).`),
  resolve_message_id: z
    .number()
    .optional()
    .describe(
      'A temporary message id returned by sendMessage. Waits for the server to confirm the send ' +
        'and returns the permanent id, which differs from the temporary one.',
    ),
}

const WaitForArgs = z.object(waitForInputSchema)

export const waitForToolDescription =
  "Wait for a bot's response in a chat. Watches for new messages AND for edits to existing " +
  'messages (updateMessageContent / updateMessageEdited), because after an inline button press a ' +
  'bot typically edits its original message instead of sending a new one - waiting only for new ' +
  'messages would hang. Returns the matching message with its text and buttons already extracted.'

/** Update types that can carry a bot response. */
const NEW_MESSAGE = 'updateNewMessage'
const EDIT_TYPES = new Set(['updateMessageContent', 'updateMessageEdited'])

interface Candidate {
  seq: number
  kind: 'new_message' | 'edited'
  message_id: number
  text?: string
  buttons: ReturnType<typeof summarizeButton>[]
  update: Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Decides whether an update represents a bot response we are waiting for.
 *
 * `updateMessageContent` carries only the new content, not a full message, so
 * the caller may need to re-read the message to get its current markup.
 */
function toCandidate(
  entry: BufferedUpdate,
  opts: { chatId: number; fromBotOnly: boolean; includeEdits: boolean; contains?: string },
): Candidate | undefined {
  const u = entry.update
  const type = typeof u._ === 'string' ? u._ : ''

  if (type === NEW_MESSAGE) {
    const message = asRecord(u.message)
    if (!message) return undefined
    if (message.chat_id !== opts.chatId) return undefined
    if (opts.fromBotOnly && message.is_outgoing === true) return undefined

    const text = messageText(message)
    if (opts.contains && !(text ?? '').toLowerCase().includes(opts.contains.toLowerCase())) {
      return undefined
    }

    return {
      seq: entry.seq,
      kind: 'new_message',
      message_id: typeof message.id === 'number' ? message.id : 0,
      text,
      buttons: listButtons(message).map(summarizeButton),
      update: u,
    }
  }

  if (opts.includeEdits && EDIT_TYPES.has(type)) {
    if (u.chat_id !== opts.chatId) return undefined

    // updateMessageContent gives us new_content; updateMessageEdited gives
    // reply_markup. Normalize both into a message-like shape for text/buttons.
    const newContent = asRecord(u.new_content)
    const pseudoMessage: Record<string, unknown> = {
      content: newContent,
      reply_markup: u.reply_markup,
    }

    const text = newContent ? messageText(pseudoMessage) : undefined
    if (opts.contains) {
      if (!text || !text.toLowerCase().includes(opts.contains.toLowerCase())) return undefined
    }

    return {
      seq: entry.seq,
      kind: 'edited',
      message_id: typeof u.message_id === 'number' ? u.message_id : 0,
      text,
      buttons: listButtons(pseudoMessage).map(summarizeButton),
      update: u,
    }
  }

  return undefined
}

/**
 * Waits for `updateMessageSendSucceeded` (or `...Failed`) for a message sent
 * with a temporary id, and reports the permanent id assigned by the server.
 */
async function waitForSendConfirmation(
  temporaryId: number,
  chatId: number,
  startSeq: number,
  deadline: number,
): Promise<ToolResult> {
  const session = getSession()

  // It may already have been confirmed before this call.
  const known = session.resolveMessageId(temporaryId)
  if (known !== undefined) {
    return jsonResult({
      ok: true,
      matched: true,
      kind: 'send_succeeded',
      temporary_message_id: temporaryId,
      message_id: known,
      note: 'Already confirmed. Use `message_id` for subsequent calls.',
    })
  }

  let cursor = startSeq
  for (;;) {
    const remaining = deadline - Date.now()
    const result = await session.updates.pollWithWait(
      cursor,
      { types: ['updateMessageSendSucceeded', 'updateMessageSendFailed'], chatId },
      Math.max(0, remaining),
    )

    for (const entry of result.updates) {
      const u = entry.update
      if (u.old_message_id !== temporaryId) continue

      const message = asRecord(u.message)
      if (u._ === 'updateMessageSendFailed') {
        return jsonResult({
          ok: false,
          matched: true,
          kind: 'send_failed',
          temporary_message_id: temporaryId,
          error: u.error,
          next_seq: result.next_seq,
        })
      }
      return jsonResult({
        ok: true,
        matched: true,
        kind: 'send_succeeded',
        temporary_message_id: temporaryId,
        message_id: message?.id,
        next_seq: result.next_seq,
        note: 'The temporary id is now invalid; use `message_id`.',
      })
    }

    cursor = result.next_seq

    if (Date.now() >= deadline) {
      return jsonResult({
        ok: true,
        matched: false,
        temporary_message_id: temporaryId,
        next_seq: result.next_seq,
        hint: 'No send confirmation observed yet. Call again with since_seq=next_seq.',
      })
    }
  }
}

export async function handleWaitFor(rawArgs: unknown): Promise<ToolResult> {
  const args = WaitForArgs.parse(rawArgs)
  const session = getSession()

  const fromBotOnly = args.from_bot_only ?? true
  const includeEdits = args.include_edits ?? true
  const timeoutMs = args.timeout_ms ?? DEFAULT_TIMEOUT_MS

  try {
    await session.start()

    const startSeq = args.since_seq ?? session.updates.latestSeq
    const deadline = Date.now() + timeoutMs

    // Resolving a sendMessage temporary id is a distinct, simpler wait.
    if (args.resolve_message_id !== undefined) {
      return await waitForSendConfirmation(args.resolve_message_id, args.chat_id, startSeq, deadline)
    }

    const types = includeEdits
      ? [NEW_MESSAGE, 'updateMessageContent', 'updateMessageEdited']
      : [NEW_MESSAGE]

    let cursor = startSeq

    // Loop because an update may match the coarse type/chat filter but fail the
    // finer predicate (e.g. `contains`), in which case we keep waiting.
    for (;;) {
      const remaining = deadline - Date.now()
      const result = await session.updates.pollWithWait(
        cursor,
        { types, chatId: args.chat_id },
        Math.max(0, remaining),
      )

      for (const entry of result.updates) {
        const candidate = toCandidate(entry, {
          chatId: args.chat_id,
          fromBotOnly,
          includeEdits,
          contains: args.contains,
        })
        if (candidate) {
          return jsonResult({
            ok: true,
            matched: true,
            kind: candidate.kind,
            chat_id: args.chat_id,
            message_id: candidate.message_id,
            text: candidate.text,
            buttons: candidate.buttons,
            seq: candidate.seq,
            next_seq: result.next_seq,
            raw_update: candidate.update,
            ...(candidate.kind === 'edited' && candidate.buttons.length === 0
              ? {
                  note:
                    'This was a content edit; call tg_invoke getMessage to read the full message ' +
                    'including its current reply_markup.',
                }
              : {}),
          })
        }
      }

      cursor = result.next_seq

      if (Date.now() >= deadline) {
        return jsonResult({
          ok: true,
          matched: false,
          chat_id: args.chat_id,
          next_seq: result.next_seq,
          waited_ms: timeoutMs,
          hint:
            'No matching response arrived. The bot may be slow or may not have responded. ' +
            'Call again with since_seq=next_seq to keep waiting.',
        })
      }
    }
  } catch (err) {
    return errorResult(err, { chat_id: args.chat_id })
  }
}
