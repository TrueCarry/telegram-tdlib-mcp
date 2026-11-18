/**
 * Exercises the tg_schema discovery tool against the generated catalog.
 * Run: npx tsx scripts/test-schema.ts
 */
import assert from 'node:assert/strict'
import { getTdlibInfo } from 'prebuilt-tdlib'
import { handleSchema } from '../src/tools/schema.js'

function call(args: unknown): any {
  const res = handleSchema(args)
  return JSON.parse(res.content[0]!.text)
}

let passed = 0
function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (err) {
    console.error(`FAIL  ${name}`)
    console.error(err)
    process.exitCode = 1
  }
}

console.log('tg_schema')

test('overview lists counts and version', () => {
  const r = call({})
  assert.equal(r.ok, true)
  // Compare against the installed binary rather than literals, which go stale
  // on every TDLib upgrade.
  assert.equal(r.tdlib_version, getTdlibInfo().version, 'catalog must match the installed TDLib')
  assert.ok(r.method_count > 900, `implausibly few methods: ${r.method_count}`)
})

test('search finds getCallbackQueryAnswer for "callback query"', () => {
  const r = call({ query: 'callback query', kind: 'methods', limit: 10 })
  const names = r.results.map((x: any) => x.name)
  assert.ok(names.includes('getCallbackQueryAnswer'), `got: ${names.join(', ')}`)
})

test('search finds sendMessage for "send message"', () => {
  const r = call({ query: 'send message', kind: 'methods', limit: 10 })
  const names = r.results.map((x: any) => x.name)
  assert.ok(names.includes('sendMessage'), `got: ${names.join(', ')}`)
})

test('describes sendMessage with full signature and params', () => {
  const r = call({ method: 'sendMessage' })
  assert.equal(r.ok, true)
  assert.equal(r.returns, 'Message')
  const names = r.params.map((p: any) => p.name)
  assert.ok(names.includes('chat_id'))
  assert.ok(names.includes('input_message_content'))
  // Every param must carry TDLib's own doc text.
  for (const p of r.params) assert.ok(p.description.length > 0, `${p.name} missing description`)
})

test('sendMessage expansion reveals how to build input_message_content', () => {
  const r = call({ method: 'sendMessage' })
  const refs = r.referenced_types
  assert.ok(refs.InputMessageContent, 'InputMessageContent should be expanded')
  assert.equal(refs.InputMessageContent.kind, 'abstract_class')
  const variants = refs.InputMessageContent.variants.map((v: any) => v.name)
  assert.ok(variants.includes('inputMessageText'), 'inputMessageText must be discoverable')
})

test('abstract class lookup lists all inline button variants', () => {
  const r = call({ type: 'InlineKeyboardButtonType' })
  assert.equal(r.kind, 'abstract_class')
  const names = r.variants.map((v: any) => v.name)
  assert.ok(names.includes('inlineKeyboardButtonTypeCallback'))
  assert.ok(names.includes('inlineKeyboardButtonTypeWebApp'))
  // Asserting an exact count breaks on every TDLib release that adds a button
  // kind; assert the shape instead, and that every variant is well formed.
  assert.ok(names.length >= 10, `expected at least 10 variants, got ${names.length}`)
  assert.ok(
    names.every((n: string) => n.startsWith('inlineKeyboardButtonType')),
    'every variant should be an inlineKeyboardButtonType',
  )
})

test('AuthorizationState lists the states the login flow depends on', () => {
  const r = call({ type: 'AuthorizationState' })
  const names = r.variants.map((v: any) => v.name)
  // Assert the states tg_login actually drives, rather than a total count that
  // shifts whenever TDLib adds an authorization step.
  for (const required of [
    'authorizationStateWaitTdlibParameters',
    'authorizationStateWaitPhoneNumber',
    'authorizationStateWaitCode',
    'authorizationStateWaitPassword',
    'authorizationStateWaitRegistration',
    'authorizationStateReady',
    'authorizationStateClosed',
  ]) {
    assert.ok(names.includes(required), `${required} must be present`)
  }
})

test('getCallbackQueryAnswer expands its payload union', () => {
  const r = call({ method: 'getCallbackQueryAnswer' })
  const refs = r.referenced_types
  assert.ok(refs.CallbackQueryPayload)
  const variants = refs.CallbackQueryPayload.variants.map((v: any) => v.name)
  assert.ok(variants.includes('callbackQueryPayloadData'))
})

test('unknown method returns suggestions instead of a bare error', () => {
  const r = call({ method: 'sendMesage' })
  assert.equal(r.ok, false)
  assert.ok(r.did_you_mean.includes('sendMessage'), `got: ${r.did_you_mean}`)
})

test('synchronous methods are flagged', () => {
  const r = call({ method: 'getTextEntities' })
  assert.equal(r.synchronous, true)
})

test('vector element types are expanded, not skipped', () => {
  const r = call({ type: 'replyMarkupInlineKeyboard' })
  // rows is vector<vector<inlineKeyboardButton>>
  assert.ok(r.referenced_types.inlineKeyboardButton, 'should unwrap nested vectors')
})

console.log(`\n${passed} passed`)
