/**
 * The Iris shell.
 *
 * Holds the three things that are genuinely global — the theme, the drop target
 * for character cards, and which of the two overlays is open — and nothing else.
 * Chat state lives in the store; reading preferences live on the device. Keeping
 * those three concerns apart is what makes the shell small enough to read.
 *
 * @module iris-web/app/App
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { useIris, useIrisActions } from '../client/provider.tsx'
import {
  applyReading,
  applyTheme,
  loadReading,
  loadTheme,
  watchSystemTheme,
  type ReadingPrefs,
  type ThemeChoice,
} from '../theme/theme.ts'
import { ChatPane } from './ChatPane.tsx'
import { SettingsDrawer } from './SettingsDrawer.tsx'
import { Sidebar } from './Sidebar.tsx'
import { toBase64 } from './format.ts'

import '../theme/tokens.css'
import '../theme/bridge.css'
import './shell.css'
import './reading.css'
import './panels.css'

/**
 * Render the application.
 * @returns the shell.
 */
export function App(): ReactElement {
  const actions = useIrisActions()
  const notice = useIris(state => state.notice)
  const connected = useIris(state => state.connected)
  const generating = useIris(state => state.stream !== undefined)

  const [theme, setThemeState] = useState<ThemeChoice>(loadTheme)
  const [reading, setReadingState] = useState<ReadingPrefs>(loadReading)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const [dropping, setDropping] = useState(false)
  const dragDepth = useRef(0)

  // Apply on mount as well as on change: the stored preference has to reach the
  // document before the first paint of prose, not after it.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])
  useEffect(() => {
    applyReading(reading)
  }, [reading])

  const themeRef = useRef(theme)
  themeRef.current = theme
  useEffect(() => watchSystemTheme(() => themeRef.current), [])

  useEffect(() => {
    void actions.boot()
  }, [actions])

  // Notices clear themselves. An error a reader has already read is noise, and
  // one that mattered will happen again the moment they retry.
  useEffect(() => {
    if (notice === undefined) return
    const timer = setTimeout(() => actions.dismissNotice(), notice.kind === 'error' ? 8000 : 3200)
    return () => clearTimeout(timer)
  }, [notice, actions])

  const importFiles = useCallback(
    async (files: readonly File[]): Promise<void> => {
      for (const file of files) await actions.importCard(file.name, await toBase64(file))
    },
    [actions],
  )

  return (
    <div
      className="iris-shell"
      // Card import is a whole-window drop rather than a small target: a reader
      // dragging a card off their desktop should not have to aim.
      onDragEnter={event => {
        if (!event.dataTransfer.types.includes('Files')) return
        dragDepth.current += 1
        setDropping(true)
      }}
      onDragOver={event => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDropping(false)
      }}
      onDrop={event => {
        event.preventDefault()
        dragDepth.current = 0
        setDropping(false)
        void importFiles([...event.dataTransfer.files])
      }}
    >
      <Sidebar open={navOpen} />

      <main className="iris-main">
        {connected ? null : (
          <div className="iris-notice iris-notice--error" role="status">
            Not connected to the Iris host. Nothing you write will be sent.
          </div>
        )}
        {notice === undefined ? null : (
          <div className={`iris-notice iris-notice--${notice.kind}`} role="status" key={notice.seq}>
            {notice.text}
            <button
              type="button"
              className="iris-notice__dismiss"
              aria-label="Dismiss"
              onClick={() => actions.dismissNotice()}
            >
              ✕
            </button>
          </div>
        )}

        <header className="iris-topbar">
          <button
            type="button"
            className="iris-act iris-nav-toggle"
            aria-label="Show conversations"
            onClick={() => setNavOpen(!navOpen)}
          >
            ☰
          </button>
          <ChatTitle />
          <span className="iris-topbar__spacer" />
          {generating ? <span className="iris-meta">writing…</span> : null}
          <Button variant="ghost" size="sm" onClick={() => setSettingsOpen(true)}>
            Settings
          </Button>
        </header>

        <ChatPane />
      </main>

      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        control={{
          theme,
          reading,
          setTheme: setThemeState,
          setReading: setReadingState,
        }}
      />

      {dropping ? (
        <div className="iris-drop" role="status">
          Drop a character card — PNG, JSON or .charx — to add it to the library.
        </div>
      ) : null}

      {navOpen ? (
        <div className="iris-scrim" role="presentation" onClick={() => setNavOpen(false)} />
      ) : null}

    </div>
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
      className="iris-topbar__title iris-title-button"
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
