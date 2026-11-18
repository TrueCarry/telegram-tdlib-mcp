/**
 * Probes a list of candidate usernames and reports which resolve to bots.
 * Usage: npx tsx scripts/try-usernames.ts name1 name2 ...
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const candidates = process.argv.slice(2).map(s => s.replace(/^@/, ''))
if (candidates.length === 0) {
  console.error('Usage: npx tsx scripts/try-usernames.ts <username> [...]')
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
  const client = new Client({ name: 'try-usernames', version: '1.0.0' })
  await client.connect(transport)

  const invoke = async (method: string, params: Record<string, unknown> = {}) =>
    parse(await client.callTool({ name: 'tg_invoke', arguments: { method, params } }))

  for (const username of candidates) {
    const chat = await invoke('searchPublicChat', { username })
    if (!chat.ok) {
      console.log(`  @${username}: ${chat.error.message}`)
      continue
    }
    const type = chat.result.type
    if (type?._ !== 'chatTypePrivate') {
      console.log(`  @${username}: ${chat.result.title} — ${type?._} (not a bot)`)
      continue
    }
    const user = await invoke('getUser', { user_id: type.user_id })
    const isBot = user.ok && user.result.type?._ === 'userTypeBot'
    console.log(
      `  @${username}: ${chat.result.title} — ${isBot ? 'BOT ✅' : 'regular user'}` +
        `  chat_id ${chat.result.id}${isBot ? `, bot_user_id ${type.user_id}` : ''}`,
    )
  }

  await client.close()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
