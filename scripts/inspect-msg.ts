/**
 * Dumps a message's text entities (embedded links) and reply markup.
 * Usage: npx tsx scripts/inspect-msg.ts <bot_username> <message_id>
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const username = (process.argv[2] ?? '').replace(/^@/, '')
const messageId = Number(process.argv[3])

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
  const client = new Client({ name: 'inspect', version: '1.0.0' })
  await client.connect(transport)

  const invoke = async (method: string, params: Record<string, unknown> = {}) =>
    parse(await client.callTool({ name: 'tg_invoke', arguments: { method, params } }))

  const chat = await invoke('searchPublicChat', { username })
  const chatId = chat.result.id

  const msg = await invoke('getMessage', { chat_id: chatId, message_id: messageId })
  if (!msg.ok) {
    console.error('getMessage failed:', JSON.stringify(msg.error))
    process.exit(1)
  }

  const formatted = msg.result.content?.text
  const text: string = formatted?.text ?? ''
  console.log('--- text ---')
  console.log(text)

  console.log('\n--- entities (embedded links) ---')
  const entities = formatted?.entities ?? []
  if (entities.length === 0) console.log('(none)')
  for (const e of entities) {
    const slice = [...text].slice(e.offset, e.offset + e.length).join('')
    const type = e.type?._ ?? '?'
    const url = e.type?.url ? ` -> ${e.type.url}` : ''
    console.log(`  ${type}: "${slice}"${url}`)
  }

  console.log('\n--- reply_markup ---')
  console.log(JSON.stringify(msg.result.reply_markup, null, 2))

  await client.close()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
