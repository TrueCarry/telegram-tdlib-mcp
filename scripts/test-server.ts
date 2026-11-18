/**
 * End-to-end smoke test: launches the MCP server over stdio using the real MCP
 * client, lists its tools, and exercises the ones that do not require a
 * logged-in Telegram account.
 *
 * Run: npx tsx scripts/test-server.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

let passed = 0
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    console.error(`FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

function parse(res: any) {
  return JSON.parse(res.content[0].text)
}

async function main() {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', 'src/index.ts'],
    // Credentials are dummy: these tests never reach the Telegram network.
    env: {
      ...process.env,
      TDLIB_API_ID: '12345',
      TDLIB_API_HASH: 'test_hash_not_real',
      TDLIB_DB_DIR: '/tmp/telegram-tdlib-mcp-test',
    } as Record<string, string>,
  })

  const client = new Client({ name: 'smoke-test', version: '1.0.0' })
  await client.connect(transport)

  console.log('MCP server')

  await test('advertises all six tools', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name).sort()
    assert.deepEqual(names, [
      'tg_click_button',
      'tg_invoke',
      'tg_login',
      'tg_schema',
      'tg_updates',
      'tg_wait_for',
    ])
  })

  await test('every tool has a description and input schema', async () => {
    const { tools } = await client.listTools()
    for (const t of tools) {
      assert.ok(t.description && t.description.length > 50, `${t.name} description too short`)
      assert.ok(t.inputSchema, `${t.name} missing inputSchema`)
    }
  })

  await test('tg_schema overview works over the wire', async () => {
    const res = await client.callTool({ name: 'tg_schema', arguments: {} })
    const out = parse(res)
    assert.ok(out.method_count > 900, `implausibly few methods: ${out.method_count}`)
  })

  await test('tg_schema describes sendMessage with nested type expansion', async () => {
    const res = await client.callTool({
      name: 'tg_schema',
      arguments: { method: 'sendMessage' },
    })
    const out = parse(res)
    assert.equal(out.name, 'sendMessage')
    assert.ok(out.referenced_types.InputMessageContent)
  })

  await test('tg_invoke rejects an unknown method without a network call', async () => {
    const res = await client.callTool({
      name: 'tg_invoke',
      arguments: { method: 'notARealMethod' },
    })
    const out = parse(res)
    assert.equal(out.ok, false)
    assert.match(out.error.message, /Unknown TDLib method/)
  })

  await test('tg_invoke suggests a correction for a typo', async () => {
    const res = await client.callTool({
      name: 'tg_invoke',
      arguments: { method: 'sendMesage' },
    })
    const out = parse(res)
    assert.ok(out.did_you_mean.includes('sendMessage'), `got ${out.did_you_mean}`)
  })

  await test('tg_invoke runs a synchronous method (no login required)', async () => {
    const res = await client.callTool({
      name: 'tg_invoke',
      arguments: {
        method: 'getTextEntities',
        params: { text: 'hello @durov #tag' },
        sync: true,
      },
    })
    const out = parse(res)
    assert.equal(out.ok, true)
    assert.equal(out.result._, 'textEntities')
    assert.equal(out.result.entities.length, 2)
  })

  await test('tg_invoke accepts a verbatim TDLib payload using @type', async () => {
    const res = await client.callTool({
      name: 'tg_invoke',
      arguments: {
        request: { '@type': 'getTextEntities', text: 'call @BotFather now' },
        sync: true,
      },
    })
    const out = parse(res)
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(out.result.entities[0].type._, 'textEntityTypeMention')
  })

  await test('nested @type is normalized recursively', async () => {
    // parseTextEntities takes a nested parse_mode object.
    const res = await client.callTool({
      name: 'tg_invoke',
      arguments: {
        request: {
          '@type': 'parseTextEntities',
          text: '*bold*',
          parse_mode: { '@type': 'textParseModeMarkdown', version: 1 },
        },
        sync: true,
      },
    })
    const out = parse(res)
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.equal(out.result.text, 'bold')
    assert.equal(out.result.entities[0].type._, 'textEntityTypeBold')
  })

  await test('tg_updates returns an empty result promptly with wait_ms=0', async () => {
    const started = Date.now()
    const res = await client.callTool({
      name: 'tg_updates',
      arguments: { wait_ms: 0 },
    })
    const out = parse(res)
    assert.equal(out.ok, true, JSON.stringify(out).slice(0, 300))
    assert.equal(typeof out.next_seq, 'number')
    assert.ok(Date.now() - started < 20000, 'should not block')
  })

  await test('tg_click_button validates arguments', async () => {
    const res: any = await client.callTool({
      name: 'tg_click_button',
      arguments: { chat_id: 1 } as any,
    })
    // message_id is required, so the SDK rejects before the handler runs.
    assert.equal(res.isError, true)
  })

  await client.close()

  // The server must stay usable for schema discovery even with no credentials,
  // rather than crashing after it has announced itself as ready.
  console.log('\nMCP server (no credentials configured)')

  const bareEnv = { ...process.env } as Record<string, string>
  delete bareEnv.TDLIB_API_ID
  delete bareEnv.TDLIB_API_HASH
  // Run from a directory with no .env, otherwise a developer's real
  // credentials would be picked up and this scenario would not be exercised.
  const bareCwd = mkdtempSync(join(tmpdir(), 'tdlib-mcp-nocreds-'))
  bareEnv.TDLIB_DB_DIR = join(bareCwd, 'tdlib-data')

  const bareTransport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', resolve(process.cwd(), 'src/index.ts')],
    env: bareEnv,
    cwd: bareCwd,
  })
  const bareClient = new Client({ name: 'smoke-test-bare', version: '1.0.0' })
  await bareClient.connect(bareTransport)

  await test('starts and serves tg_schema without credentials', async () => {
    const res = await bareClient.callTool({ name: 'tg_schema', arguments: { method: 'getMe' } })
    const out = parse(res)
    assert.equal(out.name, 'getMe')
  })

  await test('credential-requiring tools fail gracefully, not fatally', async () => {
    const res = await bareClient.callTool({
      name: 'tg_invoke',
      arguments: { method: 'getMe' },
    })
    const out = parse(res)
    assert.equal(out.ok, false)
    assert.match(out.error.message, /TDLIB_API_ID/)
    // The server must still be alive afterwards.
    const after = await bareClient.listTools()
    assert.equal(after.tools.length, 6)
  })

  await bareClient.close()
  rmSync(bareCwd, { recursive: true, force: true })

  console.log(`\n${passed} passed`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
