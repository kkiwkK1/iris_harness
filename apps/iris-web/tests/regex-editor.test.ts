import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { RegexScriptView } from '@iris/protocol'

import {
  applyDraft,
  draftOf,
  emptyDraft,
  regexDraftProblems,
} from '../src/app/regex-editor.ts'
import { regexExportName } from '../src/app/regex-export.ts'

/**
 * The rule editor's form, as data.
 *
 * The property that matters is the **round trip**: a rule opened in the editor,
 * looked at and saved must be the rule that arrived. This shell renders twelve
 * of upstream's fields and the corpus's rules carry keys it has never heard of
 * — the storage contract is verbatim because the list is the migration path
 * from a SillyTavern install, and an editor that rebuilt a rule from its own
 * fields would strip whatever an extension had added the first time someone
 * fixed a typo in a name.
 */

/** A rule in the shape the corpus's 173 scoped rules are in, plus a stranger. */
function stored(over: Partial<RegexScriptView> = {}): RegexScriptView {
  return {
    id: 'a-rule',
    scriptName: 'hide the bookkeeping',
    findRegex: '/<UpdateVariable>[\\s\\S]*?<\\/UpdateVariable>/g',
    replaceString: '',
    trimStrings: ['「', '」'],
    placement: [1, 2],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 2,
    minDepth: 0,
    maxDepth: 4,
    'some-future-key': { nested: [1, 2, 3] },
    ...over,
  } as unknown as RegexScriptView
}

test('a rule opened and saved unchanged is the rule that arrived', () => {
  const before = stored()
  const after = applyDraft(before, draftOf(before))
  assert.deepEqual(after, before)
})

test('a field the editor does not render survives being opened and saved', () => {
  // The assertion `deepEqual` above already covers, stated on its own because
  // this is the one the whole `applyDraft(base, draft)` signature exists for:
  // a rebuild-from-fields implementation passes every other test in this file.
  const before = stored()
  const after = applyDraft(before, { ...draftOf(before), scriptName: 'renamed' })
  assert.deepEqual(after['some-future-key'], { nested: [1, 2, 3] })
  assert.equal(after.scriptName, 'renamed')
  assert.equal(after.id, 'a-rule', 'the identity moved, so the save would create a duplicate')
})

test('an empty depth field is stored as null, which is what an install writes', () => {
  // Upstream's editor writes `parseInt('')`, i.e. `NaN`, and `JSON.stringify`
  // turns that into `null`. Both are accepted by the engine's
  // `!isNaN(x) && x !== null` guard; `null` is the one a file carries.
  const draft = { ...draftOf(stored()), minDepth: '', maxDepth: '' }
  const saved = applyDraft(stored(), draft)
  assert.equal(saved.minDepth, null)
  assert.equal(saved.maxDepth, null)
})

test('depth 0 is a real value and does not read as unlimited', () => {
  // The reason the form holds depths as strings. 0 means "the last message",
  // and a number-typed field would make it indistinguishable from empty.
  assert.equal(draftOf(stored({ minDepth: 0 })).minDepth, '0')
  assert.equal(applyDraft({}, { ...emptyDraft(), minDepth: '0' }).minDepth, 0)
  assert.equal(draftOf(stored({ minDepth: null })).minDepth, '')
  // -1 is upstream's permissive sentinel for minDepth and a real stored value.
  assert.equal(applyDraft({}, { ...emptyDraft(), minDepth: '-1' }).minDepth, -1)
})

test('trim strings go through the textarea one per line, and blank lines are dropped', () => {
  assert.equal(draftOf(stored()).trimStrings, '「\n」')
  const saved = applyDraft({}, { ...emptyDraft(), trimStrings: 'a\n\nb\n' })
  // A trailing newline would otherwise become an empty trim string, which
  // `replaceAll('')` matches everywhere. Upstream filters the same way.
  assert.deepEqual(saved.trimStrings, ['a', 'b'])
})

test('a new rule starts on upstream’s own defaults', () => {
  // `extensions/regex/index.js:797-809`: display-only, run-on-edit, and User
  // Input as the single placement. Reproduced rather than improved on, so a
  // rule written here and exported to an install is the rule that install's own
  // editor would have produced — and because display-only is the direction that
  // does not rewrite the chat file.
  const fresh = emptyDraft()
  assert.deepEqual(fresh.placement, [1])
  assert.equal(fresh.markdownOnly, true)
  assert.equal(fresh.runOnEdit, true)
  assert.equal(fresh.promptOnly, false)
  assert.equal(fresh.substituteRegex, 0)
})

test('placements are stored sorted, so two equal rules compare equal', () => {
  const saved = applyDraft({}, { ...emptyDraft(), placement: [6, 1, 2] })
  assert.deepEqual(saved.placement, [1, 2, 6])
})

// ── what a rule would fail to do ────────────────────────────────────────────

test('a rule with no placement or no pattern is reported as never matching', () => {
  assert.deepEqual(
    regexDraftProblems({ ...emptyDraft(), placement: [], findRegex: '' }),
    ['noPlacement', 'noPattern'],
  )
  // And a complete rule reports nothing, which is what makes the two above a
  // signal rather than decoration.
  assert.deepEqual(regexDraftProblems({ ...emptyDraft(), findRegex: '/x/' }), [])
})

test('a world-info rule without “what the model reads” is reported', () => {
  // World info is scanned with `{ isPrompt: true, isMarkdown: false }`
  // (`world-info.js:5086`), so the only branch of the engine's ephemerality
  // gate that can fire is the `promptOnly` one. Upstream says this in a tooltip
  // and enforces it nowhere.
  const draft = { ...emptyDraft(), findRegex: '/x/', placement: [5] }
  assert.deepEqual(regexDraftProblems(draft), ['worldInfoNeedsPrompt'])
  assert.deepEqual(regexDraftProblems({ ...draft, promptOnly: true }), [])
})

test('a slash-command rule with either ephemerality flag is reported', () => {
  /*
   * The one worth catching, because upstream's defaults pre-make it: all four
   * slash-command call sites pass no flags, so only the "neither" branch can
   * fire — and a new rule arrives with `markdownOnly` ticked. So a freshly
   * created slash-command rule silently never runs, and nothing anywhere says
   * so.
   */
  const draft = { ...emptyDraft(), findRegex: '/x/', placement: [3] }
  assert.equal(draft.markdownOnly, true, 'the default this case is about has changed')
  assert.deepEqual(regexDraftProblems(draft), ['slashNeedsNeither'])
  assert.deepEqual(
    regexDraftProblems({ ...draft, markdownOnly: false, promptOnly: true }),
    ['slashNeedsNeither'],
    'prompt-only was accepted for a slash-command rule',
  )
  assert.deepEqual(regexDraftProblems({ ...draft, markdownOnly: false }), [])
})

// ── the export file ─────────────────────────────────────────────────────────

test('an export lands under the filename a SillyTavern install expects', () => {
  // `regex-` plus the name through upstream's own `sanitizeFileName`: illegal
  // characters to `_`, then lowercased (`extensions/regex/index.js:19`).
  assert.equal(regexExportName(stored({ scriptName: 'Hide Blocks' })), 'regex-hide_blocks.json')
  assert.equal(regexExportName(stored({ scriptName: 'a/b:c*d' })), 'regex-a_b_c_d.json')
  // A CJK name is kept: `：` is U+FF1A, a letterlike character every filesystem
  // stores happily, and a rule written from memory as "no colons" would have
  // replaced it. The same measurement `paths.ts` records.
  assert.equal(regexExportName(stored({ scriptName: '状态栏隐藏' })), 'regex-状态栏隐藏.json')
})
