/**
 * Searches for chats/bots matching a term, to find the right username.
 * Usage: npx tsx scripts/find-bot.ts <term>
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const term = process.argv[2] ?? ''
if (!term) {
  console.error('Usage: npx tsx scripts/find-bot.ts <term>')
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
  const client = new Client({ name: 'find-bot', version: '1.0.0' })
  await client.connect(transport)

  const invoke = async (method: string, params: Record<string, unknown> = {}) =>
    parse(await client.callTool({ name: 'tg_invoke', arguments: { method, params } }))

  const describe = async (chatId: number, source: string) => {
    const chat = await invoke('getChat', { chat_id: chatId })
    if (!chat.ok) return
    const type = chat.result.type
    let kind = type?._ ?? '?'
    let username = ''
    let isBot = false

    if (type?._ === 'chatTypePrivate') {
      const user = await invoke('getUser', { user_id: type.user_id })
      if (user.ok) {
        isBot = user.result.type?._ === 'userTypeBot'
        username = user.result.usernames?.editable_username ?? ''
        kind = isBot ? 'BOT' : 'user'
      }
    }
    console.log(
      `  [${source}] ${isBot ? '🤖 ' : ''}${chat.result.title}` +
        `${username ? ` (@${username})` : ''}  — ${kind}, chat_id ${chatId}`,
    )
  }

  console.log(`\nSearching your chats for "${term}"...`)
  const mine = await invoke('searchChats', { query: term, limit: 20 })
  if (mine.ok && mine.result.chat_ids?.length) {
    for (const id of mine.result.chat_ids) await describe(id, 'yours')
  } else {
    console.log('  (none in your existing chats)')
  }

  console.log(`\nSearching public chats for "${term}"...`)
  const pub = await invoke('searchPublicChats', { query: term })
  if (pub.ok && pub.result.chat_ids?.length) {
    for (const id of pub.result.chat_ids.slice(0, 15)) await describe(id, 'public')
  } else {
    console.log('  (no public matches)')
  }

  await client.close()
}

main().catch(err => {
  console.error('search failed:', err)
  process.exit(1)
})
