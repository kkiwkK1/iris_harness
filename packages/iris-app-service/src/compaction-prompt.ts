/**
 * The words that ask a model to condense a scene.
 *
 * **Its own file so it can be edited without reading the machinery.** The
 * boundary arithmetic, the durability record and the shrink guard live in
 * `./compaction.ts`; nothing in this file decides anything, and changing the
 * prose here cannot change which floors get compacted.
 *
 * Transcribed from deepseek-harness (MIT),
 * `packages/compaction/compaction-basic/src/summarizer.ts` — its
 * `COMPACTION_INSTRUCTION`, `CHECKPOINT_PREAMBLE` and the two tags that wrap a
 * landed checkpoint. Three properties of the original are kept because they are
 * the reason it works, not decoration:
 *
 * 1. **The instruction is the FINAL user message, after the replayed
 *    conversation** — not a summarizer system prompt in front of it. That makes
 *    the auxiliary call a genuine prefix of the request the conversation was
 *    already sending, so the provider's KV cache is reused instead of
 *    invalidated. See `./compaction.ts`'s call site.
 * 2. **Every section is written, `(none)` included.** A summarizer that drops
 *    empty sections produces a differently-shaped checkpoint every time, and
 *    the next compaction has to merge two shapes.
 * 3. **A prior checkpoint is merged, never copied forward verbatim** — the last
 *    rule below. Without it a second compaction quotes the first inside itself
 *    and the summary grows monotonically, which is the one failure mode that
 *    defeats the whole feature.
 *
 * What the transcription changed: the sections. The harness condenses a coding
 * session, so its headings are files, errors and pending jobs. A conversation
 * here is a scene with characters in it, and what has to survive is who these
 * people are, what has happened between them, and what the reader has asked
 * for out of character — so the headings are those. The tags, the framing
 * sentence and the rule list are the harness's, translated only where a
 * heading changed.
 *
 * @module @iris/app-service/compaction-prompt
 */

/** Opens the summary inside the landed replacement floor. */
export const SUMMARY_OPEN_TAG = '<compacted-summary>'

/** Closes it. */
export const SUMMARY_CLOSE_TAG = '</compacted-summary>'

/** Shared by both directives below: the summary speaks the conversation's language. */
const LANGUAGE_RULE = '- Write in the language the conversation is in.'

/** Shared by both directives below: a summary reports, it does not narrate. */
const NO_INVENTION_RULE = '- Do NOT continue the story, do NOT write in character, and do NOT invent anything that was not in the text above.'

/**
 * The summarization directive, delivered as the final user message.
 *
 * Assembled as a line array rather than a template literal for the reason the
 * harness gives it that shape: every line is a separate editable decision, and
 * a diff that moves one line should show one line.
 */
export const COMPACTION_INSTRUCTION: string = [
  'You are now acting as a compaction engine for this conversation. Condense everything ABOVE into a structured checkpoint that lets the same characters and the same scene continue with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Setting and Situation',
  '- [where this is happening, when, and what the standing circumstances are]',
  '',
  '## Characters',
  '- [name: who they are here, what they want, how they speak, what they currently know]',
  '',
  '## Relationships and Feelings',
  '- [who feels what about whom, and how that has changed]',
  '',
  '## What Has Happened',
  '- [the events that later turns depend on, in order; keep names, numbers and stated facts exact]',
  '',
  '## Open Threads',
  '- [promises, threats, questions, plans and secrets not yet resolved]',
  '',
  '## State and Records',
  '- [values the scene has been tracking — inventories, counters, dates, status blocks — copied verbatim]',
  '',
  '## Out-of-Character Instructions',
  '- [what the user has asked for about style, pacing, format or content, quoted where the exact wording matters]',
  '',
  '## Current Scene',
  '- [precisely where the conversation stands at this checkpoint, and whose turn it is]',
  '',
  'Rules:',
  LANGUAGE_RULE,
  '- Preserve names, numbers, quoted lines, stated facts and any structured block the scene has been maintaining, exactly as written.',
  "- Capture the user's own instructions and corrections faithfully, especially ones that change how the story is told.",
  NO_INVENTION_RULE,
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/**
 * The sentence that makes the replacement floor read as established context
 * rather than as something to answer.
 */
export const CHECKPOINT_PREAMBLE
  = 'This is an automatically generated checkpoint condensing an earlier span of this conversation to free up context. Treat what it records as established background and build on it without restating it. Continue directly from the messages that follow, without acknowledging this checkpoint.'

/**
 * The directive that summarizes one **branch segment** of the tree map
 * (`chat.summarizeSegment`), delivered as the final user message after the
 * segment's own floors.
 *
 * The compaction directive's style, cut down to what a hover card holds: the
 * same final-user-message shape, the same language and no-invention rules
 * (shared as constants, so the two cannot drift apart), and prose of two to four
 * sentences instead of a sectioned checkpoint. A segment that is not the root's
 * arrives with one line of what came before (`segmentLeadIn`), and the rule
 * below keeps the model from summarizing that line instead of the segment.
 */
export const SEGMENT_SUMMARY_INSTRUCTION: string = [
  'You are now acting as a summarizer for one stretch of this conversation. Summarize the messages ABOVE in 2 to 4 sentences of plain prose: what happens, who is involved, and where it leaves things.',
  '',
  'Rules:',
  LANGUAGE_RULE,
  '- Keep names, numbers and stated facts exactly as written.',
  NO_INVENTION_RULE,
  '- If the first message is a note of what came before, do not summarize the note; summarize only what follows it.',
  '- Do NOT mention this summarization request.',
  '- Output only the summary, with no heading, list or preamble.',
].join('\n')

/**
 * The one line a non-root segment is sent after: what came before it.
 * @param floor - the segment's first floor.
 * @param before - the preceding segment's summary, first sentence, when one exists.
 * @returns the note.
 */
export function segmentLeadIn(floor: number, before: string | undefined): string {
  return before === undefined || before === ''
    ? `(Note: this excerpt begins at message ${String(floor)} of a longer conversation; the earlier messages are not shown.)`
    : `(Note: this excerpt begins at message ${String(floor)} of a longer conversation. Before it: ${before})`
}
