import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { UserScript } from '@iris/protocol'

import { isUserScriptFile, scriptExportName, scriptImportDraft } from '../src/app/script-library.ts'

/**
 * The 酒馆助手 script file, read and written.
 *
 * Everything asserted here comes from the 酒馆助手 4.9.1 source on this machine
 * (`data/default-user/extensions/JS-Slash-Runner/src/`), not from
 * documentation, and the file format is where getting it wrong is silent: an
 * import that accepted the wrong shape half-lands, and an export written in the
 * wrong shape is refused by an install with no explanation the user can act on.
 *
 * The two that would be easy to get backwards:
 *
 * - a script file is **one object**, where the regex bulk export is an array;
 * - a folder export is a different shape whose scripts live in a nested array,
 *   and importing the wrapper would drop every script inside it.
 */

/** A file in the shape upstream's exporter writes. */
function file(over: Partial<UserScript> = {}): UserScript {
  return {
    type: 'script',
    id: 'from-an-install',
    name: '快捷骰子',
    content: 'console.log(1)\n',
    info: 'notes',
    enabled: true,
    button: { enabled: true, buttons: [{ name: 'go', visible: true }] },
    data: { counter: 3 },
    export_with: { data: true, button: true },
    ...over,
  }
}

test('a script file is accepted, and an array is not', () => {
  assert.equal(isUserScriptFile(file()), true)
  // The regex export's bulk shape. Accepting it here would import the array's
  // first script and silently drop the rest, or import nothing at all.
  assert.equal(isUserScriptFile([file()]), false)
  assert.equal(isUserScriptFile(null), false)
  assert.equal(isUserScriptFile('a string'), false)
})

test('a folder export is refused rather than half-imported', () => {
  // Upstream's `ScriptFolder` (`type/scripts.ts:36-45`): the scripts are in a
  // nested `scripts` array, and this host carries no folders. Importing the
  // wrapper would store a script with no body and lose the ones inside.
  const folder = { type: 'folder', name: 'a folder', enabled: false, scripts: [file()] }
  assert.equal(isUserScriptFile(folder), false)

  /*
   * And the **discriminator** is what refuses it, not the missing body.
   *
   * The case above passed with the `type` check deleted — a real folder has no
   * `content`, so the body check rejected it and the assertion was right for
   * the wrong reason. This one carries a `content`, which a hand-edited or
   * hand-assembled file can, so only the discriminator can turn it away.
   */
  const shaped = { type: 'folder', name: 'a folder', content: '', scripts: [file()] }
  assert.equal(isUserScriptFile(shaped), false, 'a folder was accepted because it happened to carry a body')
})

test('an older file with no type is accepted, because upstream defaults it', () => {
  // `z.literal('script').default('script')`, so a file written before the
  // discriminator existed legitimately lacks it. Refusing it would turn a
  // working import into "that file is not a script export".
  const { type: _type, ...older } = file()
  assert.equal(isUserScriptFile(older), true)
})

test('a file with no name or no body is refused', () => {
  assert.equal(isUserScriptFile(file({ name: '' })), false)
  const { content: _content, ...bodiless } = file()
  assert.equal(isUserScriptFile(bodiless), false)
})

test('an import drops the identity and arrives switched off', () => {
  const draft = scriptImportDraft(file())
  // Upstream re-mints the id on import (`panel/script/Toolbar.vue:95`), so
  // importing the same file twice *duplicates* a script rather than silently
  // overwriting one — and here, an id carried over would name a script that is
  // not in the repository being written to, which the host refuses.
  assert.equal(draft.id, undefined, 'the imported identity was carried, so a re-import would collide')
  // And it does not begin executing on the next chat the reader opens, before
  // they have read a line of it. Upstream forces the same.
  assert.equal(draft.enabled, false)
})

test('an import keeps the fields no control edits, so a round trip is lossless', () => {
  const draft = scriptImportDraft(file())
  assert.deepEqual(draft['data'], { counter: 3 }, 'the variable table was dropped on import')
  assert.deepEqual(draft['export_with'], { data: true, button: true })
  assert.deepEqual(draft.button, { enabled: true, buttons: [{ name: 'go', visible: true }] })
  assert.equal(draft.info, 'notes')
})

test('an export lands under the filename an install offers to import', () => {
  // Upstream's own words (`panel/script/ScriptItem.vue:180`).
  assert.equal(scriptExportName(file()), '酒馆助手脚本-快捷骰子.json')
  assert.equal(scriptExportName(file({ name: 'a/b:c' })), '酒馆助手脚本-a_b_c.json')
  // Unlike the regex export, the name is **not** lowercased: upstream's
  // `getSanitizedFilename` does not, and `sanitizeFileName` does. Two adjacent
  // conventions, and a shared helper would have quietly picked one.
  assert.equal(scriptExportName(file({ name: 'Dice Roller' })), '酒馆助手脚本-Dice_Roller.json')
})
