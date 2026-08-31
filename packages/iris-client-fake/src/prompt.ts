/**
 * A prompt itemization the panel can be designed against.
 *
 * Honest to model, unlike the script bridge: a breakdown is arithmetic over
 * labelled parts, and inventing plausible parts teaches the interface nothing
 * false. The script context was the opposite — a fabricated one would let a
 * runner pass here and fail on the first real card.
 *
 * The fixture reproduces the **shape** measured on a real preset and card, not a
 * tidy one. Two properties of that measurement drive the design and so are
 * deliberately preserved here:
 *
 * 1. **It is not a list of comparable parts.** 1920 of 2929 tokens — 66% — sat in
 *    a single world-info injection. The panel is mostly one column and a pile of
 *    rubble, so a uniform bar chart would answer the wrong question.
 * 2. **Most identifiers are UUIDs.** 29 of the preset's 41 prompts identify
 *    themselves that way, which is why the contract carries a separate `label`
 *    and why a panel rendering `id` would be unreadable.
 *
 * @module @iris/client-fake/prompt
 */

import type { PromptItemEntry, PromptItemization } from '@iris/protocol'

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
    budget: { context: 8192, reserve: 1024 },
    droppedHistory: preview ? 0 : 3,
    overBudget: false,
    preview,
  }
}
