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
import { Masthead } from './Masthead.tsx'
import { Sidebar } from './Sidebar.tsx'
import { CardScriptFrames } from './useCardScripts.tsx'
import { ConsentAsk } from './ConsentAsk.tsx'
import { CleanupOffer } from './CleanupOffer.tsx'
import { StatePanel } from './StatePanel.tsx'
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
        {/*
          The first-run question, where the reader is.

          It used to live only in the settings drawer, which is closed by
          default — so a card's scripts sat unasked and unrun, and the interface
          said nothing about a decision waiting. `AUTORUN.md` §1 requires the
          question to be put once, and a question nobody can see has not been put.

          Not a modal: §3.4 keeps prompts off the conversation, and this must not
          block reading. It sits in the notice region, inline, and unlike a notice
          it does not expire — a question that times out has answered itself.
        */}
        <ConsentAsk />

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

        <div className="iris-stage">
          <div className="iris-sheet">
            <Masthead
              onOpenSettings={() => setSettingsOpen(true)}
              onToggleNav={() => setNavOpen(!navOpen)}
            />
            <ChatPane />
          </div>
          <StatePanel />
        </div>
      </main>

      {/*
        The foreground chat's card scripts. Renders nothing — card UI inside a
        message is a separate piece — but it lives here rather than inside
        `ChatPane` so a re-render of the conversation cannot restart a card.
      */}
      <CardScriptFrames />

      {/*
        The host's cleaning offer, at the top level rather than inside the
        drawer or the sheet: it is a modal question about deleting the open
        chat's data, and it must not be reachable only by opening a panel first.
        Renders nothing until the host actually asks.
      */}
      <CleanupOffer />

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
