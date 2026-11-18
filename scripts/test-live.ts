/**
 * Live connectivity probe against Telegram's real servers.
 *
 * Uses a deliberately invalid api_id. This cannot log in, but it proves how far
 * the pipeline gets: TDLib initializes, the auth state machine advances, a real
 * network round trip happens, and the server's error reporting surfaces
 * Telegram's own response. Reaching API_ID_INVALID means everything except
 * credential validity is working.
 *
 * Run: npx tsx scripts/test-live.ts   (requires network)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { rmSync } from 'node:fs'

const DB_DIR = '/tmp/telegram-tdlib-live-probe'

function parse(res: any) {
  return JSON.parse(res.content[0].text)
}

async function main() {
  rmSync(DB_DIR, { recursive: true, force: true })

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/index.ts'],
    env: {
      ...process.env,
      TDLIB_API_ID: '99999999',
      TDLIB_API_HASH: 'deadbeefdeadbeefdeadbeefdeadbeef',
      TDLIB_DB_DIR: DB_DIR,
    } as Record<string, string>,
    stderr: 'pipe',
  })

  const client = new Client({ name: 'live-probe', version: '1.0.0' })
  await client.connect(transport)

  console.log('1. Initial authorization state')
  const status = parse(await client.callTool({ name: 'tg_login', arguments: { action: 'status' } }))
  console.log('   state:      ', status.authorization_state)
  console.log('   authorized: ', status.authorized)
  console.log('   next_action:', status.next_action)
  console.log('   note:       ', status.note)

  console.log('\n2. Submitting a phone number (real network round trip to Telegram)')
  const phone = parse(
    await client.callTool({
      name: 'tg_login',
      arguments: { action: 'phone', phone_number: '+99966123456' },
    }),
  )
  console.log('   ok:   ', phone.ok)
  if (phone.error) {
    console.log('   error:', JSON.stringify(phone.error))
  } else {
    console.log('   state:', phone.authorization_state)
  }

  console.log('\n3. Server still responsive after the error?')
  const tools = await client.listTools()
  console.log('   tools available:', tools.tools.length)

  console.log('\n4. Updates flowed into the buffer during connection?')
  const updates = parse(
    await client.callTool({ name: 'tg_updates', arguments: { wait_ms: 2000 } }),
  )
  console.log('   buffered updates:', updates.latest_seq)
  const types = (updates.updates ?? []).map((u: any) => u.update._)
  console.log('   sample types:', [...new Set(types)].slice(0, 8).join(', ') || '(none)')

  await client.close()
  rmSync(DB_DIR, { recursive: true, force: true })
}

main().catch(err => {
  console.error('probe failed:', err)
  process.exit(1)
})
