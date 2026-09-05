/**
 * Iris's extension points, declared on top of `SlotCore`.
 *
 * This is the architectural claim Iris makes against SillyTavern: an extension
 * contributes UI by *registering* into a named point, and unregistering removes
 * it with nothing left behind. ST extensions reach into the DOM, so uninstalling
 * one leaves whatever it drew.
 *
 * `SlotCore` is the pure, cordis-free half of the DSH slot system — it owns the
 * ledger, the shadowing rules and the change notifications, which are the parts
 * that are easy to get subtly wrong. What it does not own is rendering, so the
 * React side is ours (see `Slot.tsx`). The slot contracts themselves are
 * declaration-merged into `SlotMap` below, which is how a registration into a
 * point Iris never declared becomes a compile error rather than a dead hook.
 *
 * @module iris-web/slots
 */

import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import type { CharacterSummary, ChatSummary, MessageView } from '@iris/protocol'

import type { MessageActionOwner } from './message-actions.ts'

/** What a message-scoped contribution is handed. */
export interface MessageSlotOwner {
  message: MessageView
  /** True while this message is the one filling in. */
  streaming: boolean
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The render tree's root hole. `SlotCore` seeds this declaration at
     * construction, but only as runtime state — the type table is per-program,
     * so it has to be named here for the shell's own registration to typecheck.
     */
    root: { kind: 'single', scope: 'root' }
    /**
     * Actions on one message, contributed by providers (the B10 seam: a TTS,
     * translation or image provider registers a button and its handler —
     * `registerMessageAction`, no feature is named here). A `list` slot: each
     * contribution keeps its own `id` cell. The shell folds the ledger into
     * one per-floor menu (`MessageActions`), so nothing registered can reshape
     * the row, and nothing registered leaves the row unchanged.
     */
    'iris.message.actions': { kind: 'list', scope: 'root', owner: MessageActionOwner }
    /** Blocks under a message's text — a status bar, a token readout, a rating. */
    'iris.message.footer': { kind: 'list', scope: 'root', owner: MessageSlotOwner }
    /** Panels in the sidebar, below the built-in chat and character lists. */
    'iris.sidebar.panels': { kind: 'list', scope: 'root', owner: { chats: ChatSummary[], characters: CharacterSummary[] } }
    /** Sections in the settings drawer. */
    'iris.settings.sections': { kind: 'list', scope: 'root', owner: Record<string, never> }
    /** Controls in the composer's action row, left of Send. */
    'iris.composer.actions': { kind: 'list', scope: 'root', owner: { chatId: string, generating: boolean } }
  }
}

/** Every point Iris declares, so a registrant can be told what exists. */
export const IRIS_SLOTS = [
  'iris.message.actions',
  'iris.message.footer',
  'iris.sidebar.panels',
  'iris.settings.sections',
  'iris.composer.actions',
] as const

/** One Iris extension point. */
export type IrisSlotName = (typeof IRIS_SLOTS)[number]

/** Every Iris point is a list slot at root scope; written out so the keys stay literal. */
const CHILDREN = {
  'iris.message.actions': { kind: 'list', scope: 'root' },
  'iris.message.footer': { kind: 'list', scope: 'root' },
  'iris.sidebar.panels': { kind: 'list', scope: 'root' },
  'iris.settings.sections': { kind: 'list', scope: 'root' },
  'iris.composer.actions': { kind: 'list', scope: 'root' },
} as const

/**
 * The entry that holds Iris's declarations.
 *
 * It renders nothing and never mounts. `SlotCore` requires a declaring
 * component to accept `renderSlot`, on the principle that declaring a point you
 * do not render is a dead hook — Iris honors that principle, but renders its
 * points through its own `<Slot>` (below) rather than through the injected
 * dispatcher, because the React tree here is mounted by `uiRenderer` and not by
 * the DSH slot renderer.
 */
const declarer = (_props: { renderSlot: unknown }): null => null

/**
 * Build the registry.
 *
 * Every point is declared by the shell itself rather than by whoever registers
 * first. `SlotCore` allows exactly one declarer per key and collapses a key's
 * entries when its declarer goes away, so letting a plugin declare a point
 * would make every other plugin's contributions depend on that plugin's
 * lifetime.
 * @returns the registry, and a disposer that collapses every declared point.
 */
export function createIrisSlots(): { core: SlotCore, dispose: () => void } {
  const core = new SlotCore()
  const dispose = core.register({ name: 'root', registrant: 'iris-shell', children: CHILDREN }, declarer)
  return { core, dispose }
}
