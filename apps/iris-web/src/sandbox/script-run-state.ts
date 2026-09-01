/**
 * What a card script is doing, in the words the panel shows.
 *
 * The vocabulary is the sandbox probe's, moved rather than reinvented — every
 * distinction in it was paid for by a run that could not explain itself, and a
 * fresh set of names for auto-run would lose those distinctions while looking
 * tidier.
 *
 * Two of them are worth stating plainly because they are easy to collapse:
 *
 * - `dispatched` is not `running`. It is set before the frame exists, so calling
 *   it running would claim a body had begun when nothing had. The probe once did
 *   exactly that and sent an observer looking for a fault in code that had never
 *   been reached.
 * - `ran` is not `working`. It means the body finished evaluating. A card that
 *   registers listeners and returns has "run" while its actual job starts later,
 *   at generation time — which is what a real card did on the eleventh run, and
 *   reading `ran` as `working` would have called that a success too early.
 *
 * `silent` exists because a cross-origin frame's uncaught errors never reach the
 * parent console. Without a timeout, "started and said nothing" is
 * indistinguishable from "still going".
 *
 * @module iris-web/sandbox/script-run-state
 */
import { FRAME_MEMBERS, MEMBER_KINDS } from './identity.ts'
import { EXPECTED_GLOBALS } from './preset-globals.ts'

/** Where one script has got to. */
export type ScriptRunPhase =
  /** Asked for, no frame yet. */
  | 'dispatched'
  /** The frame answered `ready`; the body has been posted. */
  | 'running'
  /** The body finished evaluating. Not "the card finished working". */
  | 'ran'
  /**
   * Blocked on a sibling publishing a global.
   *
   * A phase of its own because it is the failure with no voice. A script that
   * throws says so; one waiting for a provider that never arrives looks like one
   * that is working — and with a card's scripts in one frame its siblings are
   * visibly fine, so the card reads as healthy while one of them is stopped.
   */
  | 'waiting'

  /** The sandbox refused a member the card reached for. */
  | 'refused'
  /** The body threw. */
  | 'threw'
  /** The frame never started at all. */
  | 'bootstrap-failed'
  /** Started and said nothing for long enough that silence became a finding. */
  | 'silent'
  /** Torn down before it finished, because the chat went away. */
  | 'killed'

/** One script's state, as the panel renders it. */
export interface ScriptRunState {
  scriptId: string
  name: string
  phase: ScriptRunPhase
  /** The refused member, for `refused`. */
  member?: string
  /** The error text, for `threw` and `bootstrap-failed`. */
  detail?: string
  /** What it is blocked on, for `waiting`. */
  waitingFor?: string
  /** How long it has been blocked, once that is worth saying. */
  waitingMs?: number
}

/** Phases that mean the script is no longer going to change on its own. */
const SETTLED: ReadonlySet<ScriptRunPhase> = new Set<ScriptRunPhase>([
  'ran',
  'refused',
  'threw',
  'bootstrap-failed',
  'silent',
  'killed',
])

/**
 * Whether a script has stopped moving.
 * @param phase - the phase to test.
 * @returns true when nothing further will happen without a new run.
 */
export function isSettled(phase: ScriptRunPhase): boolean {
  return SETTLED.has(phase)
}

/**
 * Whether a phase is a failure the user should be told about.
 *
 * `killed` is excluded deliberately: it is what leaving a chat looks like from
 * inside, and reporting it would turn ordinary navigation into a notice.
 * @param phase - the phase to test.
 * @returns true when this warrants a notice.
 */
export function isFailure(phase: ScriptRunPhase): boolean {
  return phase === 'refused' || phase === 'threw' || phase === 'bootstrap-failed' || phase === 'silent'
}

/**
 * One line for the scripts panel.
 *
 * Written for someone deciding whether to keep a card's scripts on, so each line
 * says what happened and — where there is one — what would change it. The
 * refusal names the member, which is the whole reason refusals throw rather than
 * return undefined.
 * @param state - the script's state.
 * @returns the sentence to show.
 */
export function describeRun(state: ScriptRunState): string {
  switch (state.phase) {
    case 'dispatched':
      return 'starting…'
    case 'running':
      return 'running'
    case 'ran':
      // Deliberately not "finished". The body evaluated; a card that registered
      // listeners is still waiting to do its work.
      return 'loaded'
    case 'waiting': {
      /*
       * Names what it is blocked on, because "waiting" alone is what
       * `starting…` already was: a state you cannot act on.
       *
       * There is no companion "gave up" phase any more. That distinction existed
       * only because this frame used to abandon a wait after five seconds — a
       * deadline borrowed from upstream's `stat_data` poll and applied to its
       * event wait, which upstream never bounds. Removing the invented deadline
       * removes the state it invented; a wait that is taking a long time says
       * how long instead.
       */
      const seconds = Math.round((state.waitingMs ?? 0) / 1000)
      const target = state.waitingFor ?? 'another script'
      return seconds > 0 ? `still waiting for ${target} (${String(seconds)}s)` : `waiting for ${target}`
    }

    case 'refused': {
      /*
       * The refusal's own words, not an invented reason.
       *
       * This used to read "the sandbox does not allow it", which asserts a
       * *policy* — and most refusals here are not policy at all. A scope the
       * pushed snapshot cannot carry, a member Iris has not built yet: those are
       * gaps, and calling them prohibitions puts the suspect on a deliberate
       * decision so nobody files the gap.
       *
       * The explanation already exists — `UnsupportedApiError` carries a hint
       * saying which of the two it is — and the panel was throwing it away.
       */
      const hint = refusalHint(state.detail)
      const member = state.member ?? 'a member'
      return hint === undefined ? `refused ${member}` : `refused ${member} — ${hint}`
    }
    case 'threw':
      return `failed: ${attribute(state.detail ?? 'no message')}`
    case 'bootstrap-failed':
      return `never started: ${state.detail ?? 'no message'}`
    case 'silent':
      return 'started but never reported — it may still be running'
    case 'killed':
      return 'stopped when the chat closed'
  }
}

/**
 * The explanatory half of a refusal, without the boilerplate.
 *
 * `UnsupportedApiError` formats as `Iris sandbox: <member> is not available to
 * card scripts. <hint>`. The panel already names the member, so repeating the
 * first sentence would push the part that matters off the end of the line.
 * @param detail - the thrown message, if there was one.
 * @returns the hint, or undefined when the refusal offered none.
 */
function refusalHint(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined
  const marker = 'is not available to card scripts.'
  const at = detail.indexOf(marker)
  const rest = (at === -1 ? detail : detail.slice(at + marker.length)).trim()
  return rest.length === 0 ? undefined : rest
}

/**
 * The name a `ReferenceError` complained about, if that is what this is.
 *
 * String operations rather than a pattern: escapes in this file have been eaten
 * in transit repeatedly, and a collapsed one still parses while matching
 * nothing.
 * @param detail - the thrown message.
 * @returns the missing identifier, or undefined.
 */
function missingName(detail: string): string | undefined {
  const marker = ' is not defined'
  const at = detail.indexOf(marker)
  if (at === -1) return undefined
  const before = detail.slice(0, at)
  const name = before.slice(before.lastIndexOf(' ') + 1)
  return name.length === 0 ? undefined : name
}

/**
 * Say when a card's failure is actually Iris's gap.
 *
 * `waitGlobalInitialized is not defined` reads as a broken card. It was not — it
 * was a member upstream provides and this sandbox did not, and the sentence sent
 * every reader to look at the card. That is the expensive half of a bad
 * diagnostic: not that it is unclear, but that **it arrives with a suspect
 * already attached**, so nobody thinks to check the innocent party.
 *
 * The names Iris knows it *should* provide are already written down — the
 * card-API classification and the library globals — so a `ReferenceError`
 * naming one of them can be attributed correctly instead of blamed on the card.
 * @param detail - the thrown message.
 * @returns the message, with the attribution corrected where it is known to be wrong.
 */
function attribute(detail: string): string {
  const name = missingName(detail)
  if (name === undefined) return detail
  const ours = Object.hasOwn(MEMBER_KINDS, name) || FRAME_MEMBERS.includes(name)
  if (ours) {
    return `${detail} — upstream gives cards this and Iris should too, so this is a gap here, not in the card`
  }
  if (EXPECTED_GLOBALS.includes(name)) {
    return `${detail} — a library upstream seeds from its own page, which this frame does not have`
  }
  return detail
}

/**
 * Summarise a card's scripts for the panel heading.
 *
 * Replaces a static enabled-count, because "2 of 2 enabled" and "2 of 2 running"
 * are different answers to the only question that heading is opened to settle.
 * @param states - every script's state.
 * @returns the heading sentence.
 */
export function summariseRuns(states: readonly ScriptRunState[]): string {
  if (states.length === 0) return 'No scripts are running.'

  const failed = states.filter(state => isFailure(state.phase)).length
  const settled = states.filter(state => isSettled(state.phase)).length
  const total = states.length

  if (failed > 0) {
    return `${failed} of ${total} failed to run. The chat is unaffected.`
  }

  /*
   * A blocked script is called out rather than counted as "still starting".
   *
   * With a card's scripts in one frame, the neighbours of a stuck script are
   * visibly fine — so a heading that averaged them would report a healthy card
   * while one of its scripts is stopped indefinitely. Sibling success must not
   * paper over a hang.
   */
  const blocked = states.filter(state => state.phase === 'waiting')
  if (blocked.length > 0) {
    const names = [...new Set(blocked.map(state => state.waitingFor ?? 'another script'))]
    return `${blocked.length} of ${total} are waiting for ${names.join(', ')}.`
  }

  if (settled < total) {
    return `${settled} of ${total} loaded, ${total - settled} still starting.`
  }
  return `${total} of ${total} loaded and listening.`
}
