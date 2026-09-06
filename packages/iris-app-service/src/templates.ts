/**
 * Running EJS prompt templates over the assembled prompt.
 *
 * The seam is fixed by `notes/packages/iris-compat-prompt-template/SNAPSHOT.md`:
 * upstream evaluates at `GENERATE_AFTER_DATA` / `CHAT_COMPLETION_SETTINGS_READY`,
 * over the **already-assembled message array**, one item per message — not per
 * source field. So this runs after `assemble` and before the provider call, and
 * it is the last thing that touches the text.
 *
 * Two properties are worth stating because both fail quietly:
 *
 * - **A session with no templates must never fork a child.** Upstream's own
 *   short-circuit is `hasTemplate` — text with no `<%` is returned untouched —
 *   and applying it before the fork is what keeps the cost of this feature at
 *   zero for the cards that do not use it. Eleven of the corpus's nineteen cards
 *   are in that group.
 * - **A failed item keeps its original text.** Upstream catches, reports, and
 *   lets the generation continue; a card with one broken template is still a
 *   usable card. A throw here would turn a cosmetic template bug into a chat
 *   that cannot generate at all.
 *
 * @module @iris/app-service/templates
 */

import { freezeMessage, type GenerateOptions, type Message } from '@deepseek-ai/dsh-llm'
import { evaluateBatch, hasTemplate, type EvalItem, type Snapshot } from '@iris/compat-prompt-template'

/** How a template failure is reported to the host's logger. */
export interface TemplateFailure {
  /** Upstream's `filename`: `generate/<chatId>/<index>`. */
  origin: string
  message: string
  line?: number
}

/** What one evaluated prompt produced. */
export interface EvaluatedPrompt {
  /** The request to send, with every successful item's text substituted in. */
  options: GenerateOptions
  /** Writes the templates described, for the caller to replay through its own stores. */
  ops: Awaited<ReturnType<typeof evaluateBatch>>['ops']
  /** Items that threw, timed out, or never came back. Empty on a clean batch. */
  failures: TemplateFailure[]
  /** How many items were evaluated. Zero means the short-circuit held. */
  evaluated: number
}

/**
 * The prompt's texts in upstream's own order.
 *
 * The system slot is index 0 when present, because upstream's assembled array
 * carries its system prompts as ordinary entries and `origin` only exists to be
 * recognised by someone reading an error against their SillyTavern.
 * @param options - the assembled request.
 * @returns one string per evaluable slot, in order.
 */
export function promptTexts(options: GenerateOptions): string[] {
  const texts = options.system === undefined ? [] : [options.system]
  for (const message of options.messages) texts.push(textOfMessage(message))
  return texts
}

/**
 * Whether this prompt has anything for the engine to do.
 *
 * Checked before the fork, not after: forking a child, pushing a 3 MiB snapshot
 * and waiting for a round trip in order to be told "no templates here" would be
 * the whole cost of the feature paid by every chat that does not use it.
 * @param options - the assembled request.
 * @returns whether any slot contains an opening delimiter.
 */
export function promptHasTemplate(options: GenerateOptions): boolean {
  return promptTexts(options).some(text => hasTemplate(text))
}

/**
 * Evaluate the templates in one assembled prompt.
 *
 * Never throws for a template's sake — see the module note. The returned `ops`
 * are *not* applied here: the caller replays them through its own stores, which
 * is the property that keeps a template from writing something the host would
 * have refused at its own door.
 * @param options - the assembled request, after `assemble` and before the provider.
 * @param snapshot - everything the templates may read.
 * @param chatId - names the frame in an error message, as upstream's `filename` does.
 * @param deadlineMs - wall clock for the whole batch; the evaluator's default when absent.
 * @returns the rewritten request, the described writes, and any failures.
 */
export async function evaluatePrompt(
  options: GenerateOptions,
  snapshot: Snapshot,
  chatId: string,
  deadlineMs?: number,
): Promise<EvaluatedPrompt> {
  const texts = promptTexts(options)
  // Only the slots that need it become items. Sending the untemplated ones too
  // would make every message pay for the few that use templates, and upstream
  // does not evaluate them either.
  const items: EvalItem[] = []
  const slotOf = new Map<string, number>()
  for (const [index, text] of texts.entries()) {
    if (!hasTemplate(text)) continue
    const id = `slot-${String(index)}`
    slotOf.set(id, index)
    items.push({ id, text, origin: `generate/${chatId}/${String(index)}` })
  }
  if (items.length === 0) return { options, ops: [], failures: [], evaluated: 0 }

  const outcome = await evaluateBatch({
    items,
    snapshot,
    ...deadlineMs === undefined ? {} : { deadlineMs },
  })

  const rewritten = [...texts]
  const failures: TemplateFailure[] = []
  for (const { id, result } of outcome.results) {
    const slot = slotOf.get(id)
    if (slot === undefined) continue
    if (result.ok) {
      rewritten[slot] = result.text
      continue
    }
    // The original text stays in `rewritten` — that is the fallback, and it is
    // upstream's. The failure is reported so it is not also silent.
    failures.push({
      origin: `generate/${chatId}/${String(slot)}`,
      message: result.error,
      ...result.line === undefined ? {} : { line: result.line },
    })
  }

  return { options: withTexts(options, rewritten), ops: outcome.ops, failures, evaluated: items.length }
}

/**
 * Put the evaluated texts back into the request.
 *
 * A message is rebuilt rather than mutated: `dsh-llm` deep-freezes every
 * message, and `freezeMessage` is what keeps the rebuilt one's identity.
 * @param options - the request the texts came from.
 * @param texts - one string per slot, in `promptTexts` order.
 * @returns the request with its text slots replaced.
 */
function withTexts(options: GenerateOptions, texts: readonly string[]): GenerateOptions {
  let cursor = 0
  const system = options.system === undefined ? undefined : texts[cursor++]
  const messages = options.messages.map((message) => {
    const text = texts[cursor++] ?? ''
    return textOfMessage(message) === text ? message : withText(message, text)
  })

  return {
    ...options,
    messages,
    ...system === undefined ? {} : { system },
  }
}

/** The evaluable text of one message: its text blocks, joined. */
function textOfMessage(message: Message): string {
  return message.content
    .filter((block): block is { type: 'text', text: string } => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * One message with its text replaced.
 *
 * The whole result goes into the first text block and the other text blocks are
 * dropped, because the item that was evaluated was the joined text: a template
 * that spans two blocks has no split to restore, and inventing one would put a
 * boundary somewhere the author did not write it. Non-text blocks are untouched
 * — the evaluator never saw them.
 * @param message - the assembled message.
 * @param text - what the template produced.
 * @returns a frozen message carrying the same identity.
 */
function withText(message: Message, text: string): Message {
  const content: Message['content'] = []
  let placed = false
  for (const block of message.content) {
    if (block.type !== 'text') {
      content.push(block)
      continue
    }
    if (placed) continue
    placed = true
    content.push({ ...block, text })
  }
  // A message whose text the templates produced out of nothing — every block was
  // an image or a tool result — still has to carry it somewhere.
  if (!placed) content.push({ type: 'text', text })
  return freezeMessage({ ...message, content })
}
