import test from 'node:test'
import assert from 'node:assert/strict'

import { buildExport, parseSettingsExport, transferDevice } from '../src/app/settings-transfer.ts'
import type { ExportInput } from '../src/app/settings-transfer.ts'

/**
 * The settings file: one export carries the whole surface, one import applies
 * it. The assertions here are the round trip the drawer promises — build,
 * serialise, parse, and the same values come back — plus the two properties
 * the format exists to guarantee: a foreign file is refused whole, and no
 * credential can ride in a connection profile.
 */

function input(overrides: Partial<ExportInput> = {}): ExportInput {
  return {
    chatId: undefined,
    theme: 'dark',
    reading: { size: 19, measure: 72, floors: true },
    language: 'zh',
    autoOpenChat: false,
    generation: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      temperature: 0.7,
      maxTokens: 2048,
      trimSentences: true,
      continuePostfix: 'double',
      stop: ['\nUser:'],
    },
    worldbook: undefined,
    connections: [
      {
        id: 'c1',
        summary: 'deepseek · deepseek-chat',
        provider: 'deepseek',
        model: 'deepseek-chat',
        baseURL: 'https://api.example.com/v1',
        label: 'main',
        sampling: { temperature: 0.9 },
        hasKey: true,
        keyTail: 'ab12',
      },
      {
        id: 'c2',
        summary: 'local · qwen3-8b',
        provider: 'custom',
        model: 'qwen3-8b',
      },
    ],
    ...overrides,
  }
}

test('an export round-trips: build, serialise, parse, same values', () => {
  const file = buildExport(input())
  const parsed = parseSettingsExport(JSON.stringify(file))
  assert.deepEqual(parsed, { ok: true, data: file })

  // And the values a reader exported are the values an import applies.
  assert.equal(parsed.ok && parsed.data.generation.temperature, 0.7)
  assert.equal(parsed.ok && parsed.data.generation.continuePostfix, 'double')
  assert.deepEqual(parsed.ok && parsed.data.device.reading, { size: 19, measure: 72, floors: true })
  assert.equal(parsed.ok && parsed.data.device.language, 'zh')
  assert.equal(parsed.ok && parsed.data.device.autoOpenChat, false)
  assert.equal(parsed.ok && parsed.data.scope.chatId, null)
})

test('an export carries no credential', () => {
  const file = buildExport(input())
  const text = JSON.stringify(file)
  // The projection has no field a key could hide in, so the flag and the tail
  // are gone with it.
  assert.equal(text.includes('hasKey'), false)
  assert.equal(text.includes('keyTail'), false)
  assert.equal(text.includes('ab12'), false)
  // What remains is what an import needs to rebuild the profile.
  assert.deepEqual(file.connections[0], {
    provider: 'deepseek',
    model: 'deepseek-chat',
    baseURL: 'https://api.example.com/v1',
    label: 'main',
    sampling: { temperature: 0.9 },
  })
})

test('the world-book section carries the selection and the scan settings', () => {
  const file = buildExport(input({
    worldbook: {
      settings: { scanDepth: 4, budgetPercent: 40, budgetCap: 0, minActivations: 0, minActivationsDepthMax: 0, maxRecursionSteps: 0, insertionStrategy: 'evenly', recursive: true, caseSensitive: false, matchWholeWords: true, useGroupScoring: false } as never,
      globalSelect: ['Main Book'],
    },
  }))
  assert.deepEqual(file.worldbook?.globalSelect, ['Main Book'])
  assert.equal((file.worldbook?.settings as { scanDepth?: number }).scanDepth, 4)
})

test('a file that does not name the format is refused whole', () => {
  assert.deepEqual(parseSettingsExport('not json at all'), { ok: false, reason: 'bad-json' })
  assert.deepEqual(parseSettingsExport('[]'), { ok: false, reason: 'bad-format' })
  assert.deepEqual(parseSettingsExport('{"format": "other", "version": 1}'), { ok: false, reason: 'bad-format' })
  assert.deepEqual(
    parseSettingsExport('{"format": "iris.settings", "version": 1}'),
    { ok: false, reason: 'bad-format' },
    'a file with no device section is half a file',
  )
})

test('imported device choices are held to the same ranges the live controls are', () => {
  const device = transferDevice({
    theme: 'plaid' as never,
    reading: { size: 999, measure: 3, floors: 'yes' as never },
    language: 'fr' as never,
    autoOpenChat: undefined as never,
  })
  assert.equal(device.theme, 'system')
  assert.equal(device.language, 'en')
  assert.equal(device.autoOpenChat, true, 'an absent startup choice is the shell default: open')
  // Clamped, not refused: a bad preference is not a reason to discard a file.
  assert.equal(device.reading.size, 22)
  assert.equal(device.reading.measure, 48)
  assert.equal(device.reading.floors, false)
})
