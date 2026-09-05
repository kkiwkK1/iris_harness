/**
 * The shell's projection of `iris.message.actions`: one folded menu per floor.
 *
 * **Overflow policy.** Every registered action lives inside this one menu; the
 * row grows by exactly one button — this one — no matter whether one provider
 * or fifty are installed. That is the seam's layout invariant, and it holds by
 * construction rather than by measurement: contributions are descriptors
 * (`registerMessageAction`), never markup, so no provider can widen the row,
 * wrap it, or reflow the prose above it. The reading surface's action row is
 * marginalia — invisible until hover, kept tight on purpose — so "reserve
 * space for a wrapping toolbar" is exactly the trade it must not make. The
 * menu itself is portaled, so opening it costs no layout either. It mirrors
 * SillyTavern's per-message extensions menu, which solves the same problem the
 * same way; providers that earn an always-visible control (a TTS play button)
 * can argue for the row's own slots later — the point also renders inline via
 * the generic `<Slot>` — but the seam period's answer is: nothing inline.
 *
 * Zero residue is the whole point of the slot: with an empty ledger this
 * renders `null` — no button, no wrapper, no gap.
 *
 * @module iris-web/app/MessageActions
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { resolveSlotLabel, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

import { registeredActions, type MessageActionOwner } from '../slots/message-actions.ts'
import { useSlots } from '../slots/Slot.tsx'
import { t } from './i18n/use-language.ts'

/** Stable empty ledger, so the no-registry case never allocates per render. */
const EMPTY: readonly StoredEntry[] = []

/**
 * Render the floor's contributed actions, folded into one menu.
 * @param props.message - the floor the actions act on.
 * @param props.streaming - whether that floor is still filling in (handed to
 * the handler; a provider decides what streaming means for it).
 * @param props.notify - the row's notice channel, handed to the handler.
 * @returns the menu button, or null with nothing registered.
 */
export function MessageActions({ message, streaming, notify }: MessageActionOwner): ReactElement | null {
  const core = useSlots()
  const [open, setOpen] = useState(false)

  // The same subscription shape `Slot.tsx` uses: `entries` is the cached,
  // mutation-stable array `useSyncExternalStore` requires; the projection runs
  // in the render body against the winners, so a dispose (uninstall) and a
  // register both land as an ordinary re-render.
  const subscribe = useCallback(
    (onChange: () => void) => (core === undefined ? () => undefined : core.subscribe('iris.message.actions', onChange)),
    [core],
  )
  const snapshot = useCallback(() => (core === undefined ? EMPTY : core.entries('iris.message.actions')), [core])
  const ledger = useSyncExternalStore(subscribe, snapshot, snapshot)

  const actions = useMemo(() => {
    if (core === undefined || ledger.length === 0) return []
    return registeredActions(core)
  }, [core, ledger])

  if (actions.length === 0) return null

  // Labels resolve at read time, so a language switch re-renders the menu's
  // words without any provider re-registering (the thunk contract).
  const items: MenuEntry[] = actions.map(action => ({
    id: action.id,
    label: resolveSlotLabel(action.label),
  }))

  return (
    <Menu
      open={open}
      portal
      align="end"
      anchor={
        <button
          type="button"
          className="iris-act"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {t('floorActions')}
        </button>
      }
      items={items}
      onSelect={id => {
        setOpen(false)
        const action = actions.find(candidate => candidate.id === id)
        // The find can only miss if the ledger changed between render and
        // click and the projection went stale; dropping the click beats
        // running an action the reader can no longer see.
        action?.run({ message, streaming, notify })
      }}
      onClose={() => setOpen(false)}
    />
  )
}
