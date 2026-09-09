/**
 * The providers this host can generate through, and which one it is using.
 *
 * **Two acts, not one** — the user's ruling, 2026-09-09, verbatim:
 * 「我们保存供应商是一回事，从列表中用哪个连接是一回事」. So this panel is a list
 * of saved providers plus three things you can do about them: add one, edit or
 * delete one, test one. Nothing about a provider is editable outside its own
 * editor, and the panel body carries no field at all — the shape SillyTavern's
 * connection page does not have (theirs is one always-present form whose values
 * *are* the connection) and the shape CC Switch does.
 *
 * What that replaced: a resident form (preset, endpoint, key, model, name) with
 * a list under it, where "the connection" was whatever the form happened to
 * hold and saving was one of five buttons in a row. Two things about the same
 * provider were on screen at once and neither said which was in force.
 *
 * One rule shapes every row. **A name is not evidence of where a profile
 * goes.** Measured on a real SillyTavern install, the profile the user had
 * selected was called `deepseek deepseek-chat` and actually pointed at Gemini,
 * through a different endpoint, with a different preset. Upstream stores the
 * display name as a snapshot taken at creation, so it was true for a moment and
 * wrong from then on. The contract's answer is that `summary` is derived on
 * every read and never stored; the interface's answer is that **the summary is
 * always on the row** — beside a user's own label, not instead of it.
 *
 * The editor keeps three more rules. **The key is typed, never shown**: a saved
 * key is announced only as a mask with its last four characters, because no
 * read ever returned it and the form must not pretend it can. **A key is typed
 * at most once**: nearly every provider shows an API key exactly one time, so an
 * empty key field means "use the one you already have", and the verdict says
 * which key was actually sent — a form that demanded a re-paste before every
 * test is a form usable once. **Testing comes before trusting**: the probe's
 * verdict is rendered verbatim — latency, model count and key source, or the
 * named reason it said no — because "it should work" is the one sentence a
 * connection form has no business saying.
 *
 * The model is **picked, not typed**, for the reason the provider is: a
 * mistyped model name is a request that fails at generation time, with a
 * provider's own error, one screen away from the field that caused it. The
 * options come from the endpoint's `/models` — which is where upstream's
 * `model_openai_select` gets its own list. The fallbacks matter as much as the
 * list: a current value the list does not contain stays as a row of its own and
 * is marked as off-list, and no list at all falls back to a text field **with
 * the reason on screen** rather than to an empty dropdown.
 *
 * @module iris-web/app/ConnectionPanel
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

import {
  PROVIDER_PRESETS,
  providerPreset,
  type ConnectionKeySource,
  type ConnectionProfile,
  type ConnectionTestError,
  type HostDefaultConnection,
  type ModelContextLength,
} from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { CollapsibleSection } from './fields.tsx'
import { since } from './format.ts'
import { formatTokens } from './token-format.ts'
import { getLanguage } from './i18n/language.ts'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * Whether two endpoints are the same place, for deciding whose key a row is
 * describing.
 *
 * The **host** makes the security decision with its own copy of this rule
 * (`sameEndpointOrigin` in `connections.ts`); this copy only decides which
 * sentence to print. Two readers is acceptable *here* precisely because a wrong
 * answer on this side mislabels a note, while a wrong answer on that side would
 * post a credential somewhere it does not belong.
 * @param left - one endpoint.
 * @param right - the other.
 * @returns true when both parse and share an origin.
 */
function sameOrigin(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined || left === '' || right === undefined || right === '') return false
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return false
  }
}

/**
 * An endpoint's origin, for the short form a row shows.
 *
 * Falls back to the raw string rather than hiding an unparseable endpoint: the
 * whole point of showing where a connection points is that the reader sees it,
 * and "nothing" is the one answer that fails at that.
 * @param baseURL - the endpoint.
 * @returns its origin, or the string itself when it is not a URL.
 */
function originOf(baseURL: string): string {
  try {
    return new URL(baseURL).origin
  } catch {
    return baseURL
  }
}

/**
 * What the reader calls a row.
 *
 * Their own words when they wrote any, the derived summary when they did not —
 * never the id, which is a file name and tells a reader nothing.
 * @param profile - the saved provider.
 * @returns the name to show and to say in a verdict.
 */
function nameOf(profile: ConnectionProfile): string {
  return profile.label ?? profile.summary
}

/** What the editor holds while it is open. */
interface FormState {
  /** The provider preset the form is pointed at, or `'custom'`. */
  presetId: string
  /** The endpoint, prefilled from the preset. */
  baseURL: string
  /** The model, typed or picked from a probe's list. */
  model: string
  /** The key as typed. Held here only — a save sends it once and forgets it. */
  apiKey: string
  /** The reader's own name for this provider. Empty clears a stored one. */
  label: string
  /** The preset file using this provider also switches to. Empty binds none. */
  boundPreset: string
  /** The profile's own provider when editing, which a legacy route preserves. */
  originalProvider?: string
  /** The profile being edited, or absent for a new one. */
  editId?: string
  /**
   * Sampling overrides an edit must carry through untouched.
   *
   * There is no field for these: sampling is the settings drawer's business,
   * and the old panel's "save the current settings as a connection" button was
   * the second place they could be set. What a profile already carries has to
   * survive an edit anyway, because an absent field on a replacement clears it.
   */
  originalSampling?: Record<string, unknown>
  /** Whether the stored key exists (shown masked) and, when long enough, its tail. */
  hasKey: boolean
  keyTail?: string
  /** Set by the clear button; the save then sends an empty key. */
  clearKey: boolean
  /**
   * The model list this endpoint last reported, and when.
   *
   * Held in the form rather than beside it because it is *about* the endpoint
   * the form currently points at: changing the provider or the base URL
   * invalidates it in the same edit that invalidates the model. `undefined`
   * means "never probed", which the picker renders differently from an empty
   * array ("probed, and it offers nothing").
   */
  models?: string[]
  modelsProbedAt?: number
}

/** A fresh form, pointed at the first preset. */
function freshForm(): FormState {
  const first = PROVIDER_PRESETS[0]
  return {
    presetId: first?.id ?? 'custom',
    baseURL: first?.baseURL ?? '',
    model: '',
    apiKey: '',
    label: '',
    boundPreset: '',
    hasKey: false,
    clearKey: false,
  }
}

/** Load the form from a saved provider, for editing. */
function formOf(profile: ConnectionProfile): FormState {
  return {
    // A provider that is one of the presets selects it; anything else — a
    // legacy route like `default` — is the user's own endpoint, and the form
    // says so by showing `custom` while keeping the original route on save.
    presetId: providerPreset(profile.provider) === undefined ? 'custom' : profile.provider,
    baseURL: profile.baseURL ?? providerPreset(profile.provider)?.baseURL ?? '',
    model: profile.model,
    apiKey: '',
    label: profile.label ?? '',
    boundPreset: profile.preset ?? '',
    originalProvider: profile.provider,
    editId: profile.id,
    ...profile.sampling === undefined ? {} : { originalSampling: profile.sampling },
    hasKey: profile.hasKey === true,
    ...profile.keyTail === undefined ? {} : { keyTail: profile.keyTail },
    clearKey: false,
    // The list the host recorded against this profile, so opening the editor
    // offers a dropdown rather than an empty one waiting for a probe.
    ...profile.models === undefined ? {} : { models: profile.models },
    ...profile.modelsProbedAt === undefined ? {} : { modelsProbedAt: profile.modelsProbedAt },
  }
}

/**
 * The sentence a probe's named error means, in the language in force.
 * @param error - the failure half of a probe result.
 * @returns the copy for it.
 */
function testErrorText(error: ConnectionTestError): string {
  switch (error.code) {
    case 'missing-key': return t('testErrMissingKey')
    case 'unauthorized': return t('testErrUnauthorized')
    case 'timeout': return t('testErrTimeout')
    case 'network': return t('testErrNetwork')
    case 'bad-url': return t('testErrBadUrl')
    case 'bad-key': return t('testErrBadKey')
    case 'http-error': return t('testErrHttp')
    case 'bad-response': return t('testErrBadResponse')
    case 'no-endpoint': return t('testErrNoEndpoint')
  }
}

/**
 * The host's own words for a failed probe, shown under the translated sentence.
 *
 * The sentence says what kind of thing went wrong; the host's message says
 * *which* — the address it tried, the status it got, the `ENOTFOUND` or
 * `ECONNREFUSED` underneath a "could not reach". Measured 2026-09-09: a probe
 * that failed in one millisecond showed only 「无法连接到端点」 and the person
 * spent the afternoon on their network, when the host had the reason all
 * along. The protocol promises the message never carries a credential, so
 * every code's detail is shown; the two that are pure host boilerplate
 * (`missing-key`, `no-endpoint`) add nothing to their sentence and are left out.
 * @param error - the failure half of a probe result.
 * @returns the detail line, or `undefined` when the sentence already says it all.
 */
function testErrorDetail(error: ConnectionTestError): string | undefined {
  if (error.code === 'missing-key' || error.code === 'no-endpoint') return undefined
  return error.message.length === 0 ? undefined : error.message
}

/** A probe, in flight or answered. */
type TestState =
  | { phase: 'idle' }
  | { phase: 'testing', of?: string }
  | {
    phase: 'done'
    ok: boolean
    latencyMs: number
    models?: string[]
    keySource: ConnectionKeySource
    errorText?: string
    /** The host's own reason, under the sentence. See {@link testErrorDetail}. */
    errorDetail?: string
    /** Which row was probed, when a row asked by name. */
    of?: string
  }

/** The sentence for which key the probe sent. Silent for a local serve. */
function keySourceText(source: ConnectionKeySource): string | undefined {
  switch (source) {
    case 'typed': return t('testKeyTyped')
    case 'stored': return t('testKeyStored')
    case 'host': return t('testKeyHost')
    case 'none': return undefined
  }
}

/**
 * What the probe said, rendered verbatim.
 *
 * One component for both callers — the panel's own test block and the editor —
 * because a verdict rendered two ways is two verdicts, and the whole value of
 * `keySource` is that the same words appear wherever the same probe answered.
 * @param props.state - the probe's state.
 * @returns the verdict paragraph, or null while nothing has been asked.
 */
function TestVerdict({ state }: { state: TestState }): ReactElement | null {
  if (state.phase === 'idle') return null
  if (state.phase === 'testing') return <p className="iris-field__note">{t('testing')}</p>
  const named = state.of === undefined ? null : <>{t('connTestedRow', { name: state.of })} </>
  if (state.ok) {
    const count = state.models?.length ?? 0
    const source = keySourceText(state.keySource)
    return (
      <p className="iris-field__note">
        {named}
        {t(count === 1 ? 'testOkOne' : 'testOk', { latency: state.latencyMs, count })}
        {/*
          Which key produced the pass, beside the pass itself. A `stored` pass
          and a `typed` pass are different facts — one says the profile still
          works, the other says what is in the field right now does — and a
          form that reported only "ok" would let a user believe they had just
          validated a key they never sent.
        */}
        {source === undefined ? null : <> {source}</>}
      </p>
    )
  }
  return (
    <p className="iris-field__note iris-conn__test-error">
      {named}
      {state.errorText ?? t('testErrHttp')}
      {state.errorDetail === undefined
        ? null
        : <span className="iris-conn__test-detail">{state.errorDetail}</span>}
    </p>
  )
}

/**
 * What a row says about its key. A state, never a credential.
 * @param row - the saved provider's key facts, as a read returns them.
 * @param host - the host's row, whose environment key may cover this origin.
 * @returns the phrase for the row's meta line.
 */
function keyStateText(
  row: { hasKey?: boolean, keyTail?: string, baseURL?: string },
  host: HostDefaultConnection | undefined,
): string {
  if (row.hasKey === true) {
    return row.keyTail === undefined ? t('connKeySavedNoTail') : t('connKeySaved', { tail: row.keyTail })
  }
  // No key of this profile's own, but the host holds one for this very origin —
  // so it generates and tests without anything having been typed, and saying
  // 「无密钥」 here would be a fact about the file and a lie about the row.
  if (host?.keySource === 'env' && sameOrigin(host.baseURL, row.baseURL)) return t('connKeyFromHost')
  return t('connKeyNone')
}

/**
 * The extras a row carries when something already knows them.
 *
 * Read-only, and read from what the store already holds: no method is invented
 * here to fetch a context window or a probe time on demand. A figure nobody
 * recorded is simply absent from the row, which is the same rule the model
 * picker follows for its list.
 * @param model - the model the row is set to.
 * @param contexts - what is known about the ids' windows, keyed by id.
 * @param models - the recorded list.
 * @param probedAt - when that list was taken.
 * @returns the chips, in reading order.
 */
function rowExtras(
  model: string,
  contexts: Record<string, ModelContextLength> | undefined,
  models: readonly string[] | undefined,
  probedAt: number | undefined,
): readonly string[] {
  const out: string[] = []
  const window = contexts?.[model]
  if (window !== undefined) out.push(t('connModelWindow', { tokens: formatTokens(window.tokens, getLanguage()) }))
  if (models !== undefined && probedAt !== undefined) {
    out.push(t('connProbedAt', { count: models.length, when: since(probedAt, Date.now(), getLanguage()) }))
  }
  return out
}

/**
 * Render the connection section.
 * @returns the section.
 */
export function ConnectionPanel(): ReactElement {
  const profiles = useIris(state => state.connections)
  const activeId = useIris(state => state.activeConnectionId)
  const host = useIris(state => state.hostConnection)
  const origin = useIris(state => state.dataOrigin)
  const transport = useIris(state => state.transport)
  const actions = useIrisActions()

  /**
   * The editor's seed, or `undefined` for "closed".
   *
   * The editor is mounted from here rather than kept mounted and hidden, so
   * every open is a fresh mount with a fresh form: an editor whose state
   * survived being closed would open on the last profile's endpoint with the
   * next profile's name on the dialog.
   */
  const [editing, setEditing] = useState<FormState | undefined>(undefined)
  const [testState, setTestState] = useState<TestState>({ phase: 'idle' })
  /** The one transient sentence the panel says about its own last act. */
  const [note, setNote] = useState<
    'saved' | 'savedCurrent' | 'deleted' | 'deletedCurrent' | 'adopted' | undefined
  >(undefined)
  /** A model saved that the last list did not contain. A note, never a block. */
  const [offListModel, setOffListModel] = useState<string | undefined>(undefined)
  // Subscribed so a language switch re-renders the panel's words.
  useLanguage()

  useEffect(() => {
    void actions.loadConnections()
  }, [actions])

  const active = profiles.find(profile => profile.id === activeId)

  /**
   * Probe one row with the key the host already holds for it.
   *
   * A saved provider is named by id and nothing else: that is what lets the
   * host use the profile's stored key and file the model list against it. The
   * host row is probed by its endpoint, because it has no id to name.
   * @param params - `profileId` for a provider, `baseURL` for the host row.
   * @param of - the row's name, so the verdict says which row it is about.
   */
  const runProbe = async (params: { profileId?: string, baseURL?: string }, of: string): Promise<void> => {
    setTestState({ phase: 'testing', of })
    try {
      const result = await actions.testConnection(params)
      const detail = result.error === undefined ? undefined : testErrorDetail(result.error)
      setTestState({
        phase: 'done',
        ok: result.ok,
        latencyMs: result.latencyMs,
        keySource: result.keySource,
        of,
        ...(result.models === undefined ? {} : { models: result.models }),
        ...(result.error === undefined ? {} : { errorText: testErrorText(result.error) }),
        ...(detail === undefined ? {} : { errorDetail: detail }),
      })
    } catch (error: unknown) {
      // Refused before any probe ran — the fake client's honest answer, or a
      // malformed ask. The host's sentence is the one thing worth showing.
      setTestState({
        phase: 'done',
        ok: false,
        latencyMs: 0,
        keySource: 'none',
        of,
        errorText: t('testRefused', { message: error instanceof Error ? error.message : String(error) }),
      })
    }
  }

  /**
   * Adopt the host's own connection as an editable provider.
   *
   * One press, and the key does not travel: `adoptHostKey` asks the host to
   * copy the credential it already holds into the new profile. The browser
   * names a key it has never been shown.
   *
   * This used to double as the only way **back** to the host's connection,
   * which is why it carried the `connHostUseGap` sentence beside it. It does
   * not any more — the row's own 使用 is that way (web §78) — so what adopting
   * is for is what it says: an *editable* copy, whose endpoint, model or key
   * can then differ from the one the process was launched with.
   */
  const adoptHost = async (): Promise<void> => {
    // A profile must name a model — the protocol refuses one that does not — so
    // a host that never said which model it runs cannot be adopted in one
    // press. The button is disabled in that case rather than this being a
    // silent return only; both guards exist because either alone is a way for
    // the press to do nothing without saying so.
    if (host === undefined || host.model === undefined || host.model === '') return
    await actions.saveConnection({
      provider: host.provider,
      model: host.model,
      ...(host.baseURL === undefined ? {} : { baseURL: host.baseURL }),
      adoptHostKey: host.keySource === 'env',
    })
    setNote('adopted')
  }

  /** Delete a provider, and say what the list now shows as current. */
  const remove = async (id: string): Promise<void> => {
    const wasCurrent = id === activeId
    await actions.deleteConnection(id)
    // The host clears `activeId` when the deleted profile was the active one,
    // and the store takes `activeId` from that response rather than keeping it
    // — so the list's marker moves to the host row on its own and this
    // sentence only has to report where it went. What the *settings* layer
    // still holds after such a delete is the host's business
    // (`dev/route-resolution`), and this copy deliberately claims nothing
    // about it: it says the list has nothing selected, not that generation has
    // moved.
    setNote(wasCurrent ? 'deletedCurrent' : 'deleted')
    setTestState({ phase: 'idle' })
  }

  /**
   * What the collapsed section says it is set to: **name · model**, and only
   * that.
   *
   * The provider in use when there is one; otherwise the **host's own** row,
   * because a host generating happily from its environment used to collapse to
   * "no active connection" — a sentence that was true of the profile list and
   * a lie about the page. The model rides beside the name for §49's reason: a
   * label the user wrote can go stale, and the derived half cannot.
   */
  const summaryLine = active !== undefined
    ? [active.label ?? active.provider, active.model].filter(part => part !== '').join(' · ')
    : host === undefined
      ? t('noActiveConnection')
      : [t('hostDefaultTitle'), host.model].filter(part => part !== undefined && part !== '').join(' · ')

  /** The row the panel's own test block probes: the provider in use. */
  const currentTarget = active !== undefined
    ? { params: { profileId: active.id }, of: nameOf(active) }
    : host !== undefined && host.baseURL !== undefined && host.baseURL !== ''
      ? { params: { baseURL: host.baseURL }, of: t('hostDefaultTitle') }
      : undefined

  const noteText = ((): string | undefined => {
    switch (note) {
      case 'saved': return t('connSavedNote')
      case 'savedCurrent': return t('connSavedCurrent')
      case 'deleted': return t('connDeleted')
      case 'deletedCurrent': return t('connDeletedWasCurrent')
      case 'adopted': return t('hostAdopted')
      case undefined: return undefined
    }
  })()

  return (
    <CollapsibleSection
      id="connection"
      title={t('sectionConnection')}
      summary={summaryLine}
    >
      <div className="iris-conn-panel">
        {/*
          ------------------------------------------------------- 1. providers

          The list is the panel. Every row is one saved provider, under the
          read-only row the host was started with, and the only thing a press
          inside a row can do is name it: use it, edit it, test it, delete it.
        */}
        <div className="iris-conn-panel__block" data-block="providers">
          <div className="iris-conn-panel__head">
            <h4 className="iris-label iris-conn-panel__title">{t('connBlockProviders')}</h4>
            {/*
              **Which host this page is actually talking to**, said where the
              providers are listed.

              "Connection" already meant the provider profile — the model behind
              the conversation — and left the other connection unstated: the
              host serving this app and holding its chats. With more than one
              host in play (a dev instance and a probe instance), "is this page
              on 8787 or 8789?" is a question that has to be re-derived from the
              address bar every time, and an answer derived from somewhere else
              is an answer that can disagree.
            */}
            <p className="iris-field__note">
              {t('host')} <code>{origin}</code>
              {transport === 'fake' ? ` ${t('seededNotReal')}` : null}
            </p>
          </div>

          {/*
            **The connection the host itself was started with**, as the fixed
            first row.

            This used to be the absence at the top of the panel: a host
            configured from `IRIS_BASE_URL` / `IRIS_MODEL` / `IRIS_API_KEY_ENV`
            answered every message perfectly while the panel reported "no active
            connection" — true of the profile list, and useless as a report,
            because the thing doing the answering was right there and unnamed.

            Read-only, because it is not a profile: it has no id, it lives in
            the environment the process was launched with, and editing or
            deleting it here would be editing something this page cannot reach.
            **Selectable, though** — 使用 on this row is `connection.deactivate`,
            which puts the global layer back on the route and model the host was
            launched with and forgets which profile was applied. It used to
            carry a sentence explaining why it could not be chosen (web §77's
            first cost): the row read the *global settings layer*, so after any
            activation it described the profile in force, and a 「使用」 on it
            would have re-applied that profile under the host's name. Host §60
            snapshots the launch configuration and gives the store a clearing
            path, so the button is honest and the sentence is gone (web §78).

            It can also be tested, and it can be **saved as a provider** — one
            press, and the host copies its own credential into a real profile.
            The key does not pass through the browser in either direction.
          */}
          {host === undefined ? null : (
            <div className="iris-conn iris-conn--host" aria-current={activeId === undefined}>
              <div className="iris-conn__main">
                <span className="iris-conn__name">{t('hostDefaultTitle')}</span>
                {activeId === undefined
                  ? <span className="iris-conn__badge">{t('connCurrent')}</span>
                  : null}
                <span className="iris-conn__badge iris-conn__badge--quiet">{t('connReadOnly')}</span>
                <span className="iris-conn__summary">
                  {[
                    host.provider,
                    host.model,
                    host.baseURL === undefined ? t('hostDefaultEndpointRidden') : originOf(host.baseURL),
                  ].filter(part => part !== undefined && part !== '').join(' · ')}
                </span>
                <span className="iris-conn__meta">
                  {[
                    host.keySource === 'none'
                      ? t('hostDefaultNoKey')
                      : host.keyEnv === undefined
                        ? t('hostDefaultKeyAnon')
                        : t('hostDefaultKeyEnv', { env: host.keyEnv }),
                    ...rowExtras(host.model ?? '', host.modelContexts, host.models, host.modelsProbedAt),
                  ].join(' · ')}
                </span>
              </div>
              <div className="iris-conn__actions">
                {/*
                  Same verb, same position, same condition as a provider row's:
                  offered while this row is not the current one, and replaced by
                  the 「当前」 badge above when it is. A row that showed 使用 while
                  already in use would be a press with nothing to do.
                */}
                {activeId === undefined ? null : (
                  <button
                    type="button"
                    className="iris-act"
                    aria-label={t('connUseNamed', { name: t('hostDefaultTitle') })}
                    onClick={() => void actions.deactivateConnection()}
                  >
                    {t('connUse')}
                  </button>
                )}
                <button
                  type="button"
                  className="iris-act"
                  aria-label={t('connTestNamed', { name: t('hostDefaultTitle') })}
                  disabled={testState.phase === 'testing' || host.baseURL === undefined || host.baseURL === ''}
                  onClick={() => {
                    if (host.baseURL === undefined) return
                    void runProbe({ baseURL: host.baseURL }, t('hostDefaultTitle'))
                  }}
                >
                  {t('testConnection')}
                </button>
                <button
                  type="button"
                  className="iris-act"
                  disabled={host.model === undefined || host.model === ''}
                  onClick={() => void adoptHost()}
                >
                  {t('adoptHostConnection')}
                </button>
              </div>
            </div>
          )}
          {host === undefined ? null : (
            <>
              <p className="iris-field__note">{t('hostDefaultNote')}</p>
              {host.baseURL === undefined || host.baseURL === ''
                ? <p className="iris-field__note">{t('connTestNeedsEndpoint')}</p>
                : null}
            </>
          )}

          {profiles.length === 0 ? (
            <p className="iris-list__empty">{t('noSavedConnections')}</p>
          ) : (
            profiles.map(profile => {
              const name = nameOf(profile)
              const current = profile.id === activeId
              return (
                <div className="iris-conn" key={profile.id} aria-current={current}>
                  <div className="iris-conn__main">
                    {/*
                      The label when there is one, the summary when there is
                      not — and the summary regardless. A profile named after a
                      model it no longer uses is the exact failure this panel
                      exists to prevent, and the only defence is showing the
                      derived truth every time.
                    */}
                    <span className="iris-conn__name">{name}</span>
                    {current ? <span className="iris-conn__badge">{t('connCurrent')}</span> : null}
                    <span className="iris-conn__summary">{profile.summary}</span>
                    <span className="iris-conn__meta">
                      {[
                        profile.baseURL === undefined
                          ? t('hostDefaultEndpointRidden')
                          : originOf(profile.baseURL),
                        profile.model,
                        keyStateText(profile, host),
                        ...profile.preset === undefined || profile.preset === ''
                          ? []
                          : [`${t('connBoundPreset')} ${profile.preset}`],
                        ...rowExtras(
                          profile.model,
                          profile.modelContexts,
                          profile.models,
                          profile.modelsProbedAt,
                        ),
                      ].join(' · ')}
                    </span>
                  </div>
                  <div className="iris-conn__actions">
                    {current ? null : (
                      <button
                        type="button"
                        className="iris-act"
                        aria-label={t('connUseNamed', { name })}
                        onClick={() => void actions.activateConnection(profile.id)}
                      >
                        {t('connUse')}
                      </button>
                    )}
                    <button
                      type="button"
                      className="iris-act"
                      aria-label={t('connEditNamed', { name })}
                      onClick={() => {
                        // `formOf` brings the profile's recorded model list with
                        // it, so the editor opens on a dropdown rather than on a
                        // text field waiting for a probe already run once.
                        setEditing(formOf(profile))
                        setNote(undefined)
                        setOffListModel(undefined)
                      }}
                    >
                      {t('editConnection')}
                    </button>
                    <button
                      type="button"
                      className="iris-act"
                      aria-label={t('connTestNamed', { name })}
                      disabled={testState.phase === 'testing'}
                      onClick={() => void runProbe({ profileId: profile.id }, name)}
                    >
                      {t('testConnection')}
                    </button>
                    <button
                      type="button"
                      className="iris-act iris-act--danger"
                      aria-label={t('deleteNamed', { name })}
                      onClick={() => void remove(profile.id)}
                    >
                      {t('delete')}
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/*
          ------------------------------------------------------------ 2. add

          One button, and the two sentences that keep the panel's two verbs
          apart. Everything editable lives behind this button; nothing in the
          panel body is a field.
        */}
        <div className="iris-conn-panel__block" data-block="add">
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setEditing(freshForm())
              setNote(undefined)
              setOffListModel(undefined)
            }}
          >
            {t('connAddProvider')}
          </Button>
          <p className="iris-field__note">{t('connSaveVsUse')}</p>
          <p className="iris-field__note">{t('connUseNote')}</p>
          {/*
            Said here rather than assumed: using a provider re-points the host's
            adapter at its endpoint in place. A user who has met tools where a
            model swap means a restart reads this line first.
          */}
          <p className="iris-field__note">{t('activationImmediate')}</p>
          {noteText === undefined ? null : <p className="iris-field__note">{noteText}</p>}
          {offListModel === undefined ? null : (
            <p className="iris-field__note">{t('modelNotInList', { model: offListModel })}</p>
          )}
        </div>

        {/*
          ----------------------------------------------------------- 3. test

          One verdict area for the whole panel, whichever row asked. Two
          verdicts on screen at once would be two answers to "does this work",
          and the reader would have to work out which row each belonged to —
          so the row's name rides in the sentence instead.
        */}
        <div className="iris-conn-panel__block" data-block="test">
          <Button
            variant="outline"
            size="sm"
            disabled={testState.phase === 'testing' || currentTarget === undefined}
            onClick={() => {
              if (currentTarget === undefined) return
              void runProbe(currentTarget.params, currentTarget.of)
            }}
          >
            {t('connTestCurrent')}
          </Button>
          <TestVerdict state={testState} />
        </div>
      </div>

      {editing === undefined ? null : (
        <ProviderEditor
          seed={editing}
          host={host}
          onClose={() => setEditing(undefined)}
          onSaved={result => {
            setEditing(undefined)
            setOffListModel(result.offList ? result.model : undefined)
            setTestState({ phase: 'idle' })
            const wasCurrent = result.editId !== undefined && result.editId === activeId
            setNote(wasCurrent ? 'savedCurrent' : 'saved')
            /*
              **Editing the provider in use has to be re-applied.**
              `connection.save` writes the file and nothing else: it does not
              install an adapter for the profile's endpoint and does not rewrite
              the settings layer that names the route — only
              `connection.activate` does either (`service.ts`'s two handlers,
              read 2026-09-09). So a changed endpoint or model on the row in
              force would sit in the file while generation kept going to the old
              address. Re-using it is the host's own path for that, asked for
              here rather than added there.
            */
            if (wasCurrent && result.editId !== undefined) {
              void actions.activateConnection(result.editId)
            }
          }}
        />
      )}
    </CollapsibleSection>
  )
}

/**
 * The one place a provider is edited.
 *
 * Adding and editing are the same dialog with a different seed, because they
 * are the same decision: which endpoint, which credential, which model. A
 * second "new provider" form would be a second place for those three to
 * disagree with the file — which is exactly what the resident form this
 * replaced was.
 *
 * A `Modal` rather than an inline expansion, for two reasons. The drawer column
 * is narrow and this is six fields with their notes — `iris-conn-dialog` takes
 * its own measure the way `iris-prompt-dialog` and `iris-usage-dialog` do (§19's
 * finding: the primitive's card is 380px and clips, so the width has to be set
 * on the card). And the panel's guarantee that **nothing in its body is a
 * field** becomes structural: a closed `Modal` renders `null`, so there is no
 * hidden form left behind to drift out of step with the list.
 * @param props.seed - the form's starting values.
 * @param props.host - the host's row, for the "your key comes from here" note.
 * @param props.onClose - dismissed without saving.
 * @param props.onSaved - saved; the panel decides what to say and whether to re-apply.
 * @returns the dialog.
 */
function ProviderEditor({
  seed,
  host,
  onClose,
  onSaved,
}: {
  seed: FormState
  host: HostDefaultConnection | undefined
  onClose: () => void
  onSaved: (result: { editId?: string, model: string, offList: boolean }) => void
}): ReactElement {
  const presets = useIris(state => state.presets)
  const actions = useIrisActions()
  const [form, setForm] = useState<FormState>(seed)
  const [testState, setTestState] = useState<TestState>({ phase: 'idle' })
  useLanguage()

  // The preset library is loaded by its own panel rather than at boot, so
  // without this the bound-preset field would fall back to typing on a host
  // that has a library the reader simply has not opened yet.
  useEffect(() => {
    void actions.loadPresets()
  }, [actions])

  const preset = providerPreset(form.presetId)
  /**
   * Whether the **host's** credential covers the endpoint this form points at.
   *
   * Not a permission — the host decides that with its own origin check — but
   * the difference between a key field that looks unfilled and one that says
   * why it can stay empty. Origin-scoped for the same reason the host's rule
   * is: a host key answers for the host's endpoint and for no other.
   */
  const hostSuppliesKey = host?.keySource === 'env' && sameOrigin(host.baseURL, form.baseURL)
  const patchForm = (patch: Partial<FormState>): void => { setForm(current => ({ ...current, ...patch })) }

  /**
   * Forget the model list.
   *
   * Called wherever the endpoint moves. A list survives a *re-render*, never an
   * endpoint change: options from the address the form used to point at are
   * another server's answer, and offering them would be the one failure the
   * dropdown exists to prevent, arrived at from the other side.
   */
  const forgetModels = (): void => {
    setForm(current => {
      const { models: _dropped, modelsProbedAt: _stamp, ...rest } = current
      return rest
    })
    setTestState({ phase: 'idle' })
  }

  /** Point the form at a preset: endpoint prefilled, model list dropped. */
  const choosePreset = (id: string): void => {
    const chosen = providerPreset(id)
    setForm(current => {
      const { models: _dropped, modelsProbedAt: _stamp, ...rest } = current
      return {
        ...rest,
        presetId: id,
        baseURL: chosen === undefined || chosen.baseURL === '' ? current.baseURL : chosen.baseURL,
      }
    })
    setTestState({ phase: 'idle' })
  }

  /**
   * Run the probe against what the form holds right now.
   *
   * The key goes only when the field has something in it. **An empty field is
   * not an omission** — it is the request that makes this form usable twice:
   * the host falls back to the profile's stored key or its own environment
   * credential, at that endpoint's origin and nowhere else, and says which in
   * `keySource`. `profileId` rides along when a saved provider is open, so the
   * host knows whose stored key is in play and where to file the model list.
   */
  const runTest = async (): Promise<void> => {
    setTestState({ phase: 'testing' })
    try {
      const result = await actions.testConnection({
        baseURL: form.baseURL,
        ...(form.editId === undefined ? {} : { profileId: form.editId }),
        ...(form.apiKey === '' ? {} : { apiKey: form.apiKey }),
        ...(preset?.apiKeyHeader === undefined ? {} : { apiKeyHeader: preset.apiKeyHeader }),
        ...(form.presetId === 'custom' ? {} : { preset: form.presetId }),
      })
      if (result.ok) {
        patchForm({ models: result.models ?? [], modelsProbedAt: Date.now() })
        setTestState({
          phase: 'done',
          ok: true,
          latencyMs: result.latencyMs,
          keySource: result.keySource,
          ...(result.models === undefined ? {} : { models: result.models }),
        })
      } else {
        const detail = result.error === undefined ? undefined : testErrorDetail(result.error)
        setTestState({
          phase: 'done',
          ok: false,
          latencyMs: result.latencyMs,
          keySource: result.keySource,
          ...(result.error === undefined ? {} : { errorText: testErrorText(result.error) }),
          ...(detail === undefined ? {} : { errorDetail: detail }),
        })
      }
    } catch (error: unknown) {
      setTestState({
        phase: 'done',
        ok: false,
        latencyMs: 0,
        keySource: 'none',
        errorText: t('testRefused', { message: error instanceof Error ? error.message : String(error) }),
      })
    }
  }

  /** Save what the form holds, as a new provider or as the one being edited. */
  const save = async (): Promise<void> => {
    if (form.model.length === 0) return
    const label = form.label.trim()
    const bound = form.boundPreset.trim()
    await actions.saveConnection({
      ...(form.editId === undefined ? {} : { id: form.editId }),
      provider: form.presetId === 'custom' && form.originalProvider !== undefined
        ? form.originalProvider
        : form.presetId,
      model: form.model,
      // An absent field clears on a replacement, exactly as the protocol says
      // every non-secret one does — which is what makes the name and the bound
      // preset editable rather than write-once.
      ...(label === '' ? {} : { label }),
      ...(bound === '' ? {} : { preset: bound }),
      ...(form.originalSampling === undefined ? {} : { sampling: form.originalSampling }),
      ...(form.baseURL.length === 0 ? {} : { baseURL: form.baseURL }),
      ...(form.clearKey ? { apiKey: '' } : form.apiKey === '' ? {} : { apiKey: form.apiKey }),
      ...(preset?.apiKeyHeader === undefined ? {} : { apiKeyHeader: preset.apiKeyHeader }),
      // The probed list travels with the save, so a provider created from an
      // unsaved form arrives with the list its own probe produced — the host
      // files it against a profile id that did not exist when the probe ran.
      ...(form.models === undefined ? {} : { models: form.models }),
    })
    // Said, not enforced. A model the last list did not carry is very often
    // correct — a list can be incomplete, a provider can serve aliases — so
    // the save goes through and the disagreement is reported. Blocking here
    // would make the dropdown a cage rather than a shortcut.
    onSaved({
      ...(form.editId === undefined ? {} : { editId: form.editId }),
      model: form.model,
      offList: form.models !== undefined && !form.models.includes(form.model),
    })
  }

  const offList = form.models !== undefined && form.model !== '' && !form.models.includes(form.model)

  return (
    <Modal
      open
      onClose={onClose}
      title={form.editId === undefined ? t('connAddProvider') : t('connEditorEditTitle')}
      closeLabel={t('close')}
      /*
        The primitive's dialog card is 380px wide and clips its overflow, so a
        six-field form with notes has to carry its own measure — the same
        finding `iris-prompt-dialog` and `iris-usage-dialog` record.
      */
      className="iris-conn-dialog"
    >
      <div className="iris-conn-editor">
        {/*
          A provider is chosen, not typed — a preset is an endpoint and a
          credential convention, and picking one is what stops a profile from
          being named DeepSeek while pointing somewhere else.
        */}
        <div className="iris-field">
          <span className="iris-field__label">{t('providerPreset')}</span>
          <span />
          <select
            className="iris-text iris-field__control"
            value={form.presetId}
            aria-label={t('providerPreset')}
            onChange={event => { choosePreset(event.target.value) }}
          >
            {PROVIDER_PRESETS.map(entry => (
              <option key={entry.id} value={entry.id}>
                {entry.id === 'custom' ? t('presetCustom') : entry.id}
              </option>
            ))}
          </select>
        </div>

        {/*
          The reader's own words. Optional, and a row with none falls back to
          the derived summary rather than to an id.
        */}
        <div className="iris-field">
          <span className="iris-field__label">{t('connProviderName')}</span>
          <span />
          <input
            className="iris-text iris-field__control"
            type="text"
            value={form.label}
            placeholder={t('connProviderNamePlaceholder')}
            aria-label={t('connProviderName')}
            onChange={event => { patchForm({ label: event.target.value }) }}
          />
        </div>

        <div className="iris-field">
          <span className="iris-field__label">{t('endpointBaseURL')}</span>
          <span />
          <input
            className="iris-text iris-field__control"
            type="text"
            value={form.baseURL}
            placeholder="https://…/v1"
            aria-label={t('endpointBaseURL')}
            spellCheck={false}
            onChange={event => {
              // The endpoint moved, so the model list is another server's answer.
              patchForm({ baseURL: event.target.value })
              if (form.models !== undefined) forgetModels()
            }}
          />
        </div>

        {/*
          The key field. Password-typed, so a shoulder reads nothing; a saved
          key is announced only by its mask, because the interface was never
          given one to show. A local serve (Ollama, llama.cpp, LM Studio) says
          so instead of asking for a credential it would never use.

          **Blank means keep.** `value` is `form.apiKey`, which starts empty on
          every edit and is never seeded from a read — there is nothing to seed
          it from. The placeholder is what changes: when a key is already held,
          it says to leave the field alone, because the alternative reading of
          an empty required-looking field is "you must paste it again", and a
          key most providers show once cannot be pasted again.
        */}
        {preset?.local === true ? (
          <p className="iris-field__note">{t('presetNoKey')}</p>
        ) : (
          <div className="iris-field">
            <span className="iris-field__label">{t('apiKeyLabel')}</span>
            <span />
            <input
              className="iris-text iris-field__control"
              type="password"
              value={form.apiKey}
              placeholder={form.hasKey || hostSuppliesKey ? t('apiKeyPlaceholderKeep') : t('apiKeyPlaceholder')}
              aria-label={t('apiKeyLabel')}
              autoComplete="off"
              spellCheck={false}
              onChange={event => { patchForm({ apiKey: event.target.value, clearKey: false }) }}
            />
            {form.clearKey ? (
              <p className="iris-field__note">{t('keyWillClear')}</p>
            ) : form.hasKey && form.apiKey === '' ? (
              <p className="iris-field__note">
                {form.keyTail === undefined
                  ? t('apiKeyStoredNoTail')
                  : t('apiKeyStored', { tail: form.keyTail })}
                {' '}
                {/* Clearing is an explicit act, never a side effect of an empty field. */}
                <button type="button" className="iris-act" onClick={() => { patchForm({ clearKey: true }) }}>
                  {t('clearKey')}
                </button>
              </p>
            ) : hostSuppliesKey && form.apiKey === '' ? (
              /*
                No key of this profile's own, but the host holds one for this
                very origin — so a probe from here will pass without anything
                being typed, and saying nothing would leave the reader looking
                for a key they were never given.
              */
              <p className="iris-field__note">
                {host?.keyEnv === undefined
                  ? t('apiKeyFromHostNoName')
                  : t('apiKeyFromHost', { env: host.keyEnv })}
              </p>
            ) : null}
          </div>
        )}

        {/*
          **The model is picked, not typed** — the request the user made of this
          panel, and upstream's own shape (`model_openai_select`, filled from
          `/models`).

          Three states, kept apart because they are three different facts:

          - a list with entries → a real `<select>`, with the current value kept
            as a row of its own when the list does not carry it, so choosing from
            the list can never be the thing that loses a working model name;
          - a list that came back **empty** → the endpoint answered and offers
            nothing, so the field falls back to typing and says that;
          - **no list at all** → nobody has probed yet, which is a different
            sentence and a different next step (press Test).

          The fallback is a text input rather than an empty dropdown on purpose:
          a dropdown with no options is a control that cannot be used and does
          not explain itself.
        */}
        <div className="iris-field">
          <span className="iris-field__label">{t('modelLabel')}</span>
          <span />
          {form.models !== undefined && form.models.length > 0 ? (
            <select
              className="iris-text iris-field__control"
              value={form.model}
              aria-label={t('modelLabel')}
              onChange={event => { patchForm({ model: event.target.value }) }}
            >
              {form.model === '' || form.models.includes(form.model) ? null : (
                <option value={form.model}>{t('modelCustomCurrent', { model: form.model })}</option>
              )}
              {form.models.map(model => <option key={model} value={model}>{model}</option>)}
            </select>
          ) : (
            <input
              className="iris-text iris-field__control"
              type="text"
              value={form.model}
              aria-label={t('modelLabel')}
              spellCheck={false}
              onChange={event => { patchForm({ model: event.target.value }) }}
            />
          )}
          <p className="iris-field__note">
            {form.models === undefined
              ? t('modelsNoneYet')
              : form.models.length === 0
                ? t('modelsEndpointOffersNone')
                : form.modelsProbedAt === undefined
                  ? t('modelsFromEndpoint', { count: form.models.length })
                  : t('modelsProbedAt', {
                    count: form.models.length,
                    when: since(form.modelsProbedAt, Date.now(), getLanguage()),
                  })}
            {/* Marked while it can still be changed, not only after the save. */}
            {offList ? <> {t('modelOffListNote')}</> : null}
            {' '}
            {/*
              Refreshing *is* testing — one probe, one list — so this is the same
              action under the name that answers the question the dropdown raises.
              A second method that fetched models without reporting latency and
              key source would be a second, quieter verdict.
            */}
            <button
              type="button"
              className="iris-act"
              disabled={testState.phase === 'testing' || form.baseURL.length === 0}
              onClick={() => void runTest()}
            >
              {t('refreshModels')}
            </button>
          </p>
        </div>

        {/*
          The preset this provider is bound to — upstream's
          `bind_preset_to_connection`, which the host honours on a global
          switch. Picked from the library when the library is readable, for the
          model field's reason: a preset name that does not exist is a switch
          that silently does not happen.
        */}
        <div className="iris-field">
          <span className="iris-field__label">{t('connBoundPreset')}</span>
          <span />
          {presets === undefined ? (
            <input
              className="iris-text iris-field__control"
              type="text"
              value={form.boundPreset}
              aria-label={t('connBoundPreset')}
              spellCheck={false}
              onChange={event => { patchForm({ boundPreset: event.target.value }) }}
            />
          ) : (
            <select
              className="iris-text iris-field__control"
              value={form.boundPreset}
              aria-label={t('connBoundPreset')}
              onChange={event => { patchForm({ boundPreset: event.target.value }) }}
            >
              <option value="">{t('connBoundPresetNone')}</option>
              {/*
                A bound name the library does not carry keeps its own row, so
                opening the editor cannot be the thing that unbinds it.
              */}
              {form.boundPreset === '' || presets.some(entry => entry.name === form.boundPreset) ? null : (
                <option value={form.boundPreset}>{t('modelCustomCurrent', { model: form.boundPreset })}</option>
              )}
              {presets.map(entry => <option key={entry.name} value={entry.name}>{entry.name}</option>)}
            </select>
          )}
          <p className="iris-field__note">
            {presets === undefined ? t('connPresetsUnknown') : t('connBoundPresetNote')}
          </p>
        </div>

        <div className="iris-conn__save">
          <Button
            variant="outline"
            size="sm"
            disabled={testState.phase === 'testing' || form.baseURL.length === 0}
            onClick={() => void runTest()}
          >
            {t('testConnection')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={form.model.length === 0}
            onClick={() => void save()}
          >
            {form.editId === undefined ? t('saveThisConnection') : t('updateConnection')}
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('cancelEdit')}
          </Button>
        </div>
        <TestVerdict state={testState} />
      </div>
    </Modal>
  )
}
