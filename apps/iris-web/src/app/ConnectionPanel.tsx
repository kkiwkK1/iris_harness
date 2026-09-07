/**
 * Choosing where a conversation is sent, and — since connections carry
 * endpoints of their own — pointing it there without leaving the page.
 *
 * One rule shapes every line of this file: **a name is not evidence of where a
 * profile goes.** Measured on a real SillyTavern install, the profile the user
 * had selected was called `deepseek deepseek-chat` and actually pointed at
 * Gemini, through a different endpoint, with a different preset. Upstream stores
 * the display name as a snapshot taken at creation, so it was true for a moment
 * and wrong from then on.
 *
 * The contract's answer is that `summary` is derived on every read and never
 * stored. The interface's answer is that **the summary is always on screen** —
 * beside a user's own label, not instead of it. A label the user wrote can also
 * go stale; the difference is that going stale is then their own doing, and they
 * can still see the truth next to it.
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
 * list: a current value the list does not contain stays as a row of its own,
 * and no list at all falls back to a text field **with the reason on screen**
 * rather than to an empty dropdown.
 *
 * @module iris-web/app/ConnectionPanel
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { PROVIDER_PRESETS, providerPreset, type ConnectionKeySource, type ConnectionTestError } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { CollapsibleSection } from './fields.tsx'
import { since } from './format.ts'
import { getLanguage } from './i18n/language.ts'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * Whether two endpoints are the same place, for deciding whose key a field is
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
 * An endpoint's origin, for the short form a summary shows.
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

/** What the form holds while it is being edited. */
interface FormState {
  /** The provider preset the form is pointed at, or `'custom'`. */
  presetId: string
  /** The endpoint, prefilled from the preset. */
  baseURL: string
  /** The model, typed or picked from a probe's list. */
  model: string
  /** The key as typed. Held here only — a save sends it once and forgets it. */
  apiKey: string
  /** The profile's own provider when editing, which a legacy route preserves. */
  originalProvider?: string
  /** The profile being edited, or absent for a new one. */
  editId?: string
  /** The bound preset, label and sampling an edit must carry through untouched. */
  originalPreset?: string
  originalLabel?: string
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
  /**
   * Ask the host to copy **its own** credential into the profile this form
   * saves.
   *
   * Set only by {@link formOfHost}, so it can only ever be true for a form that
   * was seeded from the host's row. Without it, editing that row before saving
   * would produce a profile with the host's endpoint and no key — a connection
   * that looks right and cannot generate, which is worse than not offering the
   * edit at all.
   */
  adoptHostKey?: boolean
}

/** A fresh form, pointed at the first preset. */
function freshForm(): FormState {
  const first = PROVIDER_PRESETS[0]
  return {
    presetId: first?.id ?? 'custom',
    baseURL: first?.baseURL ?? '',
    model: '',
    apiKey: '',
    hasKey: false,
    clearKey: false,
  }
}

/** Load the form from a saved profile, for editing. */
function formOf(profile: {
  id: string
  label?: string
  provider: string
  model: string
  preset?: string
  sampling?: Record<string, unknown>
  baseURL?: string
  hasKey?: boolean
  keyTail?: string
  models?: string[]
  modelsProbedAt?: number
}): FormState {
  return {
    // A provider that is one of the presets selects it; anything else — a
    // legacy route like `default` — is the user's own endpoint, and the form
    // says so by showing `custom` while keeping the original route on save.
    presetId: providerPreset(profile.provider) === undefined ? 'custom' : profile.provider,
    baseURL: profile.baseURL ?? providerPreset(profile.provider)?.baseURL ?? '',
    model: profile.model,
    apiKey: '',
    originalProvider: profile.provider,
    editId: profile.id,
    ...profile.preset === undefined ? {} : { originalPreset: profile.preset },
    ...profile.label === undefined ? {} : { originalLabel: profile.label },
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
 * A form seeded from the host's own connection, for adopting it.
 *
 * No key, and none asked for: the host copies its own credential across when
 * the save carries `adoptHostKey`, so the field this form leaves blank is
 * exactly the field the browser must never fill.
 * @param host - the read-only host row.
 * @returns a form pointed at the host's endpoint and model.
 */
function formOfHost(host: { provider: string, baseURL?: string, model?: string, keySource: 'env' | 'none' }): FormState {
  return {
    presetId: providerPreset(host.provider) === undefined ? 'custom' : host.provider,
    baseURL: host.baseURL ?? '',
    model: host.model ?? '',
    apiKey: '',
    originalProvider: host.provider,
    hasKey: false,
    clearKey: false,
    adoptHostKey: host.keySource === 'env',
  }
}

/**
 * The sentence a probe's named error means, in the language in force.
 * @param error - the failure half of a probe result.
 * @returns the copy for it, falling back to the host's own words.
 */
function testErrorText(error: ConnectionTestError): string {
  switch (error.code) {
    case 'missing-key': return t('testErrMissingKey')
    case 'unauthorized': return t('testErrUnauthorized')
    case 'timeout': return t('testErrTimeout')
    case 'network': return t('testErrNetwork')
    case 'http-error': return t('testErrHttp')
    case 'bad-response': return t('testErrBadResponse')
    case 'no-endpoint': return t('testErrNoEndpoint')
  }
}

/**
 * Render the connection section.
 * @returns the section.
 */
export function ConnectionPanel(): ReactElement {
  const profiles = useIris(state => state.connections)
  const activeId = useIris(state => state.activeConnectionId)
  const host = useIris(state => state.hostConnection)
  const settings = useIris(state => state.settings)
  const chatId = useIris(state => state.chatId)
  const origin = useIris(state => state.dataOrigin)
  const transport = useIris(state => state.transport)
  const actions = useIrisActions()

  const [form, setForm] = useState<FormState>(freshForm)
  const [testState, setTestState] = useState<
    | { phase: 'idle' }
    | { phase: 'testing' }
    | {
      phase: 'done'
      ok: boolean
      latencyMs: number
      models?: string[]
      keySource: ConnectionKeySource
      errorText?: string
    }
  >({ phase: 'idle' })
  const [savedNote, setSavedNote] = useState(false)
  /** A model saved that the last list did not contain. A note, never a block. */
  const [offListModel, setOffListModel] = useState<string | undefined>(undefined)
  const [adoptedNote, setAdoptedNote] = useState(false)
  const [naming, setNaming] = useState(false)
  const [label, setLabel] = useState('')
  // Subscribed so a language switch re-renders the panel's words.
  useLanguage()

  useEffect(() => {
    void actions.loadConnections()
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
    setOffListModel(undefined)
  }

  /** Point the form at a preset: endpoint prefilled, key fields reset. */
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
    setOffListModel(undefined)
  }

  /**
   * Run the probe against what the form holds right now.
   *
   * The key goes only when the field has something in it. **An empty field is
   * not an omission** — it is the request that makes this form usable twice:
   * the host falls back to the profile's stored key or its own environment
   * credential, at that endpoint's origin and nowhere else, and says which in
   * `keySource`. `profileId` rides along when a saved profile is open, so the
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
        setTestState({
          phase: 'done',
          ok: false,
          latencyMs: result.latencyMs,
          keySource: result.keySource,
          ...(result.error === undefined ? {} : { errorText: testErrorText(result.error) }),
        })
      }
    } catch (error: unknown) {
      // Refused before any probe ran — the fake client's honest answer, or a
      // malformed ask. The host's sentence is the one thing worth showing.
      setTestState({
        phase: 'done',
        ok: false,
        latencyMs: 0,
        keySource: 'none',
        errorText: t('testRefused', { message: error instanceof Error ? error.message : String(error) }),
      })
    }
  }

  /**
   * Adopt the host's own connection as an editable profile.
   *
   * One press, and the key does not travel: `adoptHostKey` asks the host to
   * copy the credential it already holds into the new profile. The browser
   * names a key it has never been shown.
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
    setAdoptedNote(true)
  }

  /** Save what the form holds, as a new profile or as the one being edited. */
  const save = async (): Promise<void> => {
    if (form.model.length === 0) return
    await actions.saveConnection({
      ...(form.editId === undefined ? {} : { id: form.editId }),
      provider: form.presetId === 'custom' && form.originalProvider !== undefined
        ? form.originalProvider
        : form.presetId,
      model: form.model,
      ...(form.originalLabel === undefined ? {} : { label: form.originalLabel }),
      ...(form.originalPreset === undefined ? {} : { preset: form.originalPreset }),
      ...(form.originalSampling === undefined ? {} : { sampling: form.originalSampling }),
      ...(form.baseURL.length === 0 ? {} : { baseURL: form.baseURL }),
      ...(form.clearKey ? { apiKey: '' } : form.apiKey === '' ? {} : { apiKey: form.apiKey }),
      // Only ever set by a form seeded from the host's row, and the host
      // ignores it if it holds no credential or a key was typed instead.
      ...(form.adoptHostKey === true && !form.clearKey ? { adoptHostKey: true } : {}),
      ...(preset?.apiKeyHeader === undefined ? {} : { apiKeyHeader: preset.apiKeyHeader }),
      // The probed list travels with the save, so a profile created from an
      // unsaved form arrives with the list its own probe produced — the host
      // files it against a profile id that did not exist when the probe ran.
      ...(form.models === undefined ? {} : { models: form.models }),
    })
    // Said, not enforced. A model the last list did not carry is very often
    // correct — a list can be incomplete, a provider can serve aliases — so
    // the save goes through and the disagreement is reported. Blocking here
    // would make the dropdown a cage rather than a shortcut.
    setOffListModel(
      form.models !== undefined && !form.models.includes(form.model) ? form.model : undefined,
    )
    // The form is done with what it held: the key least of all — the stored
    // one (if any) is only ever described by the list's next read.
    setForm(freshForm())
    setTestState({ phase: 'idle' })
    setSavedNote(true)
  }

  /** The sentence for which key the probe sent. Silent for a local serve. */
  const keySourceText = (source: ConnectionKeySource): string | undefined => {
    switch (source) {
      case 'typed': return t('testKeyTyped')
      case 'stored': return t('testKeyStored')
      case 'host': return t('testKeyHost')
      case 'none': return undefined
    }
  }

  const testLine = (): ReactElement | null => {
    if (testState.phase === 'idle') return null
    if (testState.phase === 'testing') return <p className="iris-field__note">{t('testing')}</p>
    if (testState.ok) {
      const count = testState.models?.length ?? 0
      const source = keySourceText(testState.keySource)
      return (
        <p className="iris-field__note">
          {t(count === 1 ? 'testOkOne' : 'testOk', { latency: testState.latencyMs, count })}
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
    return <p className="iris-field__note iris-conn__test-error">{testState.errorText ?? t('testErrHttp')}</p>
  }

  const active = profiles.find(profile => profile.id === activeId)
  /**
   * What the collapsed section says it is set to.
   *
   * The active profile when there is one; otherwise the **host's own** row,
   * because a host generating happily from its environment used to collapse to
   * "no active connection" — a sentence that was true of the profile list and
   * a lie about the page.
   */
  const summaryLine = active !== undefined
    ? active.label ?? active.summary
    : host === undefined
      ? t('noActiveConnection')
      : `${t('hostDefaultTitle')} · ${[host.provider, host.model].filter(part => part !== undefined && part !== '').join(' · ')}`

  return (
    <CollapsibleSection
      id="connection"
      title={t('sectionConnection')}
      summary={summaryLine}
    >
      {/*
        **Which host this page is actually talking to**, said before anything
        about providers.

        "Connection" already meant the provider profile — the model behind the
        conversation — and left the other connection unstated: the host serving
        this app and holding its chats. With more than one host in play (a dev
        instance and a probe instance), "is this page on 8787 or 8789?" is a
        question that has to be re-derived from the address bar every time, and
        an answer derived from somewhere else is an answer that can disagree.

        `dataOrigin` is where the store already keeps it, and it was written and
        **never read** until now — the field's own doc says it exists "because
        the interface has to be able to say it", and only its sibling
        (`transport`) had ever been rendered. No new protocol: the value is what
        the page was built against.
      */}
      <p className="iris-field__note">
        {t('host')} <code>{origin}</code>
        {transport === 'fake' ? ` ${t('seededNotReal')}` : null}
      </p>

      {/*
        **The connection the host itself was started with**, as a row.

        This used to be the absence at the top of the panel: a host configured
        from `IRIS_BASE_URL` / `IRIS_MODEL` / `IRIS_API_KEY_ENV` answered every
        message perfectly while the panel reported "no active connection" —
        true of the profile list, and useless as a report, because the thing
        doing the answering was right there and unnamed.

        Read-only, because it is not a profile: it has no id, it lives in the
        environment the process was launched with, and editing it here would be
        editing something this page cannot reach. What the reader *can* do is
        adopt it — one press, and the host copies its own credential into a real
        profile. The key does not pass through the browser in either direction.
      */}
      {host === undefined ? null : (
        <div className="iris-conn iris-conn--host">
          <span className="iris-conn__name">{t('hostDefaultTitle')}</span>
          <span className="iris-conn__summary">
            {[
              host.provider,
              host.model,
              host.baseURL === undefined ? t('hostDefaultEndpointRidden') : originOf(host.baseURL),
            ].filter(part => part !== undefined && part !== '').join(' · ')}
          </span>
          <span className="iris-conn__summary">
            {host.keySource === 'none'
              ? t('hostDefaultNoKey')
              : host.keyEnv === undefined
                ? t('hostDefaultKeyAnon')
                : t('hostDefaultKeyEnv', { env: host.keyEnv })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={host.model === undefined || host.model === ''}
            onClick={() => void adoptHost()}
          >
            {t('adoptHostConnection')}
          </Button>
          <button
            type="button"
            className="iris-act"
            onClick={() => { setForm(formOfHost(host)); setTestState({ phase: 'idle' }); setSavedNote(false) }}
          >
            {t('editConnection')}
          </button>
        </div>
      )}
      {host === undefined ? null : <p className="iris-field__note">{t('hostDefaultNote')}</p>}
      {adoptedNote ? <p className="iris-field__note">{t('hostAdopted')}</p> : null}

      {/*
        The connection editor. A provider is chosen, not typed — a preset is an
        endpoint and a credential convention, and picking one is what stops a
        profile from being named DeepSeek while pointing somewhere else.
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
        The key field. Password-typed, so a shoulder reads nothing; a saved key
        is announced only by its mask, because the interface was never given
        one to show. A local serve (Ollama, llama.cpp, LM Studio) says so
        instead of asking for a credential it would never use.

        **Blank means keep.** `value` is `form.apiKey`, which starts empty on
        every edit and is never seeded from a read — there is nothing to seed it
        from. The placeholder is what changes: when a key is already held, it
        says to leave the field alone, because the alternative reading of an
        empty required-looking field is "you must paste it again", and a key
        most providers show once cannot be pasted again.
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
              No key of this profile's own, but the host holds one for this very
              origin — so a probe from here will pass without anything being
              typed, and saying nothing would leave the reader looking for a key
              they were never given.
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

        The fallback is a text input rather than an empty dropdown on purpose: a
        dropdown with no options is a control that cannot be used and does not
        explain itself.
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
      {offListModel === undefined ? null : (
        <p className="iris-field__note">{t('modelNotInList', { model: offListModel })}</p>
      )}

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
        {form.editId !== undefined ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setForm(freshForm())
              setTestState({ phase: 'idle' })
              setSavedNote(false)
              setOffListModel(undefined)
            }}
          >
            {t('cancelEdit')}
          </Button>
        ) : null}
      </div>
      {testLine()}
      {savedNote ? <p className="iris-field__note">{t('savedTakesEffect')}</p> : null}

      {profiles.length === 0 ? (
        <p className="iris-list__empty">{t('noSavedConnections')}</p>
      ) : (
        profiles.map(profile => (
          <div className="iris-conn" key={profile.id} aria-current={profile.id === activeId}>
            <button
              type="button"
              className="iris-conn__pick"
              onClick={() => void actions.activateConnection(profile.id)}
            >
              {/*
                The label when there is one, the summary when there is not — and
                the summary regardless. A profile named after a model it no longer
                uses is the exact failure this panel exists to prevent, and the
                only defence is showing the derived truth every time.
              */}
              <span className="iris-conn__name">{profile.label ?? profile.summary}</span>
              <span className="iris-conn__summary">{profile.summary}</span>
            </button>
            <button
              type="button"
              className="iris-act"
              onClick={() => {
                // `formOf` brings the profile's recorded model list with it, so
                // the editor opens on a dropdown rather than on a text field
                // waiting for a probe the user already ran once.
                setForm(formOf(profile))
                setTestState({ phase: 'idle' })
                setSavedNote(false)
                setOffListModel(undefined)
              }}
            >
              {t('editConnection')}
            </button>
            <button
              type="button"
              className="iris-act iris-act--danger"
              aria-label={t('deleteNamed', { name: profile.label ?? profile.summary })}
              onClick={() => void actions.deleteConnection(profile.id)}
            >
              {t('delete')}
            </button>
          </div>
        ))
      )}

      <p className="iris-field__note">
        {chatId === undefined ? t('activateForDefaults') : t('activateForThisChat')}
      </p>
      {/*
        Said here rather than assumed: activation re-points the host's adapter
        at the profile's endpoint in place. A user who has met tools where a
        model swap means a restart reads this line first.
      */}
      <p className="iris-field__note">{t('activationImmediate')}</p>

      {/*
        Saving captures what is in force right now rather than opening an editor:
        the Route and Sampling fields in the drawer already are that editor, and a
        second one would be two places to change the same thing. The form above is
        the other path — a connection built from a provider out — and the two
        answer different questions.
      */}
      {settings === undefined ? null : naming ? (
        <div className="iris-conn__save">
          <input
            className="iris-text"
            autoFocus
            value={label}
            placeholder={t('nameThisConnection')}
            aria-label={t('connectionName')}
            onChange={event => setLabel(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') setNaming(false)
            }}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              const named = label.trim()
              setNaming(false)
              setLabel('')
              void actions.saveConnection({
                provider: settings.provider,
                model: settings.model,
                ...(named === '' ? {} : { label: named }),
                sampling: { ...settings },
              })
            }}
          >
            {t('save')}
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setNaming(true)}>
          {t('saveConnection')}
        </Button>
      )}
    </CollapsibleSection>
  )
}
