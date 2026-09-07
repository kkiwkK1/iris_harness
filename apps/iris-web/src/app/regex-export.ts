/**
 * Writing a regex rule to a file.
 *
 * Its own module, and a `.ts` one: `node --test` strips types from `.ts` and
 * refuses `.tsx`, so a function that needs a unit test cannot live beside a
 * component. The filename convention is the part that actually needs pinning —
 * a rule exported from here has to land under the name a SillyTavern install
 * expects, or the migration path only runs one way.
 *
 * @module iris-web/app/regex-export
 */

import type { RegexScriptView } from '@iris/protocol'

/**
 * The filename an export lands under, spelled the way upstream spells it.
 *
 * `regex-` plus the rule's name through its own `sanitizeFileName` (illegal
 * characters to `_`, then lowercased — `extensions/regex/index.js:19`). A rule
 * exported from here and imported into SillyTavern arrives under the name that
 * install expects.
 * @param script - the rule being exported.
 * @returns a safe filename.
 */
/**
 * The characters upstream's `sanitizeFileName` replaces with `_`.
 *
 * Upstream spells the control characters as an explicit range,
 * `\u0000-\u001F` plus `\u007F` (`extensions/regex/index.js:19`). This uses
 * the Unicode property escape instead — `paths.ts`'s own idiom for the same
 * job — because it says what it means and because the explicit form does not
 * survive being written by every tool that touches this file.
 *
 * `\p{Cc}` is a **superset**: it also covers the C1 controls at `\u0080`-
 * `\u009F`, which upstream would leave in a filename. Divergent in principle
 * and not in practice — no filesystem accepts them either — and in the
 * direction that produces a usable filename rather than a rejected one.
 */
const NAME_UNSAFE = /[\s.<>:"/\\|?*\p{Cc}\p{Cf}]/gu

export function regexExportName(script: RegexScriptView): string {
  const stem = (script.scriptName ?? 'script')
    .replace(NAME_UNSAFE, '_')
    .toLowerCase()
  return `regex-${stem}.json`
}

/**
 * Write one rule to the reader's downloads folder.
 *
 * Four-space JSON, matching what upstream's export writes
 * (`JSON.stringify(script, null, 4)`) — so a file that goes out of here can go
 * straight back into an install without showing up as a full-file diff there.
 * The rule is written **whole**, including keys this shell never renders, which
 * is what makes the export of a card's own rule a usable starting point for a
 * global one.
 * @param script - the rule being exported.
 */
export function exportRegexFile(script: RegexScriptView): void {
  const body = JSON.stringify(script, null, 4)
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = regexExportName(script)
  link.click()
  URL.revokeObjectURL(url)
}
