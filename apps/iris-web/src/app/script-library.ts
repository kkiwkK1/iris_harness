/**
 * Reading and writing a 酒馆助手 script file.
 *
 * The import/export half of the library, kept apart from the panel because it
 * is the part with a *format* behind it — one that has to match an install
 * closely enough that a file crosses in both directions — and because that is
 * testable without rendering anything.
 *
 * All of it is read from the 酒馆助手 4.9.1 source on this machine
 * (`data/default-user/extensions/JS-Slash-Runner/src/`), not from
 * documentation:
 *
 * - one **object** per file, not an array (`panel/script/Toolbar.vue:87-95`) —
 *   the opposite of the regex export, whose bulk form is an array, and getting
 *   it wrong would mean writing files an install refuses;
 * - the filename is `酒馆助手脚本-<name>.json` (`panel/script/ScriptItem.vue:180`);
 * - the body is the whole `Script` object at **two-space** indent
 *   (`ScriptItem.vue:181`), where the regex export uses four;
 * - an import forces `enabled = false` and mints a fresh `id`
 *   (`Toolbar.vue:94-95`).
 *
 * @module iris-web/app/script-library
 */

import type { UserScript } from '@iris/protocol'

import type { UserScriptDraft } from '../client/store.ts'

/**
 * Whether a parsed file is one script this shell can import.
 *
 * The three fields the feature cannot work without: something to call it,
 * something to run, and the discriminator that tells a script from a folder.
 * `type` is checked **when present** rather than required, because upstream's
 * schema defaults it (`z.literal('script').default('script')`) and an older
 * export can legitimately lack it — but a file that says `folder` is refused
 * rather than half-imported, since a folder's scripts live in a `scripts` array
 * this host does not carry and importing the wrapper would silently drop them.
 * @param value - the parsed file.
 * @returns true when it can be imported.
 */
export function isUserScriptFile(value: unknown): value is UserScript {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (row['type'] !== undefined && row['type'] !== 'script') return false
  return typeof row['name'] === 'string' && row['name'].length > 0
    && typeof row['content'] === 'string'
}

/**
 * One imported file as a save draft.
 *
 * The `id` is **dropped**, not carried, which is upstream's own behaviour
 * (`Toolbar.vue:95` re-mints it): importing the same file twice is how a user
 * *duplicates* a script, and keeping the id would turn that into a silent
 * overwrite — or, here, into a `not-found` refusal against a repository the
 * file was never in.
 *
 * `enabled` is dropped for the same reason it is `false` by default: a file
 * that arrived switched on would begin executing on the next chat the user
 * opened, before they had read a line of it.
 * @param file - the parsed file, already checked.
 * @returns the draft to save.
 */
export function scriptImportDraft(file: UserScript): UserScriptDraft {
  const { id: _id, enabled: _enabled, ...rest } = file
  return {
    ...rest,
    name: file.name,
    content: file.content,
    enabled: false,
  }
}

/**
 * The filename an export lands under.
 *
 * Upstream's own words, `酒馆助手脚本-<name>.json`, through the same kind of
 * sanitisation its `getSanitizedFilename` applies — so a file written here is
 * one an install will offer to import under the name the user recognises.
 * @param script - the script being exported.
 * @returns a safe filename.
 */
export function scriptExportName(script: UserScript): string {
  const stem = script.name.replace(NAME_UNSAFE, '_') || 'script'
  return `酒馆助手脚本-${stem}.json`
}

/**
 * Characters no filename may carry.
 *
 * The Unicode property escapes rather than an explicit control-character
 * range, which is what `paths.ts` uses on the host side for the same job. A
 * superset of what upstream strips, in the direction that produces a filename a
 * filesystem accepts.
 */
const NAME_UNSAFE = /[\s<>:"/\\|?*\p{Cc}\p{Cf}]/gu

/**
 * Write one script to the reader's downloads folder.
 *
 * **Whole**, including `data` and `export_with`. Upstream offers to strip the
 * variable table and the buttons on the way out (`panel/script/ScriptExport.vue`)
 * and this does not, which is a real divergence: someone sharing a script they
 * have been running will share its accumulated variables with it. Recorded in
 * `notes/apps/iris-web/DEVIATIONS.md` §65 rather than papered over — and the
 * reason it is not fixed by *always* stripping is that a table is sometimes the
 * script's shipped data, and dropping it would export something that does not
 * run.
 * @param script - the script being exported.
 */
export function exportScriptFile(script: UserScript): void {
  const body = JSON.stringify(script, null, 2)
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = scriptExportName(script)
  link.click()
  URL.revokeObjectURL(url)
}
