/**
 * Dumps the last N messages of a bot chat, oldest first, with sender.
 * Usage: npx tsx scripts/dump-history.ts <bot_username> [limit]
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const username = (process.argv[2] ?? '').replace(/^@/, '')
const limit = Number(process.argv[3] ?? 12)

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
  const client = new Client({ name: 'dump-history', version: '1.0.0' })
  await client.connect(transport)

  try {
    const invoke = async (method: string, params: Record<string, unknown> = {}) =>
      parse(await client.callTool({ name: 'tg_invoke', arguments: { method, params } }))

    const chat = await invoke('searchPublicChat', { username })
    const chatId = chat.result.id
    await invoke('openChat', { chat_id: chatId })

    // TDLib serves the local cache first; the initial call may return a single
    // message. Page backwards from the oldest id we have until we have enough.
    const collected: any[] = []
    let fromId = 0
    for (let i = 0; i < 6 && collected.length < limit; i++) {
      const history = await invoke('getChatHistory', {
        chat_id: chatId,
        from_message_id: fromId,
        offset: 0,
        limit,
        only_local: false,
      })
      if (!history.ok) {
        console.error('getChatHistory failed:', JSON.stringify(history.error))
        return
      }
      const batch = history.result.messages ?? []
      if (batch.length === 0) {
        if (fromId === 0 && collected.length === 0) continue // warm the cache
        break
      }
      for (const m of batch) {
        if (!collected.some(c => c.id === m.id)) collected.push(m)
      }
      fromId = batch[batch.length - 1].id
    }

    const messages = collected.slice(0, limit).reverse()
    for (const m of messages) {
      const who = m.is_outgoing ? 'ME ' : 'BOT'
      const when = new Date(m.date * 1000).toISOString().slice(11, 19)
      const text: string = m.content?.text?.text ?? m.content?.caption?.text ?? `(${m.content?._})`
      const firstLines = text.split('\n').slice(0, 6).join('\n      ')
      console.log(`\n[${when}] ${who} id=${m.id}${m.edit_date ? ' (edited)' : ''}`)
      console.log(`      ${firstLines}`)
    }
  } finally {
    await client.close()
  }
}

main().catch(err => {
  console.error(String(err?.message ?? err))
  process.exitCode = 1
})
