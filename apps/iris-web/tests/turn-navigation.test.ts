import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { MessageView } from '@iris/protocol'
import { turnNavigation } from '../src/app/turn-navigation.ts'
import { readingWindow } from '../src/app/reading-window.ts'

test('navigation retains greetings, groups exchanges, and expands an old anchor into the reading window', () => {
  const messages: MessageView[] = Array.from({ length: 241 }, (_, id) => ({
    id, key: `message-${id}`, name: 'Reader', role: id % 2 ? 'user' : 'assistant',
    text: `Message ${id}`, ...(id === 0 ? {} : { turn: Math.ceil(id / 2) }),
  }))
  const items = turnNavigation(messages)
  assert.equal(items.length, 121)
  assert.equal(items[0]?.key, 'message-0')
  const target = items[3]!
  assert.equal(target.prompt, 'Message 5')
  assert.equal(target.response, 'Message 6')
  assert.ok(!readingWindow(messages, 100).visible.some(row => row.key === target.key))
  const expanded = readingWindow(messages, messages.length - target.start, row => row.turn)
  assert.equal(expanded.visible[0]?.key, target.key)
  assert.equal(expanded.visible.at(-1)?.key, 'message-240')
})

test('previews strip embedded scripts and styles and stay bounded', () => {
  const items = turnNavigation([{
    id: 0, key: 'greeting', name: 'Character', role: 'assistant',
    text: '<style>secret style</style><script>secret code</script><b>Hello</b>\n' + 'story '.repeat(1000),
  }])
  assert.ok(items[0]?.response.startsWith('Hello story'))
  assert.equal(items[0]?.response.length, 240)
  assert.ok(!items[0]?.response.includes('secret'))

  const fenced = turnNavigation([{
    id: 1, key: 'card', name: 'Character', role: 'assistant',
    text: '```html\n<div>Card interface copy</div>\n```',
  }])
  assert.equal(fenced[0]?.response, '')
})
