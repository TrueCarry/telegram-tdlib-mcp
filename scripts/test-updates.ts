/**
 * Focused tests for the update ring buffer. Run: npx tsx scripts/test-updates.ts
 *
 * This covers the cursor/eviction semantics that the whole update-delivery
 * design depends on, without needing a Telegram connection.
 */
import assert from 'node:assert/strict'
import { UpdateBuffer, extractChatId, matchesType } from '../src/updates.js'

let passed = 0
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  const run = async () => {
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
  return run()
}

const msg = (chatId: number, type = 'updateNewMessage') => ({
  _: type,
  message: { _: 'message', chat_id: chatId, id: 1 },
})

async function main() {
  console.log('UpdateBuffer')

  await test('assigns monotonic seq starting at 1', () => {
    const b = new UpdateBuffer(10)
    b.push({ _: 'a' })
    b.push({ _: 'b' })
    const r = b.poll(0)
    assert.deepEqual(
      r.updates.map(u => u.seq),
      [1, 2],
    )
    assert.equal(r.next_seq, 2)
  })

  await test('cursor returns only newer updates', () => {
    const b = new UpdateBuffer(10)
    b.push({ _: 'a' })
    b.push({ _: 'b' })
    const first = b.poll(0)
    b.push({ _: 'c' })
    const second = b.poll(first.next_seq)
    assert.equal(second.updates.length, 1)
    assert.equal(second.updates[0]!.update._, 'c')
  })

  await test('no updates are lost across sequential polls', () => {
    const b = new UpdateBuffer(100)
    let cursor = 0
    const seen: string[] = []
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 3; i++) b.push({ _: `u${round}_${i}` })
      const r = b.poll(cursor)
      seen.push(...r.updates.map(u => String(u.update._)))
      cursor = r.next_seq
    }
    assert.equal(seen.length, 15)
    assert.equal(new Set(seen).size, 15, 'no duplicates')
  })

  await test('evicts oldest beyond capacity and reports dropped', () => {
    const b = new UpdateBuffer(3)
    for (let i = 0; i < 5; i++) b.push({ _: `u${i}` })
    assert.equal(b.size, 3)
    // Cursor 0 is stale: seq 1 and 2 were evicted.
    const r = b.poll(0)
    assert.equal(r.dropped, true)
    assert.equal(r.total_dropped, 2)
    assert.equal(r.oldest_seq, 3)
    assert.deepEqual(
      r.updates.map(u => String(u.update._)),
      ['u2', 'u3', 'u4'],
    )
  })

  await test('does not report dropped when cursor is current', () => {
    const b = new UpdateBuffer(3)
    for (let i = 0; i < 5; i++) b.push({ _: `u${i}` })
    const r = b.poll(5)
    assert.equal(r.dropped, false)
    assert.equal(r.updates.length, 0)
  })

  await test('filters by exact type and wildcard prefix', () => {
    const b = new UpdateBuffer(10)
    b.push({ _: 'updateNewMessage' })
    b.push({ _: 'updateMessageContent' })
    b.push({ _: 'updateMessageEdited' })
    b.push({ _: 'updateChatTitle' })

    assert.equal(b.poll(0, { types: ['updateNewMessage'] }).updates.length, 1)
    assert.equal(b.poll(0, { types: ['updateMessage*'] }).updates.length, 2)
    assert.equal(
      b.poll(0, { types: ['updateNewMessage', 'updateChatTitle'] }).updates.length,
      2,
    )
  })

  await test('filters by chat_id across update shapes', () => {
    const b = new UpdateBuffer(10)
    b.push(msg(111))
    b.push({ _: 'updateMessageContent', chat_id: 222, message_id: 5 })
    b.push({ _: 'updateNewChat', chat: { _: 'chat', id: 333 } })

    assert.equal(b.poll(0, { chatId: 111 }).updates.length, 1)
    assert.equal(b.poll(0, { chatId: 222 }).updates.length, 1)
    assert.equal(b.poll(0, { chatId: 333 }).updates.length, 1)
    assert.equal(b.poll(0, { chatId: 999 }).updates.length, 0)
  })

  await test('long-poll resolves immediately when matches are buffered', async () => {
    const b = new UpdateBuffer(10)
    b.push({ _: 'updateNewMessage' })
    const started = Date.now()
    const r = await b.pollWithWait(0, {}, 5000)
    assert.equal(r.updates.length, 1)
    assert.ok(Date.now() - started < 100, 'should not have waited')
  })

  await test('long-poll wakes on a matching update', async () => {
    const b = new UpdateBuffer(10)
    const started = Date.now()
    const promise = b.pollWithWait(0, { types: ['updateNewMessage'] }, 3000)
    setTimeout(() => b.push({ _: 'updateNewMessage' }), 50)
    const r = await promise
    assert.equal(r.updates.length, 1)
    assert.ok(Date.now() - started < 1500, 'should have woken early')
  })

  await test('long-poll ignores non-matching updates and times out', async () => {
    const b = new UpdateBuffer(10)
    const promise = b.pollWithWait(0, { types: ['updateNewMessage'] }, 200)
    setTimeout(() => b.push({ _: 'updateChatTitle' }), 20)
    const r = await promise
    assert.equal(r.updates.length, 0)
    // Cursor must still advance so the consumer does not re-read old updates.
    assert.equal(r.next_seq, 1)
  })

  await test('timed-out long-poll does not leak waiters', async () => {
    const b = new UpdateBuffer(10)
    await b.pollWithWait(0, { types: ['nope'] }, 50)
    b.push({ _: 'anything' })
    assert.equal(b.poll(0).updates.length, 1)
  })

  console.log('\nhelpers')

  await test('matchesType handles wildcard and exact', () => {
    assert.equal(matchesType('updateMessageContent', ['updateMessage*']), true)
    assert.equal(matchesType('updateNewMessage', ['updateMessage*']), false)
    assert.equal(matchesType('updateNewMessage', ['updateNewMessage']), true)
  })

  await test('extractChatId reads all known shapes', () => {
    assert.equal(extractChatId({ chat_id: 5 }), 5)
    assert.equal(extractChatId({ message: { chat_id: 6 } }), 6)
    assert.equal(extractChatId({ chat: { id: 7 } }), 7)
    assert.equal(extractChatId({ _: 'updateOption' }), undefined)
  })

  console.log(`\n${passed} passed`)
}

main()
