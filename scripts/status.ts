/**
 * Reports the current authorization state without exposing any credentials.
 * Run: npx tsx scripts/status.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

function parse(res: any) {
  return JSON.parse(res.content[0].text)
}

async function main() {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/index.ts'],
    env: { ...process.env } as Record<string, string>,
    // Inherit so TDLib errors (e.g. a database locked by another instance)
    // are visible rather than swallowed.
    stderr: 'inherit',
  })

  const client = new Client({ name: 'status', version: '1.0.0' })
  await client.connect(transport)

  const status = parse(await client.callTool({ name: 'tg_login', arguments: { action: 'status' } }))
  console.log('authorization_state:', status.authorization_state)
  console.log('authorized:         ', status.authorized)
  console.log('next_action:        ', status.next_action)
  console.log('note:               ', status.note)
  if (status.password_hint) console.log('password_hint:      ', status.password_hint)
  if (status.error) console.log('error:              ', JSON.stringify(status.error))

  if (status.authorized) {
    const me = parse(await client.callTool({ name: 'tg_invoke', arguments: { method: 'getMe' } }))
    if (me.ok) {
      const u = me.result
      console.log('\nLogged in as:')
      console.log('  id:       ', u.id)
      console.log('  name:     ', [u.first_name, u.last_name].filter(Boolean).join(' '))
      console.log('  username: ', u.usernames?.editable_username ?? '(none)')
    } else {
      console.log('\ngetMe failed:', JSON.stringify(me.error))
    }
  }

  await client.close()
}

main().catch(err => {
  console.error('status check failed:', err)
  process.exit(1)
})
