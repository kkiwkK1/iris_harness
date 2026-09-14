/**
 * The host-side mapping between Iris's contribution pipeline and the bridge's
 * generate round. Pure: contributions in, payload out, validated results
 * written back. The service wiring (central commit) calls these from
 * `#contributions` / `#previewItemization` — the one place itemization and the
 * sent prompt agree — so an expansion applied here is what the model sees AND
 * what `prompt.itemize` records.
 *
 * The upstream semantic this preserves: `processGenerateAfter` rewrites each
 * message's content independently (`CHAT_COMPLETION_SETTINGS_READY` receives
 * the message array and the extension mutates entries in place). Iris's
 * contributions are the pre-assembly units of exactly those messages, so the
 * pilot expands per-contribution and lets the assembly carry the result — one
 * bridge round per generation, not two.
 */

import type { StBridgeMessage, StGenerateResult } from '../runtime/protocol.ts'
import { validateGenerateResult } from '../runtime/protocol.ts'

/**
 * The one member of an Iris contribution this module touches. Structural on
 * purpose: the compat package keeps its no-app-service fence, and the write
 * back needs the identity of the object plus its text — nothing else.
 */
export interface ContributionLike {
  text: string
}

/**
 * The cheap gate the native template path also uses: no `<%` opener anywhere,
 * no bridge round. The extension compiles and scans quickly, but skipping the
 * roundtrip keeps unarmed-style latency at zero even when armed.
 */
export function contributionsHaveTemplates(contributions: readonly ContributionLike[]): boolean {
  return contributions.some(contribution => contribution.text.includes('<%'))
}

/** Map contributions to the message array the extension receives. */
export function bridgeMessagesFromContributions(contributions: readonly ContributionLike[]): StBridgeMessage[] {
  return contributions.map(contribution => ({ role: 'system', content: contribution.text }))
}

/**
 * Write a validated generate result back onto the contributions. The mapping
 * is positional by construction — the payload was built from this array — so
 * a length mismatch is refused before anything is touched, and a contribution
 * whose text the extension did not change keeps its exact bytes.
 *
 * Depth-bucket members are left alone on purpose: `Contribution.text` stays
 * authoritative ("the text stays authoritative", iris-pipeline), and members
 * exist for cache classification of the pre-join parts.
 */
export function applyGenerateResultToContributions(
  contributions: readonly ContributionLike[],
  result: StGenerateResult,
): { applied: number } {
  const check = validateGenerateResult(result, contributions.length)
  if (!check.ok) throw new Error(`st-compat bridge: generate result refused — ${check.why}`)
  let applied = 0
  for (const [index, contribution] of contributions.entries()) {
    const message = result.messages[index]
    if (message === undefined) continue
    if (message.content !== contribution.text) {
      contribution.text = message.content
      applied += 1
    }
  }
  return { applied }
}
