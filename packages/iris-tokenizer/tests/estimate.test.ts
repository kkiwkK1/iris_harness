import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createCalibratingCounter,
  DEFAULT_MESSAGE_OVERHEAD,
  estimateRequest,
  estimateTokens,
} from '../src/index.ts'

/**
 * Real counts from `deepseek-v4-flash`, measured by difference so the chat
 * template cancels out. These are the fixtures the weights were fitted to; if a
 * change moves the estimator outside the band below, it has traded accuracy on
 * real text for accuracy on an idea about text.
 */
const MEASURED: readonly { label: string, text: string, tokens: number }[] = [
  {
    label: 'latin prose',
    text: 'The cartographer folded the chart twice and set it down beside the lamp, saying nothing at all.',
    tokens: 19,
  },
  { label: 'chinese prose', text: '制图师把海图折了两次，放在灯边，什么也没说。她的手指还沾着墨。', tokens: 25 },
  { label: 'mixed', text: '她说 the coastline is wrong，然后指着 chart 上的一处 bay。', tokens: 15 },
  {
    label: 'typescript',
    text: 'export function assemble(input: AssembleInput): AssembleResult { const { contributions, history } = input; return renderSystem(contributions) }',
    tokens: 30,
  },
  {
    label: 'json',
    text: '{"name":"Aria","description":"a retired cartographer","tags":["oc","fantasy"],"talkativeness":50}',
    tokens: 28,
  },
  { label: 'whitespace', text: 'a\n\n  b\n\n    c\n\n      d\n\n        e\n', tokens: 13 },
  { label: 'cjk with punctuation', text: '「你要找哪个年代的？」——她抬眼，语气平静，却带着一点不易察觉的兴趣。', tokens: 20 },
]

test('the estimate stays within the stated band on real text', () => {
  for (const sample of MEASURED) {
    const ratio = estimateTokens(sample.text) / sample.tokens
    assert.ok(
      ratio >= 0.95 && ratio <= 1.35,
      `${sample.label}: estimated ${estimateTokens(sample.text)} against ${sample.tokens} real (ratio ${ratio.toFixed(2)})`,
    )
  }
})

test('the estimate never comes in low enough to overflow a budget', () => {
  // The asymmetry that matters: over-estimating drops a history turn,
  // under-estimating gets the request rejected after the user has waited.
  for (const sample of MEASURED) {
    assert.ok(
      estimateTokens(sample.text) >= sample.tokens * 0.95,
      `${sample.label} under-estimated: ${estimateTokens(sample.text)} < ${sample.tokens}`,
    )
  }
})

test('Chinese is not counted as if it were English', () => {
  // The failure this package exists to prevent. A `length / 4` estimator puts
  // this at 8 tokens; it really costs 25.
  const chinese = '制图师把海图折了两次，放在灯边，什么也没说。她的手指还沾着墨。'
  const naive = Math.ceil(chinese.length / 4)

  assert.equal(naive, 8)
  assert.ok(estimateTokens(chinese) > naive * 2.5)
})

test('empty text costs nothing', () => {
  assert.equal(estimateTokens(''), 0)
})

test('estimates grow linearly with length', () => {
  // Measured: Chinese held at 1.240 chars/token at both 31 and 248 characters.
  // The band allows for rounding up: a short sample pays a whole token for its
  // fractional tail, so eight of them cost slightly less than eight times one.
  const once = estimateTokens('制图师把海图折了两次。')
  const eight = estimateTokens('制图师把海图折了两次。'.repeat(8))

  assert.ok(eight >= once * 7 && eight <= once * 8.5, `${once} once, ${eight} eight times`)
})

test('an emoji costs more than a letter', () => {
  assert.ok(estimateTokens('🗺️') > estimateTokens('a'))
})

test('a request charges per-message framing on top of its text', () => {
  const messages = [{ text: 'hi' }, { text: 'hello' }, { text: 'bye' }]
  const text = messages.reduce((total, message) => total + estimateTokens(message.text), 0)

  assert.equal(estimateRequest(messages), text + 3 * DEFAULT_MESSAGE_OVERHEAD)
})

test('a conversation of short turns is mostly framing', () => {
  // Why the overhead is not optional: 40 one-word turns cost more in role
  // framing than in words, and a text-only counter misses all of it.
  const messages = Array.from({ length: 40 }, () => ({ text: 'ok' }))

  assert.ok(estimateRequest(messages) > 40 * DEFAULT_MESSAGE_OVERHEAD)
})

test('a template overhead is added once, not per message', () => {
  const messages = [{ text: 'hi' }, { text: 'there' }]
  const withTemplate = estimateRequest(messages, { templateOverhead: 84 })

  assert.equal(withTemplate - estimateRequest(messages), 84)
})

test('a calibrating counter starts as the plain estimator', () => {
  const counter = createCalibratingCounter()

  assert.equal(counter.scale, 1)
  assert.equal(counter.samples, 0)
  assert.equal(counter.count('hello world'), estimateTokens('hello world'))
})

test('observations converge the counter on the real ratio', () => {
  const counter = createCalibratingCounter()
  const RAW = 100
  const REAL = 125 // a provider whose counts run 25% above the raw estimate

  // Feed back what the counter itself predicted each turn, which is what a
  // caller does: it reports the number it budgeted against, not a raw estimate.
  for (let turn = 0; turn < 12; turn += 1) counter.observe(RAW * counter.scale, REAL)

  assert.ok(counter.scale > 1.2 && counter.scale < 1.3, `scale settled at ${counter.scale}`)
  assert.equal(counter.samples, 12)
})

test('a caller that reports raw estimates instead of corrected ones is the misuse to avoid', () => {
  // Pinned so the hazard is visible rather than discovered in production: the
  // scale compounds and saturates at the clamp.
  const counter = createCalibratingCounter()
  for (let turn = 0; turn < 12; turn += 1) counter.observe(100, 125)

  assert.ok(counter.scale > 1.5, `ran away to ${counter.scale}`)
})

test('the correction composes rather than resetting', () => {
  const counter = createCalibratingCounter({ smoothing: 1 })
  counter.observe(100, 200)
  assert.equal(counter.scale, 2)

  // Now the corrected estimate is right, so the scale must hold.
  counter.observe(200, 200)
  assert.equal(counter.scale, 2)
})

test('an absurd observation cannot break the budget', () => {
  const counter = createCalibratingCounter()
  for (let turn = 0; turn < 50; turn += 1) counter.observe(10, 100_000)

  assert.ok(counter.scale <= 2, `clamped to ${counter.scale}`)
})

test('a meaningless observation is ignored', () => {
  const counter = createCalibratingCounter()
  counter.observe(0, 100)
  counter.observe(100, 0)
  counter.observe(100, Number.NaN)

  assert.equal(counter.samples, 0)
  assert.equal(counter.scale, 1)
})

test('the calibrated counter is what a budget should use', () => {
  const counter = createCalibratingCounter({ smoothing: 1 })
  counter.observe(100, 150)

  const messages = [{ text: '制图师把海图折了两次。' }]
  assert.equal(
    counter.countRequest(messages, { templateOverhead: 84 }),
    Math.ceil(estimateRequest(messages, { templateOverhead: 84 }) * 1.5),
  )
})
