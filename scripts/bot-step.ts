/**
 * Interactive single-step driver for a bot conversation.
 *
 * Sends a message OR clicks a button, then reports the resulting message and
 * its buttons. Each invocation is one step, so the caller can inspect the
 * result before deciding what to do next.
 *
 * Usage:
 *   npx tsx scripts/bot-step.ts <bot_username> send "<text>"
 *   npx tsx scripts/bot-step.ts <bot_username> click "<button text>" [message_id]
 *   npx tsx scripts/bot-step.ts <bot_username> click-rc <row> <col> [message_id]
 *   npx tsx scripts/bot-step.ts <bot_username> show [message_id]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const [usernameArg, action, ...rest] = process.argv.slice(2)
const username = (usernameArg ?? '').replace(/^@/, '')

if (!username || !action) {
  console.error('Usage: bot-step.ts <bot_username> <send|click|click-rc|show> ...')
  process.exit(1)
}

function parse(res: any) {
  return JSON.parse(res.content[0].text)
}

function render(label: string, text: string | undefined, buttons: any[] | undefined) {
  console.log(`\n=== ${label} ===`)
  console.log(text ?? '(no text)')
  if (buttons?.length) {
    console.log('\n--- buttons ---')
    for (const b of buttons) {
      const kind = b.type.replace('inlineKeyboardButtonType', '')
      console.log(`  [${b.row},${b.col}] "${b.text}"  (${kind})${b.url ? ' -> ' + b.url : ''}`)
    }
  } else {
    console.log('\n(no buttons)')
  }
}

async function main() {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/index.ts'],
    env: { ...process.env } as Record<string, string>,
    stderr: 'inherit',
  })
  const client = new Client({ name: 'bot-step', version: '1.0.0' })
  await client.connect(transport)

  const invoke = async (method: string, params: Record<string, unknown> = {}) =>
    parse(await client.callTool({ name: 'tg_invoke', arguments: { method, params } }))

  const chat = await invoke('searchPublicChat', { username })
  if (!chat.ok) {
    console.error('resolve failed:', JSON.stringify(chat.error))
    process.exit(1)
  }
  const chatId = chat.result.id
  await invoke('openChat', { chat_id: chatId })

  const cursor = parse(await client.callTool({ name: 'tg_updates', arguments: { wait_ms: 0 } }))
    .next_seq

  if (action === 'show') {
    const messageId = Number(rest[0])
    const msg = await invoke('getMessage', { chat_id: chatId, message_id: messageId })
    if (!msg.ok) {
      console.error('getMessage failed:', JSON.stringify(msg.error))
      process.exit(1)
    }
    const listed = parse(
      await client.callTool({
        name: 'tg_click_button',
        arguments: { chat_id: chatId, message_id: messageId, list_only: true },
      }),
    )
    const text = msg.result.content?.text?.text ?? msg.result.content?.caption?.text
    render(`message ${messageId}`, text, listed.buttons)
    await client.close()
    return
  }

  if (action === 'send') {
    const text = rest.join(' ')
    console.log(`> sending: ${text}`)
    const sent = await invoke('sendMessage', {
      chat_id: chatId,
      input_message_content: {
        '@type': 'inputMessageText',
        text: { '@type': 'formattedText', text },
      },
    })
    if (!sent.ok) {
      console.error('send failed:', JSON.stringify(sent.error))
      process.exit(1)
    }
  } else if (action === 'click' || action === 'click-rc') {
    const args: Record<string, unknown> = { chat_id: chatId }
    let messageId: number

    if (action === 'click') {
      messageId = Number(rest[1] ?? 0)
      args.text = rest[0]
    } else {
      messageId = Number(rest[2] ?? 0)
      args.row = Number(rest[0])
      args.col = Number(rest[1])
    }

    if (!messageId) {
      // Default to the most recent message in the chat.
      const history = await invoke('getChatHistory', {
        chat_id: chatId,
        from_message_id: 0,
        offset: 0,
        limit: 1,
        only_local: false,
      })
      messageId = history.result?.messages?.[0]?.id
      if (!messageId) {
        console.error('could not determine the latest message id; pass it explicitly')
        process.exit(1)
      }
    }
    args.message_id = messageId

    console.log(`> clicking on message ${messageId}:`, JSON.stringify(args))
    const clicked = parse(await client.callTool({ name: 'tg_click_button', arguments: args }))
    if (!clicked.ok) {
      console.error('click failed:', JSON.stringify(clicked.error ?? clicked))
      if (clicked.available_buttons) {
        console.error('available:')
        for (const b of clicked.available_buttons) {
          console.error(`  [${b.row},${b.col}] "${b.text}"`)
        }
      }
      process.exit(1)
    }
    console.log('  action:', clicked.action)
    if (clicked.answer?.text) console.log('  toast:', clicked.answer.text)
    if (clicked.url) console.log('  url:', clicked.url)
  } else {
    console.error(`unknown action: ${action}`)
    process.exit(1)
  }

  // Report whatever the bot did in response.
  const reply = parse(
    await client.callTool({
      name: 'tg_wait_for',
      arguments: { chat_id: chatId, since_seq: cursor, timeout_ms: 20000 },
    }),
  )

  if (!reply.matched) {
    console.log('\n(no response within timeout)')
  } else {
    let text = reply.text
    let buttons = reply.buttons

    // A content edit does not carry the markup; re-read the message for it.
    if (reply.kind === 'edited' || !buttons?.length) {
      const listed = parse(
        await client.callTool({
          name: 'tg_click_button',
          arguments: { chat_id: chatId, message_id: reply.message_id, list_only: true },
        }),
      )
      if (listed.ok && listed.buttons?.length) buttons = listed.buttons
      if (!text) {
        const msg = await invoke('getMessage', {
          chat_id: chatId,
          message_id: reply.message_id,
        })
        if (msg.ok) text = msg.result.content?.text?.text ?? msg.result.content?.caption?.text
      }
    }

    render(`${reply.kind} (message_id ${reply.message_id})`, text, buttons)
  }

  await client.close()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
