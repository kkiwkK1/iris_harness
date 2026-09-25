/**
 * The callbacks every card frame host passes to `runCard`, built once.
 *
 * Two hosts build frames of one card — the script overlay (`useCardScripts`)
 * and the per-message interfaces (`MessageInterfaces`) — and they used to write
 * the same callbacks out by hand, twice: the dialog sentence and its grading,
 * the blocked-request report, the note, the call and slash bridges, the window
 * event fan-out. Every fix to report wording had to be made twice, and where
 * the two drifted it was silent: the interface host never passed `onConsole`
 * (every console line from an interface frame was dropped) and passed
 * `onSettings: () => undefined` (every extension-settings write evaporated).
 *
 * A message frame is another frame of the same card, not a new trust domain
 * (`message-frames.ts`), so what the two hosts share is built here, from the
 * frame's binding, and what differs between them is declared in `FrameKind`
 * below rather than expressed by what a literal leaves out.
 *
 * @module iris-web/app/frame-callbacks
 */
import { actionsOf, type IrisStore } from '../client/store.ts'
import type { FrameBinding } from '../client/card-gateway.ts'
import type { RunnerHost } from '../sandbox/runner.ts'
import { CONSOLE_BUDGET_PER_SECOND, RateGate } from '../sandbox/console-capture.ts'
import { describeRefusal } from './blocked-line.ts'
import { broadcastWindowEvent } from './window-events.ts'

/** The members of `RunnerHost` this module builds, identically for every frame kind. */
export type SharedFrameCallbacks = Pick<
  RunnerHost,
  | 'onCall'
  | 'onSlash'
  | 'onDialog'
  | 'onBlocked'
  | 'onNote'
  | 'onWindowEvent'
  | 'onSettings'
  | 'onConsole'
>

/**
 * How one frame kind's console lines are labelled and gated.
 *
 * The script frame has one frame per card and its own per-frame gate inside
 * the frame (`console-capture.ts`), so its lines go straight through. An
 * interface frame is one of N on screen — one per rendered floor — and N
 * frames each allowed 50 lines a second is not a budget, so its lines pass a
 * **per-card** gate shared by every interface frame of that card, and carry the
 * floor they came from.
 */
export interface FrameConsolePolicy {
  /** Prefixed to each line, so the debug page says which frame printed it. */
  readonly label?: string
  /** Shared by every frame of this kind of one card; undefined lets every line through. */
  readonly gate?: RateGate
}

/**
 * The per-card console gate every interface frame of one card shares.
 *
 * Keyed by character id and kept for the page's lifetime: a gate is a few
 * numbers, and the card's frames come and go with the reading window, so a
 * gate owned by any one frame would reset every time the reader scrolled.
 */
const interfaceGates = new Map<string, RateGate>()

/**
 * The shared console gate for one card's interface frames.
 * @param characterId - the card.
 * @param now - the clock, for a test.
 * @returns the gate every interface frame of that card passes its lines through.
 */
export function interfaceConsoleGate(characterId: string, now: number = Date.now()): RateGate {
  let gate = interfaceGates.get(characterId)
  if (gate === undefined) {
    gate = new RateGate(CONSOLE_BUDGET_PER_SECOND, now)
    interfaceGates.set(characterId, gate)
  }
  return gate
}

/**
 * Build the callbacks both frame hosts share, from one frame's binding.
 *
 * Everything that addresses the host — call, slash, settings, console — takes
 * the **binding**, never the store's live chat: a frame outlives a chat switch
 * by one React cleanup, and a call in that window used to land in the next
 * conversation (`client/card-gateway.ts`).
 * @param store - the shell's store.
 * @param binding - the frame this set is for, captured when its host built it.
 * @param console_ - how this frame's console lines are labelled and gated.
 * @param now - the clock the console gate reads; injectable for tests.
 * @returns the shared members of `RunnerHost`.
 */
export function frameCallbacks(
  store: IrisStore,
  binding: FrameBinding,
  console_: FrameConsolePolicy = {},
  now: () => number = () => Date.now(),
): SharedFrameCallbacks {
  return {
    onCall: async (method, params) => actionsOf(store).runCardAction(method, params, binding),
    onSlash: async (command, revision) => actionsOf(store).runSlash(command, revision, binding),
    /*
     * The dialog bridge. The sandbox never carries `allow-modals`, so the
     * browser's own answer to all three dialogs is silence — which is how a
     * card's `alert("发送失败: …")` became a button that "does nothing". Now the
     * text reaches the panel: an `alert` as a fault the reader actually sees,
     * and a `confirm`/`prompt` as a note saying what was asked and that it was
     * answered "cancel"/"nothing" — the same answers the no-modal sandbox gave,
     * on the record instead of swallowed.
     */
    onDialog: (kind, text) => {
      actionsOf(store).addCardReport(
        kind === 'alert'
          ? text
          : `a card asked ${kind}("${text}") — answered ${kind === 'confirm' ? '"cancel"' : 'nothing'}`,
        { channel: 'dialog', grade: kind === 'alert' ? 'fault' : 'note' },
      )
      actionsOf(store).notify(kind === 'alert' ? 'error' : 'info', text)
    },
    /*
     * Reported, not swallowed: a blocked subresource is the policy doing its
     * job, and the card author needs the host and directive to know what they
     * reached for.
     */
    onBlocked: (blocked, directive, detail, covered) => {
      /*
       * The grant is read from the store at the moment of the report, not
       * captured when the frame was built.
       *
       * Captured, this would answer with the grant as it stood at frame
       * construction — so a refusal arriving after the reader turned the
       * switch on would be filed as `'offer'` and put a button on screen
       * offering what they had just done. The store is the live answer; the
       * frame's policy is the stale one.
       */
      const refusal = describeRefusal(
        blocked, directive, detail, covered, store.getState().networkGranted,
      )
      /*
       * The durable channel always, the notice bar only when it is worth
       * interrupting for. The notice bar alone was one slot that clears itself
       * after eight seconds, so a card making five refused requests overwrote
       * its own evidence four times and then erased the survivor.
       */
      actionsOf(store).addCardReport(refusal.text, {
        grade: refusal.grade,
        grant: refusal.grant ?? 'no',
      })
      if (refusal.notify) actionsOf(store).notify('info', refusal.text)
    },
    /*
     * What the frame paid for its libraries, and similar standing facts.
     * Durable, because the experiment it exists for compares two frames opened
     * minutes apart.
     */
    onNote: text => actionsOf(store).addCardReport(text),
    /*
     * A dispatch on the page window this frame sees, fanned out to the card's
     * other frames — a status bar that broadcasts on the page and a projector
     * that listens on it live in different frames, and only the shell can
     * stand between them.
     */
    onWindowEvent: (event, detail) => {
      broadcastWindowEvent(event, detail)
    },
    /*
     * A settings report is the card's extension settings partition — the whole
     * object, posted on every proxied write and on
     * `SillyTavern.saveSettings[Debounced]`. Dropped, every write-after-read
     * loop a card runs (`if (!extensionSettings.key) { …; extensionSettings.key
     * = … }`) recomputes forever and a key it probes for never reads back —
     * upstream's `saveSettingsDebounced` persists, and this is the one road to
     * that answer.
     *
     * **Forwarded from interface frames too**, where it used to be a silent
     * `() => undefined`. What that costs is recorded in the web ledger: each
     * frame posts its **whole** partition from its own snapshot copy, so two
     * frames of one card writing different keys at once are last-writer-wins,
     * where upstream's one shared object would keep both.
     */
    onSettings: settings => {
      void actionsOf(store).saveCardExtensionSettings(settings, binding)
    },
    /*
     * W7: the card's own console output, forwarded to the host's
     * `DiagnosticBuffer` — local only, never a log file. Not awaited: a console
     * call must not wait on a round trip. Filed under the frame's own chat.
     */
    onConsole: (level, message, at, scriptId) => {
      const gate = console_.gate
      let suffix = ''
      if (gate !== undefined) {
        const verdict = gate.admit(now())
        if (verdict === undefined) return
        // The count rides the next admitted line, the frame gate's own rule:
        // a report about lost reports must not itself be losable.
        if (verdict.dropped > 0) {
          suffix = ` (${String(verdict.dropped)} earlier line(s) from this card's interface frames were dropped by the shell's per-card limit)`
        }
      }
      const text = `${console_.label === undefined ? '' : `[${console_.label}] `}${message}${suffix}`
      void actionsOf(store).reportCardConsole(level, text, at, scriptId, binding)
    },
  }
}
