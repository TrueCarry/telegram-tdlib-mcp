/**
 * Live demo: opens a bot, sends /start, and reports its reply.
 *
 * Exercises the real bot-testing path end to end through the MCP tools:
 * searchPublicChat -> openChat -> sendBotStartMessage -> tg_wait_for.
 *
 * Usage: npx tsx scripts/demo-bot.ts <bot_username>
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const username = (process.argv[2] ?? '').replace(/^@/, '')
if (!username) {
  console.error('Usage: npx tsx scripts/demo-bot.ts <bot_username>')
  process.exit(1)
}

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
  const client = new Client({ name: 'demo-bot', version: '1.0.0' })
  await client.connect(transport)

  const invoke = async (method: string, params: Record<string, unknown> = {}) =>
    parse(await client.callTool({ name: 'tg_invoke', arguments: { method, params } }))

  console.log(`\n1. Resolving @${username}`)
  const chat = await invoke('searchPublicChat', { username })
  if (!chat.ok) {
    console.error('   failed:', JSON.stringify(chat.error))
    await client.close()
    process.exit(1)
  }
  const chatId = chat.result.id
  const botUserId = chat.result.type?.user_id
  console.log(`   title:       ${chat.result.title}`)
  console.log(`   chat_id:     ${chatId}`)
  console.log(`   bot_user_id: ${botUserId}`)
  console.log(`   chat type:   ${chat.result.type?._}`)

  // Confirm it really is a bot before sending a start message.
  const user = await invoke('getUser', { user_id: botUserId })
  if (user.ok) {
    console.log(`   is bot:      ${user.result.type?._ === 'userTypeBot'}`)
  }

  console.log('\n2. Opening the chat (keeps TDLib history current)')
  const opened = await invoke('openChat', { chat_id: chatId })
  console.log(`   ok: ${opened.ok}`)

  // Record the update cursor before sending, so we only match new activity.
  const before = parse(
    await client.callTool({ name: 'tg_updates', arguments: { wait_ms: 0 } }),
  )
  const cursor = before.next_seq
  console.log(`   update cursor: ${cursor}`)

  console.log('\n3. Sending /start')
  const started = await invoke('sendBotStartMessage', {
    bot_user_id: botUserId,
    chat_id: chatId,
    parameter: '',
  })
  if (!started.ok) {
    console.error('   failed:', JSON.stringify(started.error))
    await client.close()
    process.exit(1)
  }
  console.log(`   sent, temporary message_id: ${started.result.id}`)

  console.log("\n4. Waiting for the bot's reply")
  const reply = parse(
    await client.callTool({
      name: 'tg_wait_for',
      arguments: { chat_id: chatId, since_seq: cursor, timeout_ms: 20000 },
    }),
  )

  if (!reply.matched) {
    console.log('   no reply within the timeout')
    console.log('   hint:', reply.hint)
  } else {
    console.log(`   matched via: ${reply.kind}`)
    console.log(`   message_id:  ${reply.message_id}`)
    console.log('\n--- bot reply ---')
    console.log(reply.text ?? '(no text)')
    console.log('-----------------')
    if (reply.buttons?.length) {
      console.log('\nButtons:')
      for (const b of reply.buttons) {
        console.log(`   [${b.row},${b.col}] "${b.text}"  (${b.keyboard}, ${b.type})`)
      }
    } else {
      console.log('\nNo buttons on this message.')
    }
  }

  await client.close()
}

main().catch(err => {
  console.error('demo failed:', err)
  process.exit(1)
})
