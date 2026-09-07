/**
 * The message scope, backed by the chat log.
 *
 * This is the scope that makes stateful roleplay work. SillyTavern keys these
 * variables by `chat[i].variables[swipe_id]` — one table per alternate
 * generation — so regenerating a reply does not carry the previous reply's
 * consequences forward. Iris keys them by *candidate*, which is the same idea
 * expressed in the append-only log: a candidate is a swipe.
 *
 * Writes append rather than overwrite. The log is the medium, so the variable
 * history of a chat is recoverable for free, and a swipe back to an earlier
 * candidate finds that candidate's own state still attached to it.
 *
 * @module @iris/variables/message-scope
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { selectedCandidate } from '@iris/chat'

import type { ScopeBackend } from './store.ts'
import { VariableScopeError, type VariableOption, type Variables } from './scope.ts'

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** One candidate's variable table, as of this point in the log. */
    'iris/variables': {
      /**
       * Seq of the message event these attach to — normally the selected
       * `assistant/message`, but the turn's own `user/message` when the turn has
       * no reply yet (an impersonated line's turn). The field kept its name for
       * log compatibility; what it has always carried is "a message's seq",
       * which is why the user floor can ride it without a migration.
       */
      candidateSeq: number
      variables: Record<string, unknown>
    }
  }
}

/**
 * Every candidate's own variable table, in one pass.
 *
 * Built per call rather than cached: the log is append-only and a read is rare
 * next to an append, so a stale cache would be a correctness risk bought with
 * no measurable speed.
 * @param session - the chat log.
 * @returns the last table written for each attached message seq (see the
 *   `iris/variables` event: a candidate's reply, or a candidate-less turn's
 *   user floor).
 */
function tablesBySeq(session: Session): Map<number, Variables> {
  const tables = new Map<number, Variables>()
  for (const event of session.events) {
    if (event.type === 'iris/variables') tables.set(event.data.candidateSeq, event.data.variables)
  }
  return tables
}

/**
 * The state a turn inherits when its own candidate wrote none.
 *
 * Walks back by **turn**, taking each turn's *selected* candidate — not back by
 * event. Two candidates of one turn are mutually exclusive answers to the same
 * question, so a change made by swipe 0 must not be inherited by swipe 1; only
 * a settled earlier turn can be inherited from.
 * @param session - the chat log.
 * @param turn - the turn doing the inheriting.
 * @param tables - the per-candidate tables.
 * @returns the nearest earlier turn's table, or an empty one.
 */
function inheritedTable(session: Session, turn: number, tables: Map<number, Variables>): Variables {
  for (let earlier = turn - 1; earlier >= 0; earlier -= 1) {
    const candidate = selectedCandidate(session, earlier)
    if (candidate === undefined) continue
    const table = tables.get(candidate.seq)
    if (table !== undefined) return table
  }
  return {}
}

/** The highest turn the log has opened, or `-1` when it has none. */
function lastTurn(session: Session): number {
  let turn = -1
  for (const event of session.events) {
    if (event.type === 'turn/start') turn = Math.max(turn, event.data.turn)
  }
  return turn
}

/**
 * The seq of the user line that opened a turn, when one did.
 *
 * A `user/message` event carries no turn of its own — the association is
 * positional, the line belonging to the `turn/start` most recently opened when
 * the event was appended (the same walk the message view in the app service
 * uses). The first line of the turn is the floor: in Iris a turn opens with
 * exactly one user message (`send`, `recordImpersonation`, import all append
 * one), and pinning the first keeps the binding stable no matter what else is
 * journalled into the turn afterwards.
 *
 * What makes this seq load-bearing for variables is impersonation:
 * `recordImpersonation` lands `turn/start`, the user floor, and nothing else,
 * so a candidate-less turn is a *normal* state of the log — and while the
 * reply has not generated, the floor's own seq is the only message the turn
 * has for a table to attach to.
 * @param session - the chat log.
 * @param turn - the turn whose opening user line to find.
 * @returns the seq of the turn's first `user/message`, or `undefined` when the
 *   turn has no user line (a greeting-only turn, an empty turn).
 */
function userFloorSeqOf(session: Session, turn: number): number | undefined {
  if (turn < 0) return undefined // no turn has opened; there is no floor anywhere
  let open = -1
  for (const event of session.events) {
    if (event.type === 'turn/start') {
      if (open === turn) break // the next turn/start is the previous turn's close
      open = event.data.turn
    } else if (event.type === 'user/message' && open === turn) {
      return event.seq
    }
  }
  return undefined
}

/**
 * Resolve a `message_id` selector onto a turn.
 *
 * Divergence worth knowing: SillyTavern counts every message, user turns
 * included, while Iris counts exchanges. Negative indices and `'latest'` mean
 * the same thing in both — and they are what cards actually use, because a card
 * addressing an absolute message id would break the moment the user edited
 * history. A non-negative id is read as a turn number.
 * @param session - the chat log.
 * @param selector - the `message_id` from the scope option.
 * @returns the turn to address.
 */
export function resolveTurn(session: Session, selector: number | 'latest' | undefined): number {
  const latest = lastTurn(session)
  if (selector === undefined || selector === 'latest') return latest
  if (selector < 0) return latest + selector + 1
  return selector
}

/**
 * Store message-scope variables in a chat log.
 * @param session - the chat log to read and append to.
 * @returns a backend for the `message` scope.
 */
/**
 * Store message-scope variables in a chat log.
 *
 * Two halves of one rule: **a candidate that changed nothing stores nothing,
 * and reads what the previous turn settled on.** They have to arrive together.
 * Skipping the write alone would make an unchanged candidate read back empty —
 * a status-bar card rendering blank with nothing logged — and inheriting alone
 * would cost nothing but save nothing.
 *
 * The saving is not marginal. Measured against the corpus's own ratio (four of
 * forty turns actually changing a variable), writing unconditionally stored 40
 * tables and 201 KB where 4 tables and 20 KB carry the same information.
 * SillyTavern is cleaner here than we were: its stored table has a median size
 * of zero, because it writes one only where its variable engine actually ran.
 * @param session - the chat log to read and append to.
 * @returns a backend for the `message` scope.
 */
export function sessionMessageBackend(session: Session): ScopeBackend {
  /** The turn a `message` selector addresses. */
  const turnOf = (option: VariableOption): number => {
    if (option.type !== 'message') {
      throw new VariableScopeError(`the message backend cannot serve the "${option.type}" scope`)
    }
    return resolveTurn(session, option.message_id)
  }

  /**
   * The message a `message` selector's write attaches to.
   *
   * The turn's selected candidate when it has one; otherwise the turn's own
   * user floor. A candidate-less turn used to be refused outright, which made
   * the impersonated line's turn the one floor a card could not write on: the
   * MVU script of the card that produced the line (or any script running while
   * the reply pends) had its `setVariables` rejected with "no generated reply",
   * and the rejection took the card body down with it. The floor is a message
   * of the turn like a candidate is, the binding key is a message seq either
   * way, and only a turn with no message at all (a bare `turn/start`) has
   * nowhere to attach.
   */
  const attachSeqOf = (option: VariableOption): number => {
    const turn = turnOf(option)
    const candidate = selectedCandidate(session, turn)
    if (candidate !== undefined) return candidate.seq
    const floor = userFloorSeqOf(session, turn)
    if (floor !== undefined) return floor
    throw new VariableScopeError(`turn ${turn} has no message to attach variables to`)
  }

  const effective = (option: VariableOption): Variables => {
    const turn = turnOf(option)
    const tables = tablesBySeq(session)
    // This turn's selected candidate's own answer wins whenever it wrote one.
    const candidate = selectedCandidate(session, turn)
    const own = candidate === undefined ? undefined : tables.get(candidate.seq)
    if (own !== undefined) return own
    /*
     * The turn's own user floor is next. An impersonated line's turn has no
     * candidate, and the scripts that run as the line lands write exactly
     * here; reading the floor's table on this tier is what makes the
     * user→reply window lossless in both directions — the write above attaches
     * to the floor's seq, so this read finds it. Once a reply lands, a
     * candidate that wrote nothing still reads the floor's state, and one that
     * wrote its own table wins — the same "own answer first" rule the
     * candidate tier applies. The tier is turn-local, so it sits before
     * inheritance and does not touch the swipe-exclusivity rule below: the
     * floor's table is the turn's foundation, not one swipe's change for the
     * other to inherit.
     */
    const floor = userFloorSeqOf(session, turn)
    const founded = floor === undefined ? undefined : tables.get(floor)
    if (founded !== undefined) return founded
    /*
     * A candidate that wrote nothing inherits — and so does a turn with **no
     * candidate at all**: a user line awaiting its answer, which is exactly the
     * floor a card's `createChatMessages` append produces. The store used to
     * refuse that read, and the refusal emptied every status surface for the
     * whole user→reply window: `view.variables` collapsed to `undefined`, a
     * `getVariables` over the wire answered `internal`, and a card reading
     * `latest` there read "nothing set yet" — the one reading that makes
     * MagVarUpdate re-initialise and write defaults over live state. The
     * founding console's own write survived; everything that looked at it
     * afterwards was told there was nothing. Inheritance is the same rule the
     * backend already applies one turn later, extended to the turn that has not
     * generated yet.
     */
    return inheritedTable(session, turn, tables)
  }

  return {
    read(option: VariableOption): Variables {
      return effective(option)
    },

    write(option: VariableOption, next: Variables): void {
      // Nothing to record when the table already reads this way — whether
      // because this candidate wrote it or because it inherits it. Comparison
      // is by serialization: a key-order difference can only produce a spurious
      // *inequality*, which costs a redundant write rather than a wrong read.
      if (JSON.stringify(effective(option)) === JSON.stringify(next)) return
      session.append('iris/variables', { candidateSeq: attachSeqOf(option), variables: next })
    },
  }
}
