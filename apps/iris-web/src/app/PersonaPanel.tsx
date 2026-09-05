/**
 * The persona panel: who the user is, in the model's eyes.
 *
 * The upstream shape, reduced to what a prompt actually reads: a list of
 * personas, the active one, a description, and the position that description
 * takes — the `personaDescription` prompt slot, a depth injection, or out of
 * the prompt entirely (where it still reaches the world-info scan). Upstream's
 * avatar images, persona-to-character locks and per-persona lorebook bindings
 * are not model-visible state and are deliberately not here.
 *
 * The panel sits outside the drawer's per-chat settings branch, because a
 * persona is profile-wide: it shapes every chat's prompt the way the world
 * books do, not the way a temperature slider does.
 *
 * @module iris-web/app/PersonaPanel
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'

import type { PersonaView } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { ChoiceField, Section } from './fields.tsx'
import { useLanguage, t } from './i18n/use-language.ts'

/** The position words, as the wire spells them. */
type Position = PersonaView['position']

/** The roles a depth injection can take, as the wire spells them. */
type Role = NonNullable<PersonaView['role']>

/** What the editor holds while being worked on, before a save commits it. */
interface Draft {
  /** Undefined while a new persona is being written; the id once one is. */
  id: string | undefined
  name: string
  description: string
  position: Position
  depth: number
  role: Role
}

/** The depth range one slider offers. */
const DEPTH_BOUNDS = { min: 0, max: 20, step: 1 } as const

/**
 * A blank draft — a new persona with upstream's defaults applied
 * (`IN_PROMPT`, `DEFAULT_DEPTH` 2, `DEFAULT_ROLE` system).
 */
function blankDraft(): Draft {
  return { id: undefined, name: '', description: '', position: 'inprompt', depth: 2, role: 'system' }
}

/** A draft seeded from a stored persona. */
function draftOf(persona: PersonaView): Draft {
  return {
    id: persona.id,
    name: persona.name,
    description: persona.description,
    position: persona.position,
    depth: persona.depth ?? 2,
    role: persona.role ?? 'system',
  }
}

/**
 * Render the persona panel.
 * @returns the panel.
 */
export function PersonaPanel(): ReactElement {
  const personas = useIris(state => state.personas)
  const actions = useIrisActions()
  useLanguage()

  // The persona being written, or undefined when the panel shows only the
  // list. Local state until save: a description is paragraphs, and committing
  // it on every keystroke would round-trip the whole text per keypress.
  const [draft, setDraft] = useState<Draft | undefined>(undefined)

  useEffect(() => {
    if (personas === undefined) void actions.loadPersonas()
  }, [personas, actions])

  if (personas === undefined) {
    return (
      <Section title={t('sectionPersona')}>
        <p className="iris-list__empty">{t('personasNotLoaded')}</p>
      </Section>
    )
  }

  const { personas: rows, activeId } = personas

  const save = (): void => {
    if (draft === undefined || draft.name.trim().length === 0) return
    void actions.savePersona({
      ...(draft.id === undefined ? {} : { id: draft.id }),
      name: draft.name,
      description: draft.description,
      position: draft.position,
      ...(draft.position === 'atdepth' ? { depth: draft.depth, role: draft.role } : {}),
      // Saving an already-active persona keeps it active; saving another one
      // does not activate it — activation is the list row's tap, which is
      // where upstream puts the decision too.
      ...(draft.id !== undefined && draft.id === activeId ? { active: true } : {}),
    })
    setDraft(undefined)
  }

  return (
    <Section title={t('sectionPersona')}>
      <div className="iris-field">
        <span className="iris-field__label">{t('personaActiveNote')}</span>
        <span />
        <div className="iris-choice iris-field__control" role="group" aria-label={t('sectionPersona')}>
          {rows.length === 0
            ? <span className="iris-list__empty">{t('personasEmpty')}</span>
            : rows.map(persona => (
              // One row per persona, two controls in it: the name activates,
              // the pencil opens the editor. Two decisions, two controls —
              // one button doing both would make "look at what this says"
              // mean "make this the one in play".
              <span key={persona.id} style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                <button
                  type="button"
                  className="iris-choice__option"
                  style={{ flex: '1' }}
                  aria-pressed={persona.id === activeId}
                  onClick={() => {
                    void actions.savePersona({
                      id: persona.id,
                      // The contract names a persona; the row carries it.
                      name: persona.name,
                      active: true,
                    })
                  }}
                >
                  {persona.name}
                </button>
                <button
                  type="button"
                  className="iris-act"
                  aria-label={t('personaEditing', { name: persona.name })}
                  onClick={() => setDraft(draftOf(persona))}
                >
                  ✎
                </button>
              </span>
            ))}
        </div>
      </div>

      <div className="iris-field">
        <span />
        <span />
        <div className="iris-field__control" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="button" className="iris-act" onClick={() => setDraft(blankDraft())}>
            {t('personaNew')}
          </button>
          {draft !== undefined
            ? (
                <>
                  <button type="button" className="iris-act" onClick={save}>
                    {t('personaSave')}
                  </button>
                  <button type="button" className="iris-act" onClick={() => setDraft(undefined)}>
                    {t('close')}
                  </button>
                </>
              )
            : null}
        </div>
      </div>

      {draft !== undefined
        ? (
            <>
              <div className="iris-field">
                <span className="iris-field__label">{t('personaName')}</span>
                <span />
                <input
                  className="iris-text iris-field__control"
                  type="text"
                  value={draft.name}
                  placeholder={t('personaNamePlaceholder')}
                  aria-label={t('personaName')}
                  onChange={event => setDraft({ ...draft, name: event.target.value })}
                />
              </div>

              <div className="iris-field">
                <span className="iris-field__label">{t('personaDescription')}</span>
                <span />
                {/*
                  A textarea rather than the shared one-line TextField, for the
                  same reason the draft is local: descriptions are paragraphs.
                */}
                <textarea
                  className="iris-text iris-field__control"
                  rows={5}
                  value={draft.description}
                  aria-label={t('personaDescription')}
                  onChange={event => setDraft({ ...draft, description: event.target.value })}
                />
                <span className="iris-field__note">{t('personaDescriptionNote')}</span>
              </div>

              <ChoiceField<Position>
                label={t('personaPosition')}
                value={draft.position}
                options={[
                  // Upstream's own position words, minus the two AN merges
                  // this host cannot honour (see the protocol's schema note).
                  { id: 'inprompt', label: t('positionInprompt') },
                  { id: 'atdepth', label: t('positionAtdepth') },
                  { id: 'none', label: t('positionNone') },
                ]}
                onSelect={id => setDraft({ ...draft, position: id })}
              />

              {draft.position === 'atdepth'
                ? (
                    <>
                      <div className="iris-field">
                        <span className="iris-field__label">{t('personaDepth')}</span>
                        <span className="iris-field__value">{String(draft.depth)}</span>
                        <input
                          className="iris-range iris-field__control"
                          type="range"
                          min={DEPTH_BOUNDS.min}
                          max={DEPTH_BOUNDS.max}
                          step={DEPTH_BOUNDS.step}
                          value={draft.depth}
                          aria-label={t('personaDepth')}
                          onChange={event => setDraft({ ...draft, depth: Number(event.target.value) })}
                        />
                      </div>
                      <ChoiceField<Role>
                        label={t('personaRole')}
                        value={draft.role}
                        options={[
                          // The roles are protocol words, shown raw like the
                          // reasoning-effort choices are.
                          { id: 'system', label: 'system' },
                          { id: 'user', label: 'user' },
                          { id: 'assistant', label: 'assistant' },
                        ]}
                        onSelect={id => setDraft({ ...draft, role: id })}
                      />
                    </>
                  )
                : null}

              {draft.id !== undefined
                ? (
                    <div className="iris-field">
                      <span />
                      <span />
                      <button
                        type="button"
                        className="iris-act iris-field__control"
                        style={{ justifySelf: 'start' }}
                        onClick={() => {
                          void actions.deletePersona(draft.id ?? '')
                          setDraft(undefined)
                        }}
                      >
                        {t('personaDelete')}
                      </button>
                    </div>
                  )
                : null}
            </>
          )
        : null}
    </Section>
  )
}
