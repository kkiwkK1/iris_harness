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
 * The editor keeps two more rules. **The key is typed, never shown**: a saved
 * key is announced only as a mask with its last four characters, because no
 * read ever returned it and the form must not pretend it can. **Testing comes
 * before trusting**: the probe's verdict is rendered verbatim — latency and
 * model count, or the named reason it said no — because "it should work" is
 * the one sentence a connection form has no business saying.
 *
 * @module iris-web/app/ConnectionPanel
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { PROVIDER_PRESETS, providerPreset, type ConnectionTestError } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { Section } from './fields.tsx'
import { useLanguage, t } from './i18n/use-language.ts'

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
  const settings = useIris(state => state.settings)
  const chatId = useIris(state => state.chatId)
  const origin = useIris(state => state.dataOrigin)
  const transport = useIris(state => state.transport)
  const actions = useIrisActions()

  const [form, setForm] = useState<FormState>(freshForm)
  // The models the last successful probe offered. Held only until the next
  // probe or edit: a stale list is a list from an endpoint this form no
  // longer points at.
  const [models, setModels] = useState<string[]>([])
  const [testState, setTestState] = useState<
    | { phase: 'idle' }
    | { phase: 'testing' }
    | { phase: 'done', ok: boolean, latencyMs: number, models?: string[], errorText?: string }
  >({ phase: 'idle' })
  const [savedNote, setSavedNote] = useState(false)
  const [naming, setNaming] = useState(false)
  const [label, setLabel] = useState('')
  // Subscribed so a language switch re-renders the panel's words.
  useLanguage()

  useEffect(() => {
    void actions.loadConnections()
  }, [actions])

  const preset = providerPreset(form.presetId)
  const patchForm = (patch: Partial<FormState>): void => { setForm(current => ({ ...current, ...patch })) }

  /** Point the form at a preset: endpoint prefilled, key fields reset. */
  const choosePreset = (id: string): void => {
    const chosen = providerPreset(id)
    setForm(current => ({
      ...current,
      presetId: id,
      baseURL: chosen === undefined || chosen.baseURL === '' ? current.baseURL : chosen.baseURL,
    }))
    setModels([])
    setTestState({ phase: 'idle' })
  }

  /** Run the probe against what the form holds right now. */
  const runTest = async (): Promise<void> => {
    setTestState({ phase: 'testing' })
    try {
      const result = await actions.testConnection({
        baseURL: form.baseURL,
        ...(form.apiKey === '' ? {} : { apiKey: form.apiKey }),
        ...(preset?.apiKeyHeader === undefined ? {} : { apiKeyHeader: preset.apiKeyHeader }),
        ...(form.presetId === 'custom' ? {} : { preset: form.presetId }),
      })
      if (result.ok) {
        setModels(result.models ?? [])
        setTestState({
          phase: 'done',
          ok: true,
          latencyMs: result.latencyMs,
          ...(result.models === undefined ? {} : { models: result.models }),
        })
      } else {
        setTestState({
          phase: 'done',
          ok: false,
          latencyMs: result.latencyMs,
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
        errorText: t('testRefused', { message: error instanceof Error ? error.message : String(error) }),
      })
    }
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
      ...(preset?.apiKeyHeader === undefined ? {} : { apiKeyHeader: preset.apiKeyHeader }),
    })
    // The form is done with what it held: the key least of all — the stored
    // one (if any) is only ever described by the list's next read.
    setForm(freshForm())
    setModels([])
    setTestState({ phase: 'idle' })
    setSavedNote(true)
  }

  const testLine = (): ReactElement | null => {
    if (testState.phase === 'idle') return null
    if (testState.phase === 'testing') return <p className="iris-field__note">{t('testing')}</p>
    if (testState.ok) {
      const count = testState.models?.length ?? 0
      return (
        <p className="iris-field__note">
          {t(count === 1 ? 'testOkOne' : 'testOk', { latency: testState.latencyMs, count })}
        </p>
      )
    }
    return <p className="iris-field__note iris-conn__test-error">{testState.errorText ?? t('testErrHttp')}</p>
  }

  return (
    <Section title={t('sectionConnection')}>
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
          onChange={event => { patchForm({ baseURL: event.target.value }) }}
        />
      </div>

      {/*
        The key field. Password-typed, so a shoulder reads nothing; a saved key
        is announced only by its mask, because the interface was never given
        one to show. A local serve (Ollama, llama.cpp, LM Studio) says so
        instead of asking for a credential it would never use.
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
            placeholder={t('apiKeyPlaceholder')}
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
              <button type="button" className="iris-act" onClick={() => { patchForm({ clearKey: true }) }}>
                {t('clearKey')}
              </button>
            </p>
          ) : null}
        </div>
      )}

      <div className="iris-field">
        <span className="iris-field__label">{t('modelLabel')}</span>
        <span />
        <input
          className="iris-text iris-field__control"
          type="text"
          value={form.model}
          list="iris-connection-models"
          aria-label={t('modelLabel')}
          spellCheck={false}
          onChange={event => { patchForm({ model: event.target.value }) }}
        />
        <datalist id="iris-connection-models" aria-label={t('modelsListLabel')}>
          {models.map(model => <option key={model} value={model} />)}
        </datalist>
        {models.length > 0 ? (
          <p className="iris-field__note">{t('modelsFromEndpoint', { count: models.length })}</p>
        ) : null}
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
        {form.editId !== undefined ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setForm(freshForm()); setModels([]); setTestState({ phase: 'idle' }); setSavedNote(false) }}
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
                setForm(formOf(profile))
                setModels([])
                setTestState({ phase: 'idle' })
                setSavedNote(false)
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
    </Section>
  )
}
