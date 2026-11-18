/**
 * Tests for message/button parsing, using realistic TDLib object shapes.
 * Run: npx tsx scripts/test-messages.ts
 */
import assert from 'node:assert/strict'
import { listButtons, findButton, messageText } from '../src/messages.js'

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

const inlineMessage = {
  _: 'message',
  id: 100,
  chat_id: 42,
  content: {
    _: 'messageText',
    text: { _: 'formattedText', text: 'Choose an option:', entities: [] },
  },
  reply_markup: {
    _: 'replyMarkupInlineKeyboard',
    rows: [
      [
        {
          _: 'inlineKeyboardButton',
          text: '✅ Approve',
          type: { _: 'inlineKeyboardButtonTypeCallback', data: 'YXBwcm92ZQ==' },
        },
        {
          _: 'inlineKeyboardButton',
          text: '❌ Reject',
          type: { _: 'inlineKeyboardButtonTypeCallback', data: 'cmVqZWN0' },
        },
      ],
      [
        {
          _: 'inlineKeyboardButton',
          text: 'Open docs',
          type: { _: 'inlineKeyboardButtonTypeUrl', url: 'https://example.com' },
        },
      ],
    ],
  },
}

const replyKeyboardMessage = {
  _: 'message',
  id: 101,
  chat_id: 42,
  content: {
    _: 'messageText',
    text: { _: 'formattedText', text: 'Pick:', entities: [] },
  },
  reply_markup: {
    _: 'replyMarkupShowKeyboard',
    rows: [
      [
        { _: 'keyboardButton', text: 'Menu', type: { _: 'keyboardButtonTypeText' } },
        {
          _: 'keyboardButton',
          text: 'Share phone',
          type: { _: 'keyboardButtonTypeRequestPhoneNumber' },
        },
      ],
    ],
  },
}

console.log('messages')

test('extracts plain message text', () => {
  assert.equal(messageText(inlineMessage), 'Choose an option:')
})

test('extracts caption from media messages', () => {
  const photo = {
    content: {
      _: 'messagePhoto',
      caption: { _: 'formattedText', text: 'a caption', entities: [] },
    },
  }
  assert.equal(messageText(photo), 'a caption')
})

test('returns undefined for contentless messages', () => {
  assert.equal(messageText({ content: { _: 'messageChatJoinByLink' } }), undefined)
})

test('flattens inline keyboard with coordinates and payloads', () => {
  const buttons = listButtons(inlineMessage)
  assert.equal(buttons.length, 3)
  assert.deepEqual(
    buttons.map(b => [b.row, b.col, b.text]),
    [
      [0, 0, '✅ Approve'],
      [0, 1, '❌ Reject'],
      [1, 0, 'Open docs'],
    ],
  )
  assert.equal(buttons[0]!.keyboard, 'inline')
  // Base64 callback data must survive untouched.
  assert.equal(buttons[0]!.data, 'YXBwcm92ZQ==')
  assert.equal(buttons[2]!.url, 'https://example.com')
})

test('flattens reply keyboard and tags it as such', () => {
  const buttons = listButtons(replyKeyboardMessage)
  assert.equal(buttons.length, 2)
  assert.equal(buttons[0]!.keyboard, 'reply')
  assert.equal(buttons[0]!.type, 'keyboardButtonTypeText')
  assert.equal(buttons[1]!.type, 'keyboardButtonTypeRequestPhoneNumber')
})

test('returns no buttons for markup kinds that have none', () => {
  assert.deepEqual(listButtons({ reply_markup: { _: 'replyMarkupRemoveKeyboard' } }), [])
  assert.deepEqual(listButtons({ reply_markup: { _: 'replyMarkupForceReply' } }), [])
  assert.deepEqual(listButtons({}), [])
})

console.log('\nfindButton')

test('finds by exact text', () => {
  const r = findButton(listButtons(inlineMessage), { text: '✅ Approve' })
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.button.data, 'YXBwcm92ZQ==')
})

test('finds by case-insensitive substring, ignoring emoji', () => {
  const r = findButton(listButtons(inlineMessage), { text: 'approve' })
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.button.col, 0)
})

test('finds by row/col', () => {
  const r = findButton(listButtons(inlineMessage), { row: 0, col: 1 })
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.button.text, '❌ Reject')
})

test('row defaults col to 0', () => {
  const r = findButton(listButtons(inlineMessage), { row: 1 })
  assert.equal(r.ok, true)
  assert.equal(r.ok && r.button.text, 'Open docs')
})

test('reports ambiguity rather than guessing', () => {
  const msg = {
    reply_markup: {
      _: 'replyMarkupInlineKeyboard',
      rows: [
        [
          { text: 'Page 1', type: { _: 'inlineKeyboardButtonTypeCallback', data: 'YQ==' } },
          { text: 'Page 2', type: { _: 'inlineKeyboardButtonTypeCallback', data: 'Yg==' } },
        ],
      ],
    },
  }
  const r = findButton(listButtons(msg), { text: 'Page' })
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : '', /Ambiguous/)
  assert.equal(r.ok === false && r.available.length, 2)
})

test('exact mode disables substring fallback', () => {
  const r = findButton(listButtons(inlineMessage), { text: 'approve', exact: true })
  assert.equal(r.ok, false)
})

test('missing button lists what is available', () => {
  const r = findButton(listButtons(inlineMessage), { text: 'nonexistent' })
  assert.equal(r.ok, false)
  assert.equal(r.ok === false && r.available.length, 3)
})

test('empty keyboard reports clearly', () => {
  const r = findButton([], { text: 'x' })
  assert.equal(r.ok, false)
  assert.match(r.ok === false ? r.reason : '', /no buttons/i)
})

console.log(`\n${passed} passed`)
