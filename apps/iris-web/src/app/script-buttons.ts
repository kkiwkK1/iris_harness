/**
 * Which card-script buttons a bar should show.
 *
 * Split out of `ScriptButtons.tsx` for the reason recorded on
 * `shared-snapshot.ts`: `node --test` cannot load a `.tsx` module at all —
 * Node's type stripping does not do JSX — so logic that needs a test cannot
 * live beside a component. The filtering is the part with rules in it.
 *
 * @module iris-web/app/script-buttons
 */
import type { ScriptView } from '@iris/protocol'

/** One button, resolved to the script that published it. */
export interface ResolvedButton {
  scriptId: string
  scriptName: string
  name: string
}

/**
 * Which buttons a bar should show, in upstream's order.
 *
 * Three filters, orthogonal and applied in this order because each is a
 * different person's decision (`store/iframe_runtimes/script.ts:47-61`):
 *
 * | layer | field | whose choice |
 * | --- | --- | --- |
 * | script | `enabled` | whether the script runs at all |
 * | group | `buttonsEnabled` | the author's switch for this script's whole set |
 * | button | `visible` | this one button |
 *
 * A script contributing no visible buttons is dropped entirely rather than
 * rendered as an empty group, which is what upstream's `.some(b => b.visible)`
 * does — otherwise a card with eight hidden buttons and one shown one would
 * produce eight empty containers.
 *
 * **`visible: false` hides, it does not remove.** `getScriptButtons()` answers
 * with the unfiltered array, so a script can read its own hidden buttons and
 * flip one to `true` to reveal it. Filtering here and only here is what keeps
 * those two facts from contradicting each other.
 * @param scripts - the card's scripts, as the store holds them.
 * @returns the buttons to render, grouped by script in declaration order.
 */
export function visibleButtons(scripts: readonly ScriptView[]): ResolvedButton[] {
  return scripts.flatMap(script => {
    if (!script.enabled) return []
    // Defaults matter and differ: the group switch defaults to **on**, and a
    // button's `visible` has no default at all upstream — it is required.
    if (script.buttonsEnabled === false) return []
    const shown = (script.buttons ?? []).filter(button => button.visible)
    if (shown.length === 0) return []
    return shown.map(button => ({
      scriptId: script.id,
      scriptName: script.name,
      name: button.name,
    }))
  })
}
