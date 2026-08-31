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
      /** Seq of the `assistant/message` event these belong to. */
      candidateSeq: number
      variables: Record<string, unknown>
    }
  }
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
export function sessionMessageBackend(session: Session): ScopeBackend {
  /** The candidate a `message` selector addresses. */
  const candidateSeqOf = (option: VariableOption): number => {
    if (option.type !== 'message') {
      throw new VariableScopeError(`the message backend cannot serve the "${option.type}" scope`)
    }
    const turn = resolveTurn(session, option.message_id)
    const candidate = selectedCandidate(session, turn)
    if (candidate === undefined) {
      throw new VariableScopeError(`turn ${turn} has no generated reply to attach variables to`)
    }
    return candidate.seq
  }

  return {
    read(option: VariableOption): Variables {
      const seq = candidateSeqOf(option)
      // Last write wins; earlier ones stay in the log as history.
      for (let index = session.events.length - 1; index >= 0; index -= 1) {
        const event = session.events[index]
        if (event?.type === 'iris/variables' && event.data.candidateSeq === seq) return event.data.variables
      }
      return {}
    },

    write(option: VariableOption, next: Variables): void {
      session.append('iris/variables', { candidateSeq: candidateSeqOf(option), variables: next })
    },
  }
}
