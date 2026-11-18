import { z } from 'zod'

import { getSession } from '../tdlib.js'
import { listButtons, findButton, summarizeButton, type ButtonRef } from '../messages.js'
import { jsonResult, errorResult, type ToolResult } from './common.js'

export const clickInputSchema = {
  chat_id: z.number().describe('Chat containing the message with the button.'),
  message_id: z.number().describe('Message that carries the keyboard.'),
  text: z
    .string()
    .optional()
    .describe(
      'Button label. Matched exactly first, then case-insensitively as a substring ' +
        '(convenient when labels contain emoji).',
    ),
  row: z.number().int().min(0).optional().describe('Zero-based row index, as an alternative to `text`.'),
  col: z.number().int().min(0).optional().describe('Zero-based column index. Defaults to 0.'),
  exact: z.boolean().optional().describe('Require an exact text match, disabling substring fallback.'),
  list_only: z
    .boolean()
    .optional()
    .describe('Do not click; just list the buttons on this message.'),
  password: z
    .string()
    .optional()
    .describe('For buttons of type inlineKeyboardButtonTypeCallbackWithPassword.'),
}

const ClickArgs = z.object(clickInputSchema)

export const clickToolDescription =
  'Press a button on a message from a bot. Handles the different button kinds correctly: ' +
  'inline callback buttons are sent as a callback query, while bottom reply-keyboard buttons are ' +
  'sent as a text message (which is how Telegram clients implement them). ' +
  'URL and Web App buttons are returned without being opened. ' +
  'After clicking, poll tg_updates for updateMessageContent/updateMessageEdited, because bots ' +
  'usually edit the original message rather than sending a new one.'

async function fetchMessage(chatId: number, messageId: number) {
  const session = getSession()
  return (await session.invoke({
    _: 'getMessage',
    chat_id: chatId,
    message_id: messageId,
  })) as Record<string, unknown>
}

/** Dispatches the click according to the button's TDLib type. */
async function pressButton(
  chatId: number,
  messageId: number,
  button: ButtonRef,
  password: string | undefined,
): Promise<Record<string, unknown>> {
  const session = getSession()

  switch (button.type) {
    case 'inlineKeyboardButtonTypeCallback': {
      // `data` arrives base64-encoded and is passed back base64-encoded; no
      // decoding round trip is needed or wanted.
      const answer = await session.invoke({
        _: 'getCallbackQueryAnswer',
        chat_id: chatId,
        message_id: messageId,
        payload: { _: 'callbackQueryPayloadData', data: button.data },
      })
      return { action: 'callback_query', answer }
    }

    case 'inlineKeyboardButtonTypeCallbackWithPassword': {
      if (!password) {
        throw new Error(
          'This button requires the account password. Pass `password` to tg_click_button.',
        )
      }
      const answer = await session.invoke({
        _: 'getCallbackQueryAnswer',
        chat_id: chatId,
        message_id: messageId,
        payload: {
          _: 'callbackQueryPayloadDataWithPassword',
          password,
          data: button.data,
        },
      })
      return { action: 'callback_query_with_password', answer }
    }

    case 'inlineKeyboardButtonTypeCallbackGame': {
      const answer = await session.invoke({
        _: 'getCallbackQueryAnswer',
        chat_id: chatId,
        message_id: messageId,
        payload: { _: 'callbackQueryPayloadGame', game_short_name: '' },
      })
      return { action: 'callback_query_game', answer }
    }

    case 'keyboardButtonTypeText': {
      // A reply-keyboard button is "pressed" by sending its text verbatim.
      const message = await session.invoke({
        _: 'sendMessage',
        chat_id: chatId,
        input_message_content: {
          _: 'inputMessageText',
          text: { _: 'formattedText', text: button.text, entities: [] },
        },
      })
      return { action: 'sent_text', sent_message: message }
    }

    case 'inlineKeyboardButtonTypeUrl':
      return {
        action: 'url_returned',
        url: button.url,
        note: 'URL buttons are not opened by this server. Use the URL as needed.',
      }

    case 'inlineKeyboardButtonTypeWebApp':
      return {
        action: 'web_app_returned',
        url: button.url,
        note:
          'Web App button. To launch it, call tg_invoke with openWebApp ' +
          '(chat_id, bot_user_id, url).',
      }

    case 'inlineKeyboardButtonTypeLoginUrl':
      return {
        action: 'login_url_returned',
        url: button.url,
        note:
          'Login URL button. Use tg_invoke with getLoginUrlInfo (chat_id, message_id, button_id) ' +
          'and then getLoginUrl to complete it.',
      }

    case 'inlineKeyboardButtonTypeCopyText':
      return {
        action: 'copy_text',
        text: button.raw.type && typeof button.raw.type === 'object'
          ? (button.raw.type as Record<string, unknown>).text
          : undefined,
        note: 'This button only copies text to the clipboard; there is no server-side action.',
      }

    case 'inlineKeyboardButtonTypeDisabled':
      // Added in TDLib 1.8.67. Bots use these as inert labels or placeholders,
      // so there is nothing to press; say so rather than implying a retry.
      return {
        action: 'disabled',
        note:
          'This button is disabled and cannot be pressed. Bots often use disabled buttons ' +
          'as labels, separators, or placeholders for an action that is not currently available.',
      }

    case 'inlineKeyboardButtonTypeSwitchInline':
      return {
        action: 'switch_inline',
        note:
          'Switch-inline button. Use tg_invoke with getInlineQueryResults, then ' +
          'sendInlineQueryResultMessage.',
        button: button.raw.type,
      }

    default: {
      // Reply-keyboard buttons that request a phone number, location, poll etc.
      if (button.keyboard === 'reply') {
        return {
          action: 'unsupported_reply_button',
          type: button.type,
          note:
            `Reply-keyboard buttons of type ${button.type} require sharing data (contact, ` +
            'location, etc). Use tg_invoke directly if you need this.',
        }
      }
      return {
        action: 'unsupported',
        type: button.type,
        note: `No automatic handling for ${button.type}. Use tg_invoke directly.`,
      }
    }
  }
}

export async function handleClick(rawArgs: unknown): Promise<ToolResult> {
  const args = ClickArgs.parse(rawArgs)
  const session = getSession()

  try {
    await session.start()

    const message = await fetchMessage(args.chat_id, args.message_id)
    const buttons = listButtons(message)

    if (args.list_only) {
      return jsonResult({
        ok: true,
        chat_id: args.chat_id,
        message_id: args.message_id,
        button_count: buttons.length,
        buttons: buttons.map(summarizeButton),
      })
    }

    const match = findButton(buttons, {
      text: args.text,
      row: args.row,
      col: args.col,
      exact: args.exact,
    })

    if (!match.ok) {
      return jsonResult(
        {
          ok: false,
          error: { code: 0, message: match.reason },
          available_buttons: match.available.map(summarizeButton),
        },
        true,
      )
    }

    const seqBefore = session.updates.latestSeq
    const result = await pressButton(args.chat_id, args.message_id, match.button, args.password)

    return jsonResult({
      ok: true,
      clicked: summarizeButton(match.button),
      ...result,
      updates_cursor: seqBefore,
      hint:
        'Poll tg_updates with since_seq=updates_cursor (and types ' +
        '["updateMessageContent","updateMessageEdited","updateNewMessage"]) to observe the ' +
        "bot's response. Bots commonly edit the original message.",
    })
  } catch (err) {
    return errorResult(err, { chat_id: args.chat_id, message_id: args.message_id })
  }
}
