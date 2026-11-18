/**
 * Follows a bot deep link (t.me/<bot>?start=<param>) via sendBotStartMessage.
 * Usage: npx tsx scripts/bot-deeplink.ts <bot_username> <start_parameter>
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const username = (process.argv[2] ?? '').replace(/^@/, '')
const parameter = process.argv[3] ?? ''

function parse(res: any) {
  return JSON.parse(res.content[0].text)
}

async function main() {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/index.ts'],
    env: { ...process.env } as Record<string, string>,
    stderr: 'inherit',
  })
  const client = new Client({ name: 'deeplink', version: '1.0.0' })
  await client.connect(transport)

  const invoke = async (method: string, params: Record<string, unknown> = {}) =>
    parse(await client.callTool({ name: 'tg_invoke', arguments: { method, params } }))

  const chat = await invoke('searchPublicChat', { username })
  const chatId = chat.result.id
  const botUserId = chat.result.type.user_id
  await invoke('openChat', { chat_id: chatId })

  const cursor = parse(await client.callTool({ name: 'tg_updates', arguments: { wait_ms: 0 } }))
    .next_seq

  console.log(`> sendBotStartMessage parameter="${parameter}"`)
  const sent = await invoke('sendBotStartMessage', {
    bot_user_id: botUserId,
    chat_id: chatId,
    parameter,
  })
  if (!sent.ok) {
    console.error('failed:', JSON.stringify(sent.error))
    process.exit(1)
  }

  const reply = parse(
    await client.callTool({
      name: 'tg_wait_for',
      arguments: { chat_id: chatId, since_seq: cursor, timeout_ms: 20000 },
    }),
  )

  if (!reply.matched) {
    console.log('(no response within timeout)')
    await client.close()
    return
  }

  let text = reply.text
  let buttons = reply.buttons
  if (!buttons?.length || !text) {
    const listed = parse(
      await client.callTool({
        name: 'tg_click_button',
        arguments: { chat_id: chatId, message_id: reply.message_id, list_only: true },
      }),
    )
    if (listed.ok && listed.buttons?.length) buttons = listed.buttons
    if (!text) {
      const msg = await invoke('getMessage', { chat_id: chatId, message_id: reply.message_id })
      if (msg.ok) text = msg.result.content?.text?.text
    }
  }

  console.log(`\n=== ${reply.kind} (message_id ${reply.message_id}) ===`)
  console.log(text ?? '(no text)')
  if (buttons?.length) {
    console.log('\n--- buttons ---')
    for (const b of buttons) {
      const kind = b.type.replace('inlineKeyboardButtonType', '')
      console.log(`  [${b.row},${b.col}] "${b.text}"  (${kind})${b.url ? ' -> ' + b.url : ''}`)
    }
  }

  await client.close()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
