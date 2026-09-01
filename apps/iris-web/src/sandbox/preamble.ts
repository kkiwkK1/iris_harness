/**
 * The line prepended to each co-located script so it knows who it is.
 *
 * When a card's scripts share one frame they share one `window`, so a bare
 * `getScriptId()` cannot answer differently for each of them — and sixteen
 * members depend on that answer, either to pick a variable partition or to know
 * whose event listeners to tear down. Getting it wrong is silent: the wrong
 * partition reads as empty, and a teardown that reaches too far reads as an
 * event that never fired.
 *
 * Module scope is what makes this cheap. Each script is its own
 * `<script type="module">`, and a `const` at module top level **shadows the
 * global of the same name** for that module alone. So each script destructures
 * its own bound copies from a per-script registry, and its siblings never see
 * them.
 *
 * **Exactly one line.** A card's syntax error is reported by line number, and
 * every line the preamble adds is a line the author has to subtract before their
 * own file makes sense. One is the smallest constant offset that still works —
 * the bindings have to precede the body, because putting them last would leave
 * the card's own statements reading them in the temporal dead zone.
 *
 * @module iris-web/sandbox/preamble
 */
import { identityMembers } from './identity.ts'

/**
 * The global a co-located script reads its own bindings from.
 *
 * Deliberately not hidden. Within one card the scripts already share a realm and
 * can reach each other by construction, so concealing this would buy no
 * isolation that the realm has not already given away — it would only make the
 * mechanism harder to recognise in a stack trace.
 */
export const SCRIPT_REGISTRY = '__iris_script__'

/**
 * Build the preamble that binds one script's identity-bearing members.
 *
 * @param scriptId - the script this module belongs to, or undefined for a body
 *   with no entry in the host's list.
 * @returns a single line of module-scope declarations, ending in a newline.
 */
export function preambleFor(scriptId: string | undefined): string {
  const names = identityMembers().join(',')
  // The id is embedded as JSON so a quote or backslash in it cannot end the
  // literal and start being code. Ids come from the host, but a value that
  // reaches an eval boundary is escaped on principle, not on provenance.
  const argument = scriptId === undefined ? 'undefined' : JSON.stringify(scriptId)
  return `const {${names}} = globalThis.${SCRIPT_REGISTRY}(${argument});\n`
}

/**
 * Prepend the preamble to a script body.
 * @param scriptId - the script's id, or undefined when it has none.
 * @param body - the card's own source, already fence-stripped.
 * @returns the module source to evaluate.
 */
export function withPreamble(scriptId: string | undefined, body: string): string {
  return preambleFor(scriptId) + body
}

/**
 * How many lines the preamble shifts a card's own source by.
 *
 * Exported so error reporting can subtract it rather than hard-coding a number
 * that would drift the moment the preamble grew.
 */
export const PREAMBLE_LINES = 1
