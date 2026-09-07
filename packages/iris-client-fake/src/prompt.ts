/**
 * A prompt itemization the panel can be designed against.
 *
 * Honest to model, unlike the script bridge: a breakdown is arithmetic over
 * labelled parts, and inventing plausible parts teaches the interface nothing
 * false. The script context was the opposite — a fabricated one would let a
 * runner pass here and fail on the first real card.
 *
 * The fixture reproduces properties measured across six real presets, not a tidy
 * shape. Three of them exist here specifically to give the design something to be
 * wrong about:
 *
 * 1. **Skew.** The largest single part held 23%–92% of the prompt depending on the
 *    preset, so a uniform bar chart answers the wrong question at one end and a
 *    "one column plus rubble" assumption is wrong at the other. This fixture sits
 *    at the skewed end, because that is the end where a naive equal-width list
 *    looks fine and is useless.
 * 2. **Most identifiers are UUIDs.** 29 of one preset's 41 prompts identify
 *    themselves that way, which is why the contract carries a separate `label`
 *    and why a panel rendering `id` would be unreadable. Two entries here share a
 *    label with different ids, so the reason for carrying both is visible in
 *    development rather than discovered on a real preset.
 * 3. **Zero-token entries are normal.** 14 of one preset's 53 were zero — markers
 *    with nothing to fill them, enabled prompts with empty content. A panel that
 *    hides them cannot answer "why did my part not get through".
 *
 * @module @iris/client-fake/prompt
 */

import type { PromptItemEntry, PromptItemization } from '@iris/protocol'

/**
 * The budget the seeded conversation assembles under.
 *
 * One constant read by both the itemization and `ChatView.budget`, because a
 * fixture where those two disagreed would make the composer's capacity meter
 * and the prompt panel's percentage report different fullnesses for the same
 * conversation — and the whole point of the two dividing by `context - reserve`
 * is that they cannot.
 */
export const FAKE_BUDGET: { context: number, reserve: number } = { context: 8192, reserve: 1024 }

/** The entries, in assembly order rather than sorted — sorting is the UI's business. */
const ENTRIES: readonly PromptItemEntry[] = [
  { id: 'main', label: 'Main Prompt', kind: 'system', tokens: 148 },
  { id: '881044e5-cbef-4a1c-9b3d-2f0e6a7c5d31', label: '开始设定', kind: 'system', tokens: 96 },
  { id: 'charDescription', label: 'Char Description', kind: 'system', tokens: 233 },
  { id: 'charPersonality', label: 'Char Personality', kind: 'system', tokens: 61 },
  { id: 'scenario', label: 'Scenario', kind: 'system', tokens: 74 },
  { id: 'c7f2b1a4-9e83-4d52-b6a0-1c4e8f3a7b95', label: '写作模式（二选一）', kind: 'system', tokens: 118 },
  { id: 'a3e91f27-5d64-4b08-8c1f-7e2a9d5c3f84', label: '写作模式（二选一）', kind: 'system', tokens: 102 },
  { id: 'worldInfoBefore', label: 'World Info (before)', kind: 'system', tokens: 1920 },
  { id: 'worldInfoAfter', label: 'World Info (after)', kind: 'system', tokens: 37 },
  { id: 'd5b8c3a1-2f47-4e69-9a05-8b6d1c4f7e23', label: '状态栏格式', kind: 'depth', tokens: 84, depth: 0, role: 'system' },
  { id: 'authorsNote', label: "Author's Note", kind: 'depth', tokens: 29, depth: 2, role: 'system' },
  // Parsed, enabled, and contributing nothing. The case a reader goes looking for.
  { id: 'nsfw', label: 'Auxiliary Prompt', kind: 'system', tokens: 0 },
  { id: 'e4a7c209-6b31-4f85-a0d2-3c9e7b1a5f68', label: '开场引导', kind: 'system', tokens: 0 },
  { id: 'chatHistory', label: 'Chat History', kind: 'history', tokens: 27 },
]

/**
 * Build an itemization.
 *
 * `tokens` is computed from the entries rather than stated, because the contract
 * requires them to add up and a fixture that disagreed with its own total would
 * be teaching the panel to distrust the arithmetic it is displaying.
 * @param turn - the turn being itemized.
 * @param preview - whether this describes the next request rather than a record.
 * @returns the itemization.
 */
export function fakeItemization(turn: number, preview: boolean): PromptItemization {
  const entries = ENTRIES.map(entry => ({ ...entry }))
  const tokens = entries.reduce((sum, entry) => sum + entry.tokens, 0)

  return {
    turn,
    entries,
    tokens,
    // Present only for a record: a preview has no provider reply to have
    // reported anything. Deliberately a few tokens off the estimate — the point
    // of showing both is to answer "is the estimate trustworthy", and a fixture
    // where they match exactly would hide the case the field exists for.
    ...(preview ? {} : { actualTokens: tokens + 46 }),
    budget: { ...FAKE_BUDGET },
    droppedHistory: preview ? 0 : 3,
    overBudget: false,
    preview,
  }
}
