/**
 * The `iris.message.actions` seam: how a provider contributes one action to a
 * message's action row.
 *
 * This is the B10 seam period's whole deliverable. SillyTavern's Message
 * Actions (speak, translate, image, caption…) are four extensions reaching
 * into the DOM; Iris's route is to build the *seam* first and let each future
 * provider (TTS, translation, image, …) register into it independently. The
 * contract therefore names a *class* of contribution — a button and its
 * handler — and names no feature.
 *
 * The shape follows the slot pattern the shell already uses
 * (`iris.sidebar.panels`, the ScriptButtons bar): the ledger is the shell's
 * `SlotCore`, so registration, shadowing, change notification and disposal all
 * behave like every other point; what this module adds is the typed
 * descriptor a provider actually writes:
 *
 * - **register** — `registerMessageAction(core, registrant, action)` puts one
 *   action on the ledger; the returned disposer is the provider's unmount.
 * - **render** — the shell projects the ledger; entries are never rendered
 *   straight into the row (see the overflow note on `MessageActions`).
 * - **callback** — the descriptor's `run` is invoked with the floor's
 *   `MessageActionContext` when the reader fires the action.
 *
 * Zero residue is inherited from the ledger: with nothing registered the
 * projection is empty, and the row grows nothing. The disposer removes every
 * trace, because the entry was the only thing ever added.
 *
 * Kept free of JSX (plain `createElement`) because `node --test` cannot load
 * a `.tsx` module and the contract — including the inline button a ledger
 * entry renders — is exactly the part with rules in it.
 *
 * @module iris-web/slots/message-actions
 */

import { createElement } from 'react'
import type { ReactNode } from 'react'
import { resolveSlotLabel, type SlotCore, type SlotLabel, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { MessageView } from '@iris/protocol'

/**
 * What one action's handler is handed when the reader fires it.
 *
 * `notify` is the shell's notice channel (the same three-second toast the
 * built-in Copy uses), because an action that gives no feedback reads as a
 * broken one — and a provider should not have to learn the store to say "done".
 */
export interface MessageActionContext {
  message: MessageView
  /** True while this floor is still filling in. */
  streaming: boolean
  /** Report an outcome to the reader. */
  notify: (text: string) => void
}

/**
 * One floor action: a button descriptor plus its handler.
 *
 * `label`/`title` accept a thunk so registration-time text follows the active
 * locale without re-registering (the same rule as the ledger's own
 * `SlotLabel`); owners resolve them through `resolveSlotLabel` at read time.
 */
export interface MessageActionDescriptor {
  /** The action's cell identity on the ledger. Two providers, one id: the later registration throws (list cell rule), and a re-register at a different `priority` shadows — the ledger's own replacement story. */
  id: string
  /** The button's word. */
  label: SlotLabel
  /** Hover/assistive description. */
  title?: SlotLabel
  /** Display order among the floor's actions (ascending; ties keep registration order). */
  order?: number
  /** Cell shadowing rank (the ledger's own; equal id at a different priority replaces rather than adds). */
  priority?: number
  /** The handler. */
  run: (context: MessageActionContext) => void
}

/** Owner props the floor row hands the point's projections. */
export interface MessageActionOwner {
  message: MessageView
  streaming: boolean
  notify: (text: string) => void
}

/**
 * A ledger entry for this point: the standard inline button a contribution
 * renders when the row's generic `<Slot>` projection is used, carrying its
 * descriptor so the shell's folded projection can read the ledger back.
 *
 * The shell ships the *folded* projection (`MessageActions`) — every
 * registered action lives inside one per-floor menu — because that keeps the
 * row's layout independent of how many providers are installed. The inline
 * render is the point's other legitimate face (a compact floor view could use
 * it via the generic `<Slot>`), and the contract tests invoke it directly.
 */
export interface MessageActionComponent {
  (props: MessageActionOwner & { renderSlot: unknown }): ReactNode
  readonly action: MessageActionDescriptor
}

/**
 * Register one floor action.
 *
 * The registered entry renders the shell's standard `iris-act` button — a
 * provider contributes a descriptor, never markup — so no provider can shift
 * the reading surface's typography even under the inline projection.
 * @param core - the shell's slot registry.
 * @param registrant - who is registering (named in ledger errors).
 * @param action - the descriptor.
 * @returns the disposer; calling it is the provider's unmount, and leaves
 * nothing behind.
 */
export function registerMessageAction(
  core: SlotCore,
  registrant: string,
  action: MessageActionDescriptor,
): () => void {
  const component = ((props: MessageActionOwner) =>
    renderActionInline(action, props)) as unknown as MessageActionComponent
  Object.defineProperty(component, 'action', { value: action })
  return core.register(
    {
      name: 'iris.message.actions',
      registrant,
      id: action.id,
      label: action.label,
      // Optional fields are spread conditionally: the ledger's options carry
      // `exactOptionalPropertyTypes`, and an explicit `undefined` cell is not
      // the same as an absent one there.
      ...action.order !== undefined ? { order: action.order } : {},
      ...action.priority !== undefined ? { priority: action.priority } : {},
    },
    component,
  )
}

/**
 * The inline projection: one standard action-row button.
 *
 * Exists so a ledger entry is renderable wherever the generic `<Slot>` runs;
 * the folded projection reads `.action` instead of calling this.
 */
function renderActionInline(action: MessageActionDescriptor, owner: MessageActionOwner): ReactNode {
  return createElement(
    'button',
    {
      type: 'button',
      className: 'iris-act',
      title: action.title === undefined ? undefined : resolveSlotLabel(action.title),
      onClick: () => {
        action.run({ message: owner.message, streaming: owner.streaming, notify: owner.notify })
      },
    },
    resolveSlotLabel(action.label),
  )
}

/** The descriptor behind a ledger entry, if the entry is a floor action. */
function actionOf(entry: StoredEntry): MessageActionDescriptor | undefined {
  return (entry.component as Partial<MessageActionComponent> | undefined)?.action
}

/**
 * The floor actions to show, in display order.
 *
 * Winners only (`entriesOfSlot` — a shadowed id does not show), ascending by
 * `order`, ties in registration order (the sort is stable and the winners keep
 * ledger sequence). Entries that are not floor actions — something registered
 * into the point without going through this module — are skipped rather than
 * guessed at: the projection shows what it can name.
 * @param core - the registry, or undefined outside the shell (an
 * extension-less build).
 * @returns the actions, empty when none.
 */
export function registeredActions(core: SlotCore | undefined): MessageActionDescriptor[] {
  if (core === undefined) return []
  return [...core.entriesOfSlot('iris.message.actions')]
    .sort((left, right) => (left.options.order ?? 0) - (right.options.order ?? 0))
    .map(actionOf)
    .filter((action): action is MessageActionDescriptor => action !== undefined)
}
