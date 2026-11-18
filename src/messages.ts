/**
 * Helpers for reading the parts of TDLib message objects that matter when
 * driving a bot: their text and their keyboard buttons.
 */

export interface ButtonRef {
  row: number
  col: number
  text: string
  /** `inline` (attached to the message) or `reply` (the bottom keyboard). */
  keyboard: 'inline' | 'reply'
  /** The TDLib button type name, e.g. `inlineKeyboardButtonTypeCallback`. */
  type: string
  /** Base64 callback payload, for callback buttons. */
  data?: string
  url?: string
  raw: Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Extracts the plain text of a message, when it has any. */
export function messageText(message: Record<string, unknown>): string | undefined {
  const content = asRecord(message.content)
  if (!content) return undefined

  // messageText.text, and the `caption` carried by media messages.
  const text = asRecord(content.text) ?? asRecord(content.caption)
  if (text && typeof text.text === 'string') return text.text
  return undefined
}

/**
 * Flattens a message's reply markup into an addressable list of buttons.
 *
 * Both keyboard kinds are returned so that a caller can refer to a button by
 * its visible label without needing to know which kind it is.
 */
export function listButtons(message: Record<string, unknown>): ButtonRef[] {
  const markup = asRecord(message.reply_markup)
  if (!markup) return []

  const kind = markup._
  const keyboard: 'inline' | 'reply' =
    kind === 'replyMarkupInlineKeyboard' ? 'inline' : 'reply'

  if (kind !== 'replyMarkupInlineKeyboard' && kind !== 'replyMarkupShowKeyboard') {
    // replyMarkupRemoveKeyboard / replyMarkupForceReply carry no buttons.
    return []
  }

  const rows = markup.rows
  if (!Array.isArray(rows)) return []

  const out: ButtonRef[] = []
  rows.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) return
    row.forEach((button, colIndex) => {
      const b = asRecord(button)
      if (!b) return
      const type = asRecord(b.type)
      const ref: ButtonRef = {
        row: rowIndex,
        col: colIndex,
        text: typeof b.text === 'string' ? b.text : '',
        keyboard,
        type: typeof type?._ === 'string' ? type._ : 'unknown',
        raw: b,
      }
      if (type) {
        if (typeof type.data === 'string') ref.data = type.data
        if (typeof type.url === 'string') ref.url = type.url
      }
      out.push(ref)
    })
  })
  return out
}

export interface ButtonQuery {
  text?: string
  row?: number
  col?: number
  exact?: boolean
}

export type ButtonMatch =
  | { ok: true; button: ButtonRef }
  | { ok: false; reason: string; available: ButtonRef[] }

/** Finds a single button by label or coordinates. */
export function findButton(buttons: ButtonRef[], query: ButtonQuery): ButtonMatch {
  if (buttons.length === 0) {
    return { ok: false, reason: 'This message has no buttons.', available: [] }
  }

  if (query.row !== undefined) {
    const col = query.col ?? 0
    const found = buttons.find(b => b.row === query.row && b.col === col)
    if (!found) {
      return {
        ok: false,
        reason: `No button at row ${query.row}, col ${col}.`,
        available: buttons,
      }
    }
    return { ok: true, button: found }
  }

  if (query.text === undefined) {
    return {
      ok: false,
      reason: 'Provide either `text` or `row`/`col` to identify the button.',
      available: buttons,
    }
  }

  const needle = query.text.trim()
  const exactMatches = buttons.filter(b => b.text === needle)
  if (exactMatches.length === 1) return { ok: true, button: exactMatches[0]! }
  if (exactMatches.length > 1) {
    return {
      ok: false,
      reason: `Ambiguous: ${exactMatches.length} buttons have the exact text "${needle}". Use row/col.`,
      available: exactMatches,
    }
  }

  if (query.exact) {
    return { ok: false, reason: `No button with exact text "${needle}".`, available: buttons }
  }

  // Fall back to case-insensitive substring, which tolerates emoji/spacing
  // differences in bot button labels.
  const lower = needle.toLowerCase()
  const loose = buttons.filter(b => b.text.toLowerCase().includes(lower))
  if (loose.length === 1) return { ok: true, button: loose[0]! }
  if (loose.length > 1) {
    return {
      ok: false,
      reason: `Ambiguous: "${needle}" matches ${loose.length} buttons. Use exact text or row/col.`,
      available: loose,
    }
  }

  return { ok: false, reason: `No button matching "${needle}".`, available: buttons }
}

/** Strips the bulky `raw` field for compact tool output. */
export function summarizeButton(b: ButtonRef) {
  return {
    row: b.row,
    col: b.col,
    text: b.text,
    keyboard: b.keyboard,
    type: b.type,
    ...(b.url ? { url: b.url } : {}),
  }
}
