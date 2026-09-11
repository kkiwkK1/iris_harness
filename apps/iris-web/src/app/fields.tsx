/**
 * The settings panel's controls.
 *
 * A slider plus a live numeric readout, rather than a number input: sampling
 * parameters are felt, not typed, and a reader adjusting temperature mid-scene
 * wants to know they moved it, not to enter 0.85. The value stays visible in the
 * mono face so a setting can still be reported precisely.
 *
 * @module iris-web/app/fields
 */

import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'

import { isOpen, loadCardState, saveCardState, type CardId } from './cards.ts'
import { useLanguage, t } from './i18n/use-language.ts'

/** Detail pages expose contents without altering saved card preferences. */
export const SettingsPageSections = createContext(false)

/** Bounds and granularity of one slider. */
export interface Bounds {
  min: number
  max: number
  step: number
}

/**
 * Render a labelled slider over an optional numeric setting.
 *
 * "Unset" is a real state, distinct from any value in range: the host then uses
 * its own default, which is usually what a reader wants for a parameter they
 * have no opinion about. Clearing writes `null`, which the settings merge reads
 * as "remove this key" — an omitted key cannot say that, because omission is
 * how a partial patch works.
 * @param props.label - what the reader controls, in their words.
 * @param props.value - the value in force, or undefined when unset.
 * @param props.bounds - slider range.
 * @param props.fallback - the position the slider takes while unset.
 * @param props.decimals - digits in the readout.
 * @param props.note - one line of guidance, shown under the control.
 * @param props.onCommit - called with the new value, or null to unset.
 * @returns the field.
 */
export function NumberField({
  label,
  value,
  bounds,
  fallback,
  decimals = 2,
  note,
  onCommit,
}: {
  label: string
  value: number | undefined
  bounds: Bounds
  fallback: number
  decimals?: number
  note?: string
  onCommit: (value: number | null) => void
}): ReactElement {
  // Local while dragging, so the slider tracks the thumb without waiting for a
  // host round trip; re-synced whenever the host's value actually changes.
  const [live, setLive] = useState(value ?? fallback)
  useEffect(() => {
    setLive(value ?? fallback)
  }, [value, fallback])
  // Subscribed so a language switch re-renders the field's words.
  useLanguage()

  return (
    <div className="iris-field">
      <span className="iris-field__label">{label}</span>
      <span className="iris-field__value">
        {value === undefined ? t('hostDefault') : live.toFixed(decimals)}
      </span>
      <input
        className="iris-range iris-field__control"
        type="range"
        min={bounds.min}
        max={bounds.max}
        step={bounds.step}
        value={live}
        aria-label={label}
        onChange={event => {
          const next = Number(event.target.value)
          setLive(next)
          onCommit(next)
        }}
      />
      <span className="iris-field__note">
        {note}
        {value === undefined ? null : (
          <>
            {note === undefined ? null : ' '}
            <button type="button" className="iris-act iris-act--inline" onClick={() => onCommit(null)}>
              {t('useHostDefault')}
            </button>
          </>
        )}
      </span>
    </div>
  )
}

/**
 * Render a labelled text setting.
 * @param props.label - what the reader controls.
 * @param props.value - the current text.
 * @param props.placeholder - shown when empty.
 * @param props.onCommit - called on change.
 * @returns the field.
 */
export function TextField({
  label,
  value,
  placeholder,
  onCommit,
}: {
  label: string
  value: string
  placeholder?: string
  onCommit: (value: string) => void
}): ReactElement {
  return (
    <div className="iris-field">
      <span className="iris-field__label">{label}</span>
      <span />
      <input
        className="iris-text iris-field__control"
        type="text"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onChange={event => onCommit(event.target.value)}
      />
    </div>
  )
}

/**
 * Render a small set of mutually exclusive choices.
 * @param props.label - what the reader controls.
 * @param props.value - the chosen id.
 * @param props.options - the available ids and their labels.
 * @param props.onSelect - called with the chosen id.
 * @returns the field.
 */
export function ChoiceField<T extends string>({
  label,
  value,
  options,
  onSelect,
}: {
  label: string
  value: T
  options: readonly { id: T, label: string }[]
  onSelect: (id: T) => void
}): ReactElement {
  return (
    <div className="iris-field">
      <span className="iris-field__label">{label}</span>
      <span />
      <div className="iris-choice iris-field__control" role="group" aria-label={label}>
        {options.map(option => (
          <button
            key={option.id}
            type="button"
            className="iris-choice__option"
            aria-pressed={option.id === value}
            onClick={() => onSelect(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Render a titled group of fields.
 * @param props.title - the group's name.
 * @param props.children - its fields.
 * @returns the section.
 */
export function Section({ title, children }: { title: string, children: ReactNode }): ReactElement {
  return (
    <section className="iris-section">
      <h3 className="iris-label iris-section__head">{title}</h3>
      {children}
    </section>
  )
}

/**
 * Render a titled group of fields that folds into a card.
 *
 * The head carries the section's name and a one-line summary of what is in
 * force, so a closed card still answers "what is set here" — a table of
 * contents that hides its contents' values would only hide them twice. The
 * body stays mounted and merely hidden: collapsing a panel must not tear down
 * the form state it holds, and remounting would re-fetch what the store already
 * has. The open state is per-device ( {@link module:app/cards} ), remembered
 * across reloads; before the reader has expressed a preference, the connection
 * and reading cards stand open and everything else is folded.
 * @param props.id - which card this is, for the remembered state.
 * @param props.title - the card's name.
 * @param props.summary - the values in force, read while folded.
 * @param props.children - its fields.
 * @returns the card.
 */
export function CollapsibleSection({
  id,
  title,
  summary,
  children,
}: {
  id: CardId
  title: string
  summary?: ReactNode
  children: ReactNode
}): ReactElement {
  const [state, setState] = useState(loadCardState)
  // Subscribed so a language switch re-renders the card's words.
  useLanguage()

  const page = useContext(SettingsPageSections)
  const open = isOpen(state, id)
  const toggle = (): void => {
    // Read the store again, not the mount-time snapshot: two cards toggled in
    // one drawer visit must not overwrite each other, and the snapshot here
    // predates the other card's write.
    const next = { ...loadCardState(), [id]: !open }
    setState(next)
    saveCardState(next)
  }

  if (page) return (
    <section className="iris-section iris-card iris-settings-section">
      <div className="iris-card__head"><h3 className="iris-label iris-card__title">{title}</h3>{summary === undefined ? null : <span className="iris-card__summary">{summary}</span>}</div>
      <div id={"iris-card-" + id} className="iris-card__body">{children}</div>
    </section>
  )

  return (
    <section className="iris-section iris-card">
      <button
        type="button"
        className="iris-card__head"
        aria-expanded={open}
        aria-controls={`iris-card-${id}`}
        onClick={toggle}
      >
        <span className={`iris-card__chevron${open ? ' iris-card__chevron--open' : ''}`} aria-hidden="true">
          ▸
        </span>
        <span className="iris-label iris-card__title">{title}</span>
        {summary === undefined ? null : <span className="iris-card__summary">{summary}</span>}
      </button>
      <div id={`iris-card-${id}`} className="iris-card__body" hidden={!open}>
        {children}
      </div>
    </section>
  )
}

/**
 * Render a labelled boolean setting as a pressed/unpressed toggle.
 *
 * Two states, said in words: a switch that renders "off" as a grey track reads
 * as broken, not as off.
 * @param props.label - what the reader controls.
 * @param props.note - one line of guidance, shown under the control.
 * @param props.value - whether the setting is on.
 * @param props.onToggle - called with the next value.
 * @returns the field.
 */
export function ToggleField({
  label,
  note,
  value,
  onToggle,
}: {
  label: string
  note?: string
  value: boolean
  onToggle: (next: boolean) => void
}): ReactElement {
  // Subscribed so a language switch re-renders the field's words.
  useLanguage()
  return (
    <div className="iris-field">
      <span className="iris-field__label">{label}</span>
      <span />
      <button
        type="button"
        className="iris-choice__option iris-field__control"
        style={{ justifySelf: 'start' }}
        aria-pressed={value}
        onClick={() => onToggle(!value)}
      >
        {value ? t('switchOn') : t('switchOff')}
      </button>
      <span className="iris-field__note">{note}</span>
    </div>
  )
}
