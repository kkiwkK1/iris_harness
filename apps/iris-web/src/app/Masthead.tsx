/**
 * The conversation's head, printed on the paper.
 *
 * It used to be a strip of chrome above the sheet, which had two costs measured
 * in the browser: the title sat 1270px from the Settings button it shared a band
 * with, and the top of the paper was 293px of nothing — 23% of the window — once
 * short conversations were anchored to the composer.
 *
 * Putting the head inside the sheet fixes both. The emptiness that remains sits
 * *below* a masthead, which is what the top margin of a page looks like, rather
 * than above the first line, which is what an unfinished render looks like. And
 * the meta line is real information that had nowhere else to live: which model is
 * answering, and how far in the scene is.
 *
 * @module iris-web/app/Masthead
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { isFailure } from '../sandbox/script-run-state.ts'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * Render the masthead.
 * @param props.onOpenSettings - opens the settings drawer.
 * @param props.navOpen - whether the sidebar is showing, so the ☰ can say so.
 * @param props.onToggleNav - shows or hides the sidebar on a narrow screen.
 * @returns the masthead.
 */
export function Masthead({
  onOpenSettings,
  navOpen,
  onToggleNav,
}: {
  onOpenSettings: () => void
  navOpen: boolean
  onToggleNav: () => void
}): ReactElement {
  const view = useIris(state => state.view)
  const settings = useIris(state => state.settings)
  const generating = useIris(state => state.stream !== undefined)
  const characters = useIris(state => state.characters)
  const transport = useIris(state => state.transport)
  const origin = useIris(state => state.dataOrigin)
  const runStates = useIris(state => state.runStates)
  // Subscribed so a language switch re-renders every word the head shows.
  useLanguage()

  const character = characters.find(row => row.characterId === view?.characterId)
  // Turns rather than messages: a turn is the unit the reader thinks in, and the
  // one swipe and regenerate address.
  const turns = new Set((view?.messages ?? []).map(message => message.turn)).size

  /*
   * How many of the card's scripts are actually alive, for the meta line.
   *
   * Counted from the **run states** and not from `state.scripts`: the script
   * list says what the card ships and what is switched on, which is a different
   * question — a script can be enabled and have thrown on line one. So the count
   * is the live phases: everything that is not a failure
   * (`refused`/`threw`/`bootstrap-failed`/`silent`) and not `killed`, which is
   * what leaving a chat looks like from inside. `ran` counts, because `ran`
   * means the body finished evaluating and not that the card stopped working —
   * a status-bar card spends its whole life in listeners installed by then.
   */
  const running = runStates.filter(
    state => !isFailure(state.phase) && state.phase !== 'killed',
  ).length

  return (
    <header className="iris-masthead">
      <div className="iris-masthead__row">
        {/*
          The narrow window's way back to the sidebar.
          It answers the same switch the sidebar's own fold control does
          (`App.tsx`: one `collapsed`, not a drawer flag beside it), so it is a
          *toggle* and now says which state it is in — `aria-expanded` on a
          control that only ever showed the panel would have been a constant.
          It exists only below 880px, where collapsing means off-canvas rather
          than the rail (`panels.css`).
        */}
        <button
          type="button"
          className="iris-act iris-nav-toggle"
          aria-label={t('showConversations')}
          aria-expanded={navOpen}
          aria-controls="iris-sidebar-body"
          onClick={onToggleNav}
        >
          ☰
        </button>
        <ChatTitle />
        <span className="iris-masthead__spacer" />
        {/*
         * `data-control` for the same reason the sidebar tabs carry `data-tab`:
         * this button's only identity was its translated label, so every
         * acceptance script reaching for "Settings" stopped matching the day the
         * shell learned to speak the reader's language.
         *
         * No `aria-label` here on purpose. The button has visible text, which is
         * already its accessible name; an `aria-label` would *override* that for
         * a screen reader, and if it were a translated string it would vary with
         * the language exactly like the text does — so it buys the instrument
         * nothing and costs the reader the name they can see.
         */}
        {/* Outlined rather than ghost: the artboards give it a hairline box
            (`Main.dc.html`), because a bare word at the end of the masthead's
            own line read as part of the meta rather than as the way out. */}
        <Button variant="outline" size="sm" data-control="settings" onClick={onOpenSettings}>
          {t('settings')}
        </Button>
      </div>
      {transport === 'fake' ? (
        /*
          Said permanently, and only in this direction.

          An observer once checked that the host served this app and that its RPC
          answered — both true — and concluded the page was showing real data,
          while seeded character names sat on screen for two days. "This is
          invented data" is cheap to say and expensive to leave unsaid; the
          opposite is the expectation and needs no decoration.
        */
        <p className="iris-masthead__stub">
          {t('seededNotice')} <code>?transport=rpc</code>
          {/*
            And **where** the data came from, which is the half of this sentence
            that was missing. `dataOrigin` has been in the store since the field
            was added — with a doc saying the interface has to be able to say it
            — and nothing read it: an audit of state fields against their readers
            turned it up as the one written-but-never-read field.

            A stored value nobody renders is the "looks done" shape this project
            has ruled against twice; the half that was already shown
            (`transport`) is what makes the omission easy to miss, because the
            sentence reads complete without it.
          */}
          {' '}{t('seededNoticeSource')} <code>{origin}</code>.
        </p>
      ) : null}
      {view === undefined ? null : (
        /*
         * 第 N 回 · 模型 · N 个脚本在运行 — the artboards' meta line, plus the
         * character's name, which they leave out and which the title above does
         * not carry: a conversation can be renamed to anything.
         *
         * The running-script count is the part that was missing. `state.scripts`
         * has been on the page since card scripts existed and the reader could
         * only learn the number by opening the settings drawer — while it is the
         * single most useful fact about a card-heavy conversation, and the
         * reason the page might be slow. Rendered only when it is non-zero: a
         * 「0 个脚本在运行」 on every chat without a card would be a permanent
         * clause saying nothing.
         */
        <p className="iris-masthead__meta iris-meta">
          {[
            character?.name,
            turns === 0 ? t('notStarted') : turns === 1 ? t('oneTurn') : t('turns', { n: turns }),
            settings?.model,
            running === 0 ? undefined : t('scriptsRunning', { n: running }),
            generating ? t('writingNow') : undefined,
          ]
            .filter(part => part !== undefined && part !== '')
            .join('  ·  ')}
        </p>
      )}
    </header>
  )
}

/**
 * The conversation's title, renamable in place.
 *
 * In place rather than in a dialog: a title is one field, and a modal for one
 * field is a modal too many.
 * @returns the title, as text or as an input.
 */
function ChatTitle(): ReactElement | null {
  const view = useIris(state => state.view)
  const actions = useIrisActions()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // Subscribed: the title input's accessible name is copy too.
  useLanguage()

  if (view === undefined) return null

  if (editing) {
    return (
      <input
        className="iris-text iris-title-input"
        autoFocus
        value={draft}
        aria-label={t('conversationTitle')}
        onChange={event => setDraft(event.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={event => {
          if (event.key === 'Escape') setEditing(false)
          if (event.key === 'Enter') {
            setEditing(false)
            const title = draft.trim()
            if (title !== '' && title !== view.title) void actions.renameChat(view.chatId, title)
          }
        }}
      />
    )
  }

  return (
    <button
      type="button"
      className="iris-masthead__title iris-title-button"
      title={t('renameConversation')}
      onClick={() => {
        setDraft(view.title)
        setEditing(true)
      }}
    >
      {view.title}
    </button>
  )
}
