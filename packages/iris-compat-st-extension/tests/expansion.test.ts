import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applyGenerateResultToContributions,
  bridgeMessagesFromContributions,
  contributionsHaveTemplates,
  type ContributionLike,
} from '../src/host/expansion.ts'

function contribution(text: string): ContributionLike & Record<string, unknown> {
  return { id: Math.random().toString(36).slice(2), text }
}

test('the template gate keys on the EJS opener', () => {
  assert.equal(contributionsHaveTemplates([contribution('plain text')]), false)
  assert.equal(contributionsHaveTemplates([contribution("你是我信赖的朋友。"), contribution("<% if (getvar('好感度') > 50) { %>")]), true)
})

test('contributions map positionally onto bridge messages', () => {
  const contributions = [contribution('system block'), contribution('<%= getvar("好感度") %>')]
  const messages = bridgeMessagesFromContributions(contributions)
  assert.deepEqual(messages, [
    { role: 'system', content: 'system block' },
    { role: 'system', content: '<%= getvar("好感度") %>' },
  ])
})

test('a changed message rewrites the contribution text; an unchanged one keeps its bytes', () => {
  const original = "<% if (getvar('好感度', { defaults: 0 }) > 50) { %>\n你是我信赖的朋友。\n<% } else { %>\n我仍然对你保持警惕。\n<% } %>"
  const expanded = '你是我信赖的朋友。'
  const touched = contribution('other text')
  const contributions = [contribution(original), touched]
  const applied = applyGenerateResultToContributions(contributions, {
    kind: 'generate',
    messages: [
      { role: 'system', content: expanded },
      { role: 'system', content: 'other text' },
    ],
    chatVariables: {},
    globalVariables: {},
  })
  assert.equal(applied.applied, 1)
  assert.equal(contributions[0]!.text, expanded)
  assert.equal(contributions[1]!.text, 'other text')
})

test('a result with the wrong length is refused before anything is touched', () => {
  const contributions = [contribution('a'), contribution('b')]
  assert.throws(
    () => applyGenerateResultToContributions(contributions, {
      kind: 'generate',
      messages: [{ role: 'system', content: 'only one' }],
      chatVariables: {},
      globalVariables: {},
    }),
    /does not match the 2 contributions/,
  )
  assert.equal(contributions[0]!.text, 'a')
  assert.equal(contributions[1]!.text, 'b')
})
