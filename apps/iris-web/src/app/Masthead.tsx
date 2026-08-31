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

/**
 * Render the masthead.
 * @param props.onOpenSettings - opens the settings drawer.
 * @param props.onToggleNav - shows the sidebar on a narrow screen.
 * @returns the masthead.
 */
export function Masthead({
  onOpenSettings,
  onToggleNav,
}: {
  onOpenSettings: () => void
  onToggleNav: () => void
}): ReactElement {
  const view = useIris(state => state.view)
  const settings = useIris(state => state.settings)
  const generating = useIris(state => state.stream !== undefined)
  const characters = useIris(state => state.characters)
  const transport = useIris(state => state.transport)

  const character = characters.find(row => row.characterId === view?.characterId)
  // Turns rather than messages: a turn is the unit the reader thinks in, and the
  // one swipe and regenerate address.
  const turns = new Set((view?.messages ?? []).map(message => message.turn)).size

  return (
    <header className="iris-masthead">
      <div className="iris-masthead__row">
        <button
          type="button"
          className="iris-act iris-nav-toggle"
          aria-label="Show conversations"
          onClick={onToggleNav}
        >
          ☰
        </button>
        <ChatTitle />
        <span className="iris-masthead__spacer" />
        <Button variant="ghost" size="sm" onClick={onOpenSettings}>
          Settings
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
          Seeded data — this page is not talking to a host. Add{' '}
          <code>?transport=rpc</code> to use one.
        </p>
      ) : null}
      {view === undefined ? null : (
        <p className="iris-masthead__meta iris-meta">
          {[
            character?.name,
            turns === 0 ? 'not started' : `${turns} ${turns === 1 ? 'turn' : 'turns'}`,
            settings?.model,
            generating ? 'writing…' : undefined,
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

  if (view === undefined) return null

  if (editing) {
    return (
      <input
        className="iris-text iris-title-input"
        autoFocus
        value={draft}
        aria-label="Conversation title"
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
      title="Rename this conversation"
      onClick={() => {
        setDraft(view.title)
        setEditing(true)
      }}
    >
      {view.title}
    </button>
  )
}
