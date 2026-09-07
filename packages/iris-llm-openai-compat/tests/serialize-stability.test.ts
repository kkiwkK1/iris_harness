import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

import { serializeRequest } from '../src/serialize.ts'

/**
 * The wire bytes are a function of the request, and of nothing else.
 *
 * DeepSeek's context cache hits on the **request prefix**, in 64-token blocks:
 * `prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens`, and one
 * changed byte makes every token after it a miss. So a field that varies
 * between two otherwise identical requests — a timestamp, a run id, a key that
 * moved because a `Set` iterated differently — is not cosmetic. It is the
 * difference between paying for a prompt once and paying for it every turn.
 *
 * Two rounds of a real conversation can never be byte-identical (the newest
 * exchange is new text), which is exactly why this is the layer to pin: it is
 * the one place where "the same input twice" is a *meaningful* question, and
 * where a defect would be invisible to every other test — the request would
 * still be correct, still be accepted, and still cost four times as much.
 *
 * Measured beside these assertions (`scripts/cache-prefix-probe.mjs`, 2026-09-07,
 * the operator's own profile): assembling one unchanged chat state twice
 * produced byte-identical bodies for 11 of the 15 conversations. The four that
 * did not are card-authored `{{random}}` / `{{roll}}` macros inside world-info
 * entries — the card's own intent, not this layer's.
 *
 * The two instruments below are deliberately different, because each is blind
 * where the other sees. Checked by breaking the serializer both ways:
 * `stream_options: { …, nonce: n += 1 }` fails the byte-equality tests and
 * passes the allow-list (a nested value is not a key); `request_id:
 * \`r-${Date.now()}\`` fails the allow-list and *passes* byte-equality,
 * because three calls in the same millisecond agree.
 */

const BASE: GenerateOptions = {
  provider: 'p',
  model: 'm',
  system: 'A system prompt.',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Hello.' }], source: { kind: 'user' } },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hi.' }],
      source: { provider: 'iris', model: 'history' },
    },
  ],
  temperature: 0.7,
  maxTokens: 512,
  stop: ['\nUser:'],
  sampling: {
    topP: 0.9,
    topK: 40,
    minP: 0.05,
    repetitionPenalty: 1.05,
    frequencyPenalty: 0.1,
    presencePenalty: 0.2,
    seed: 11,
    reasoningEffort: 'high',
  },
} as GenerateOptions

test('one request serializes to the same bytes every time', () => {
  const first = JSON.stringify(serializeRequest(BASE))
  const second = JSON.stringify(serializeRequest(BASE))
  const third = JSON.stringify(serializeRequest(BASE))
  assert.equal(first, second)
  assert.equal(second, third)
})

test('two structurally equal requests serialize to the same bytes', () => {
  // Not the same object: a fresh one, built field by field in a different
  // order. `JSON.stringify` follows insertion order, so a serializer that
  // copied the caller's object instead of naming its own fields would leak the
  // caller's key order onto the wire — and the prefix would break on a request
  // that differs in nothing a model can see.
  const shuffled = {
    messages: BASE.messages,
    model: BASE.model,
    sampling: {
      reasoningEffort: 'high',
      seed: 11,
      presencePenalty: 0.2,
      frequencyPenalty: 0.1,
      repetitionPenalty: 1.05,
      minP: 0.05,
      topK: 40,
      topP: 0.9,
    },
    stop: BASE.stop,
    maxTokens: BASE.maxTokens,
    temperature: BASE.temperature,
    system: BASE.system,
    provider: BASE.provider,
  } as GenerateOptions

  assert.equal(JSON.stringify(serializeRequest(shuffled)), JSON.stringify(serializeRequest(BASE)))
})

test('the body carries no field that changes on its own', () => {
  // A positive statement of the same rule, so a field added later has to be
  // considered rather than silently ride along: these are the only keys the
  // serializer may emit for this request, and every one of them is a function
  // of the input. A new volatile key (a request id, a timestamp, a nonce) fails
  // here with its own name in the message.
  const allowed = new Set([
    'model', 'messages', 'stream', 'stream_options',
    'temperature', 'max_tokens', 'stop',
    'top_p', 'top_k', 'min_p',
    'repetition_penalty', 'frequency_penalty', 'presence_penalty',
    'seed', 'reasoning_effort',
  ])
  const unexpected = Object.keys(serializeRequest(BASE)).filter(key => !allowed.has(key))
  assert.deepEqual(unexpected, [],
    `an unrecognized request field reaches the wire: ${unexpected.join(', ')}. `
    + 'If it varies between two identical turns it breaks DeepSeek prefix caching; '
    + 'if it is stable, add it to this list.')
})

test('a prefix is only shared up to the first changed byte', () => {
  // The property the whole exercise rests on, stated once so the arithmetic in
  // `notes/packages/iris-app-service/CACHE-PREFIX.md` has an executable
  // anchor: text appended at the END keeps the prefix; text inserted anywhere
  // else destroys everything after it, however identical the rest is.
  const appended = JSON.stringify(serializeRequest({
    ...BASE,
    messages: [...BASE.messages, {
      role: 'user',
      content: [{ type: 'text', text: 'And another turn.' }],
      source: { kind: 'user' },
    }],
  } as GenerateOptions))
  const base = JSON.stringify(serializeRequest(BASE))

  // The messages array is not the last key of the body, so appending a message
  // does not literally extend the JSON — which is the point: the shared prefix
  // stops at the point of insertion, not at the end of the array.
  const shared = (() => {
    let index = 0
    while (index < Math.min(base.length, appended.length) && base[index] === appended[index]) index += 1
    return index
  })()
  assert.ok(shared > 0, 'two requests differing only in a tail message share no prefix at all')
  assert.ok(shared < base.length,
    'appending a message left the earlier body a full prefix of the later one, '
    + 'which would mean the serializer puts nothing after `messages`')
})
