/**
 * Recording what a card does to `getContext().chat`, so `saveChat` can mean it.
 *
 * Upstream hands a card the live chat array and the card mutates it — push a
 * floor, splice one out, assign into `chat[i].mes` — and then calls `saveChat()`.
 * Iris hands over a snapshot that crossed an origin, so every one of those
 * mutations lands in a copy the host will never see, and the save afterwards
 * succeeds while storing the array without them. Nothing throws.
 *
 * This module makes the mutation **observable at the moment the card makes it**.
 * It does not diff: inferring which operation produced an observed difference is
 * guessing, and a guess has no name to refuse by. Every mutation is either
 * recognised and journalled, or refused by name at the call site, inside the
 * card's own stack, where the line that did it is visible.
 *
 * **Order is load-bearing.** See `CHAT-WRITES.md`: one measured card processes
 * its work back to front to keep indices valid, mixing splices and rewrites in
 * one loop and saving at the end. Entries therefore replay in the order they
 * were made, and must never be sorted, batched across a structural operation, or
 * deduplicated.
 *
 * @module iris-web/sandbox/chat-journal
 */

/** One mutation a card made, in the order it made it. */
export type ChatEdit =
  /** `chat.push(message)` — a new floor at the end. */
  | { kind: 'append', message: Record<string, unknown> }
  /** `chat.splice(index, 1)` — the floor at this index, as the array then stood. */
  | { kind: 'remove', index: number }
  /** `chat[index].mes = text` — a rewrite of the visible reading. */
  | { kind: 'rewrite', index: number, text: string }

/** What a card is allowed to do to the array itself. */
const ARRAY_WRITES: readonly string[] = ['push', 'splice']

/**
 * The message fields a pushed floor may carry.
 *
 * Constraint 5: a card supplies an arbitrary object and only what the host's
 * append arm understands travels. The rest is dropped **with a report**, because
 * silently discarding a field a card set is the same class of defect as the one
 * this module exists to fix.
 */
const MESSAGE_FIELDS: readonly string[] = ['name', 'is_user', 'is_system', 'mes', 'send_date', 'extra']

/** What the journal needs from its surroundings. */
export interface ChatJournalEnv {
  /** Say that something happened that a card author needs to know. Deduplicated by the caller. */
  report: (message: string) => void
  /** Refuse, by name, in the card's own stack. */
  refuse: (member: string, detail: string) => never
}

/** A recording chat array, plus the journal behind it. */
export interface RecordingChat {
  /** Hand this to the card in place of the snapshot's array. */
  array: Record<string, unknown>[]
  /** The mutations so far, oldest first. */
  entries: () => readonly ChatEdit[]
  /** Forget them, once they have been replayed. */
  clear: () => void
}

/**
 * Keep only the fields the host understands, reporting anything else.
 * @param message - the object a card pushed.
 * @param env - where to report.
 * @returns the message, narrowed to known fields.
 */
function narrowMessage(
  message: Record<string, unknown>,
  env: ChatJournalEnv,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const [field, value] of Object.entries(message)) {
    if (MESSAGE_FIELDS.includes(field)) kept[field] = value
    else dropped.push(field)
  }
  if (dropped.length > 0) {
    env.report(
      `a card pushed a chat message carrying ${dropped.join(', ')}, which Iris does not store`,
    )
  }
  return kept
}

/**
 * Wrap the snapshot's chat array so a card's mutations are recorded.
 *
 * The elements are wrapped too, and that is **not** an optional refinement:
 * `chat[i].mes = x` mutates the message object, not the array, so an array-level
 * proxy cannot see it. Dropping element wrapping reinstates the silent loss for
 * one of the three measured mutations while appearing to fix the problem.
 *
 * @param source - the snapshot's own array; it is not modified.
 * @param env - reporting and refusal.
 * @returns the array to hand a card, and its journal.
 */
export function recordChatEdits(
  source: readonly Record<string, unknown>[],
  env: ChatJournalEnv,
): RecordingChat {
  const journal: ChatEdit[] = []

  /*
   * The card's working copy. Mutations are applied here as well as journalled,
   * so a card that reads back what it just wrote sees it — which upstream's live
   * array does for free, and which constraint 4 requires we not regress.
   */
  const working: Record<string, unknown>[] = source.map(entry => ({ ...entry }))

  /** Wrap one message so an assignment into it is seen. */
  const wrapMessage = (message: Record<string, unknown>): Record<string, unknown> =>
    new Proxy(message, {
      set(target, property, value): boolean {
        if (typeof property !== 'string') return Reflect.set(target, property, value)
        if (property !== 'mes') {
          /*
           * Reported rather than refused. Upstream's message objects carry many
           * fields and a card writing one is doing something upstream allows;
           * refusing would break a card that works there. What Iris cannot do is
           * carry the write to the host, and saying so is the honest half.
           */
          env.report(
            `a card wrote chat[…].${property}, which Iris does not persist — only mes is stored`,
          )
          return Reflect.set(target, property, value)
        }
        const index = working.indexOf(target)
        if (index === -1) {
          // The card kept a reference to a floor that has since been spliced out.
          // Upstream would write into a detached object too, so this is not an
          // error — but it will not be saved, and silence there is the bug.
          env.report('a card wrote mes on a chat message that is no longer in the chat')
          return Reflect.set(target, property, value)
        }
        journal.push({ kind: 'rewrite', index, text: String(value) })
        return Reflect.set(target, property, value)
      },
    })

  const wrapped: Record<string, unknown>[] = working.map(entry => wrapMessage(entry))

  const array = new Proxy(wrapped, {
    get(target, property): unknown {
      if (property === 'push') {
        return (...items: Record<string, unknown>[]): number => {
          for (const item of items) {
            const narrowed = narrowMessage(item, env)
            journal.push({ kind: 'append', message: narrowed })
            const live = { ...item }
            working.push(live)
            target.push(wrapMessage(live))
          }
          return target.length
        }
      }

      if (property === 'splice') {
        return (start: number, count?: number, ...inserted: unknown[]): unknown[] => {
          /*
           * Only the measured shape is served. `splice(i, 1)` is what the corpus
           * does; an insert-via-splice or a multi-element delete has no journal
           * entry that could describe it, and inventing one would be the guess
           * this module exists to avoid.
           */
          if (inserted.length > 0 || (count !== undefined && count !== 1)) {
            env.refuse(
              'chat.splice',
              'Iris records splice(index, 1) only; other forms have no counterpart it could save',
            )
          }
          journal.push({ kind: 'remove', index: start })
          working.splice(start, 1)
          return target.splice(start, 1)
        }
      }

      /*
       * Every other mutating array method is refused **by name, at the call
       * site**. Left alone they would change the working copy and vanish at
       * save — the third state constraint 1 forbids.
       */
      if (typeof property === 'string' && MUTATORS.includes(property)) {
        return (): never =>
          env.refuse(
            `chat.${property}`,
            `Iris records push and splice(i, 1); ${property} has no counterpart it could save`,
          )
      }

      return Reflect.get(target, property)
    },

    set(target, property, value): boolean {
      /*
       * `chat[i] = message` and `chat.length = n` both restructure the array
       * without going through a method. Neither is measured, and both would
       * otherwise be silent.
       */
      if (typeof property === 'string' && property !== 'length' && `${Number(property)}` === property) {
        env.refuse(
          'chat[index] =',
          'Iris records push and splice(i, 1); assigning a floor in place has no counterpart it could save',
        )
      }
      if (property === 'length') {
        env.refuse('chat.length =', 'Iris records push and splice(i, 1); truncating has no counterpart')
      }
      return Reflect.set(target, property, value)
    },
  })

  return {
    array,
    entries: () => journal,
    clear: () => {
      journal.length = 0
    },
  }
}

/**
 * Array methods that change the array and have no journal entry.
 *
 * Listed rather than detected, because "does this method mutate" is not
 * something the language will answer and a wrong guess in either direction is
 * bad: a missed mutator is a silent loss, and a falsely-listed reader breaks a
 * card doing nothing wrong.
 */
const MUTATORS: readonly string[] = [
  'pop',
  'shift',
  'unshift',
  'sort',
  'reverse',
  'fill',
  'copyWithin',
]

/** Names a card may call that write, for the surface audit to check against. */
export const RECORDED_ARRAY_WRITES = ARRAY_WRITES

/** What the replay needs to reach the host. */
export interface ChatReplayEnv {
  /** Invoke a card-facing action. Names come from `CARD_METHODS`. */
  call: (method: string, params: Record<string, unknown>) => Promise<unknown>
}

/**
 * A replay that stopped partway.
 *
 * Carries **how many entries landed**, because the alternative was the thing the
 * whole design is shaped against: a card told "your save failed" while the host
 * holds three of its five changes. A bare rejection says nothing about which
 * world the card is now in, so it cannot recover and cannot even report usefully.
 *
 * The goal was never "nothing persists until save" — that was a means, and it
 * does not cover this case, since one `saveChat` can itself fail after earlier
 * entries have been applied. The goal is that **a half-executed batch is never
 * both real and reported as a failure**. Where it cannot be prevented it has to
 * be described.
 */
export class ChatReplayError extends Error {
  /** Entries the host accepted before the failure. */
  readonly applied: number
  /** Entries in the batch. */
  readonly total: number
  /** The entry that failed. */
  readonly entry: ChatEdit

  constructor(applied: number, total: number, entry: ChatEdit, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(
      `chat replay stopped at ${String(applied + 1)} of ${String(total)}`
        + ` (${entry.kind}): ${detail}.`
        + ` ${String(applied)} earlier change(s) are in the host and were not saved.`,
    )
    this.name = 'ChatReplayError'
    this.applied = applied
    this.total = total
    this.entry = entry
  }
}

/**
 * Send a card's recorded edits to the host, in order, then commit once.
 *
 * **Sequential, deliberately, and not a candidate for batching.** Each `remove`
 * index is relative to the array as the earlier entries in this same batch have
 * already left it — that is what the card was looking at when it made the call,
 * and one measured card works back-to-front precisely to keep those indices
 * valid.
 *
 * The deletes go through `script.deleteChatMessages` **one id per call**, and the
 * distinction is worth being exact about because the obvious tidy-up is wrong.
 * That arm takes *original* indices and removes them in a single pass, for a
 * caller holding the whole set at once. With one id per call the two readings
 * coincide — removing `[i]` from the current array is the same operation either
 * way — so this is correct. **Collecting these ids and passing them together is
 * not**: they were recorded against successive states, and the arm would apply
 * them against one. Same type, same arm, different meaning; the host package
 * asserts the two orderings disagree, so whoever performs that tidy-up fails
 * there rather than in somebody's chat.
 *
 * The commit is a single `saveChat` at the end. Upstream persists per call, but
 * **debounced** — a card pushing ten messages produces one save, not ten — so
 * committing once per batch is closer to upstream's behaviour than committing
 * per entry, not a compromise made for atomicity.
 *
 * @param entries - the journal, oldest first.
 * @param env - how to reach the host.
 * @returns nothing; rejects with {@link ChatReplayError} naming what landed.
 */
export async function replayChatEdits(
  entries: readonly ChatEdit[],
  env: ChatReplayEnv,
): Promise<void> {
  if (entries.length === 0) return

  let applied = 0
  for (const entry of entries) {
    try {
      if (entry.kind === 'append') {
        // No `insertAt`: a journal append comes from `push`, which is the end.
        await env.call('createChatMessages', { messages: [entry.message] })
      } else if (entry.kind === 'remove') {
        await env.call('deleteChatMessages', { messageIds: [entry.index] })
      } else {
        /*
         * Through `setChatMessages` and nothing else. A floor's text lives in its
         * swipe list, so an edit that misses the list is undone by the next swipe
         * back and forth — a rule this repo has implemented correctly once, and
         * this is that once.
         */
        await env.call('setChatMessages', {
          messages: [{ messageId: entry.index, message: entry.text }],
        })
      }
    } catch (cause) {
      throw new ChatReplayError(applied, entries.length, entry, cause)
    }
    applied += 1
  }

  /*
   * One commit. The arms deliberately do not persist, so until this lands the
   * host holds the changes in memory only — which is also what upstream looks
   * like between a card's mutation and its debounced save.
   */
  try {
    await env.call('saveChat', {})
  } catch (cause) {
    throw new ChatReplayError(applied, entries.length, entries[entries.length - 1] as ChatEdit, cause)
  }
}
