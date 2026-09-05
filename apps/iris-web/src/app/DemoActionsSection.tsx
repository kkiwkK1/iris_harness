/**
 * The demo floor-action provider, and the switch that installs it.
 *
 * This is the B10 seam's living proof and its test fixture: a provider the
 * size of the smallest useful one, going through exactly the surface a real
 * TTS or translation provider will use — `registerMessageAction` on the
 * shell's slot registry, nothing else. It contributes **one** action,
 * "copy as plain text": the floor's words with their markdown stripped
 * (`plainText`), for pasting somewhere that does not render markdown — the
 * complement of the row's built-in Copy, which keeps the raw source.
 *
 * The switch exists so the seam's whole lifecycle is observable in one
 * session: install → the floor row grows an Actions menu holding the action;
 * fire → the callback lands (clipboard + notice); uninstall → every trace is
 * gone, because the ledger entry was the only thing ever added. That last
 * step is the zero-residue invariant the seam is built on, and a fixture
 * buried in a dev-only probe could not show it in a production build — hence
 * a visible, plainly labelled section here rather than `import.meta.env.DEV`
 * gating (recorded in DEVIATIONS).
 *
 * @module iris-web/app/DemoActionsSection
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

import { useSlots } from '../slots/Slot.tsx'
import { registerMessageAction } from '../slots/message-actions.ts'
import { ChoiceField, Section } from './fields.tsx'
import { plainText } from './plain-text.ts'
import { t } from './i18n/use-language.ts'

/** The demo's cell id on the `iris.message.actions` ledger. */
const DEMO_ACTION_ID = 'demo.copy-plain'

/** The registration's disposer while the demo is installed, else undefined. */
let installed: (() => void) | undefined

/**
 * Install the demo provider (idempotent: a second call while installed is a
 * no-op, mirroring how a plugin loader would refuse a double start).
 * @param core - the shell's slot registry.
 */
export function installDemoAction(core: SlotCore): void {
  if (installed !== undefined) return
  installed = registerMessageAction(core, 'demo-actions', {
    id: DEMO_ACTION_ID,
    // A thunk: the menu's word follows the interface language without
    // re-registering, the same rule the ledger's own labels follow.
    label: () => t('demoCopyPlain'),
    title: () => t('demoCopyPlainTitle'),
    order: 10,
    run: ({ message, notify }) => {
      // The row's own Copy ignores writeClipboard's answer; a demo meant to
      // show what a callback receives should not — the notice says which
      // outcome happened, good or bad.
      void writeClipboard(plainText(message.text)).then(ok =>
        notify(ok ? t('copiedPlain') : t('demoCopyFailed')))
    },
  })
}

/** Uninstall the demo provider; safe to call while not installed. */
export function removeDemoAction(): void {
  installed?.()
  installed = undefined
}

/**
 * Render the demo section: the provider's switch and what it proves.
 * @returns the section, or nothing outside a shell that declares the point.
 */
export function DemoActionsSection(): ReactElement | null {
  // `core` arrives from the shell's context; undefined means this page runs
  // without the slot registry at all, so there is nothing to install into and
  // the section would be a switch that lies.
  const core = useSlots()
  const [state, setState] = useState<'on' | 'off'>(installed !== undefined ? 'on' : 'off')
  if (core === undefined) return null

  return (
    <Section title={t('demoSection')}>
      <ChoiceField
        label={t('demoProvider')}
        value={state}
        options={[
          { id: 'off', label: t('demoOff') },
          { id: 'on', label: t('demoOn') },
        ]}
        onSelect={id => {
          if (id === state) return
          if (id === 'on') installDemoAction(core)
          else removeDemoAction()
          setState(id)
        }}
      />
      <p className="iris-field__note">{t('demoNote')}</p>
    </Section>
  )
}
