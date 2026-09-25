/**
 * The card a reader answers before a model's code is allowed to run.
 *
 * A model has written a plugin for this conversation and it is parked in the
 * sidecar in a state that cannot mount (`docs/SANDBOX-PLUGINS.md` §4.1). This is
 * the one thing standing between that record and execution, so five rules from
 * `ConsentAsk` next door hold here unchanged — they are the same rules because
 * it is the same kind of question about a different piece of code:
 *
 * - **Drawn by the shell, never in the frame.** A confirmation card painted by
 *   untrusted code is painted by the code being confirmed: it could show a
 *   different purpose, a smaller byte count, or a tick already in it.
 * - **Not modal, and no timer.** A notice expires; a question must not. §3.4
 *   keeps prompts off the conversation, so this sits in the notice region and
 *   blocks neither reading nor writing.
 * - **Nothing a card can reach.** No API summons it, pre-fills it or hurries it.
 * - **Worded by consequence, not by API.** 「changes how this card looks」, never
 *   「injects CSS」.
 * - **`declares` is the model's own account.** The heading says "it says it will
 *   register" and not "it will register", because the host gates nothing on it
 *   and a card that implied otherwise would be promising something no one can
 *   keep (§7).
 *
 * @module iris-web/app/SandboxPluginConfirm
 */
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { SandboxPluginDeclaration } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * One line of the 「it says it will register」 list.
 *
 * Each kind becomes a sentence about what the reader would notice, which is the
 * only form of this list a reader can act on: a row saying `style` tells them
 * nothing they did not already know from the word plugin.
 * @param declaration - what the model declared.
 * @returns the sentence.
 */
function describeDeclaration(declaration: SandboxPluginDeclaration): string {
  if (declaration.kind === 'style') return t('pluginDeclareStyle')
  if (declaration.kind === 'panel') return t('pluginDeclarePanel')
  return t('pluginDeclareMembers', { names: declaration.names.join(', ') })
}

/**
 * Ask about the plugin a model just wrote, where it will be seen.
 * @returns the card, or null when nothing is waiting.
 */
export function SandboxPluginConfirm(): ReactElement | null {
  const pending = useIris(state => state.sandboxPluginPending)
  // The grant of the card this conversation is played with — the same field the
  // live frame's policy is switched by (`useCardScripts`' `applyNetworkGrant`).
  const networkGranted = useIris(state => state.networkGranted)
  const actions = useIrisActions()
  // Before the early return: hook order must not depend on what is on screen.
  useLanguage()

  if (pending === undefined) return null
  const version = pending.versions.at(-1)
  // A row with no version is not a question. It cannot happen through the
  // define path — a definition always appends one — so this is the narrowing
  // that keeps the render honest rather than a case being handled.
  if (version === undefined) return null

  return (
    <div className="iris-notice iris-notice--info" role="region" aria-label={t('pluginConfirmTitle')}>
      <p className="iris-label">{t('pluginConfirmTitle')}</p>
      <dl className="iris-var">
        <div className="iris-var__row">
          <dt className="iris-var__key">{t('pluginConfirmName')}</dt>
          <dd className="iris-var__value">{version.name}</dd>
        </div>
        <div className="iris-var__row">
          <dt className="iris-var__key">{t('pluginConfirmPurpose')}</dt>
          <dd className="iris-var__value">{version.purpose}</dd>
        </div>
        <div className="iris-var__row">
          <dt className="iris-var__key">{t('pluginConfirmDeclares')}</dt>
          <dd className="iris-var__value">
            {version.declares.length === 0
              ? t('pluginDeclareNone')
              : (
                <ul className="iris-list">
                  {version.declares.map((declaration, at) => (
                    <li key={`${declaration.kind}-${String(at)}`}>{describeDeclaration(declaration)}</li>
                  ))}
                </ul>
              )}
          </dd>
        </div>
        <div className="iris-var__row">
          <dt className="iris-var__key">{t('pluginConfirmCode')}</dt>
          {/*
            The size, always. It is the one number a reader can hold against the
            purpose — 「only changes some colours」 beside forty kilobytes is a
            mismatch a person can see and no runtime check can.
          */}
          <dd className="iris-var__value">
            {t('pluginConfirmBytes', { bytes: version.bytes, version: version.version })}
          </dd>
        </div>
        <div className="iris-var__row">
          <dt className="iris-var__key">{t('pluginConfirmSentence')}</dt>
          {/* Verbatim. It is the reader's own words, and the answer to 「what did
              I ask for」 has to be the string that was sent. */}
          <dd className="iris-var__value">「{version.prompt}」</dd>
        </div>
        <div className="iris-var__row" data-plugin-confirm="network">
          <dt className="iris-var__key">{t('pluginConfirmNetwork')}</dt>
          {/*
            The frame's reach, from the card's **live** grant. A plugin mounts in
            the card's own frame and runs under that frame's policy, so a card
            allowed online gives this code an https way out (owner ruling 2,
            2026-09-25). Both branches are said, because 「offline」 is also a
            fact a reader weighs, and a row that appeared only when the news was
            bad would teach that its absence means nothing.
          */}
          <dd className="iris-var__value">
            {networkGranted ? t('pluginConfirmNetworkOn') : t('pluginConfirmNetworkOff')}
          </dd>
        </div>
      </dl>
      <p className="iris-field__note">{t('pluginConfirmSandbox')}</p>
      <div className="iris-probe__actions">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void actions.decideSandboxPlugin(pending.id, 'version', version.hash)}
        >
          {t('pluginAcceptVersion')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void actions.decideSandboxPlugin(pending.id, 'plugin', version.hash)}
        >
          {t('pluginAcceptPlugin')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void actions.decideSandboxPlugin(pending.id, 'discard')}
        >
          {t('pluginDiscard')}
        </Button>
      </div>
      {/* The double tick's cost, said beside it rather than discovered: it
          trusts a position for ever, not these bytes. */}
      <p className="iris-field__note">{t('pluginAcceptPluginNote')}</p>
    </div>
  )
}
