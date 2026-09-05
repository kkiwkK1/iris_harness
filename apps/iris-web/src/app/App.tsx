/**
 * The Iris shell.
 *
 * Holds the things that are genuinely global — the drop target for character
 * cards, which of the two overlays is open, the reading preferences, and the
 * user.css slot's lifetime — and nothing else. The theme lives in its own
 * module store (`theme/theme.ts`), which applies the document the moment the
 * choice changes; chat state lives in the store. Keeping those concerns apart
 * is what makes the shell small enough to read.
 *
 * @module iris-web/app/App
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'

import { useIris, useIrisActions } from '../client/provider.tsx'
import {
  applyReading,
  loadReading,
  watchSystemTheme,
  getThemeChoice,
  type ReadingPrefs,
} from '../theme/theme.ts'
import { installUserCssSlot } from '../slots/user-css.ts'
import { ChatPane } from './ChatPane.tsx'
import { SettingsDrawer } from './SettingsDrawer.tsx'
import { Masthead } from './Masthead.tsx'
import { Sidebar } from './Sidebar.tsx'
import { CardScriptFrames } from './useCardScripts.tsx'
import { ConsentAsk } from './ConsentAsk.tsx'
import { CleanupOffer } from './CleanupOffer.tsx'
import { StatePanel } from './StatePanel.tsx'
import { toBase64 } from './format.ts'
import { useLanguage, t } from './i18n/use-language.ts'

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
  // Subscribed so a language switch re-renders the shell's own words. The
  // language itself lives in the i18n module, like the theme lives in its own:
  // per-device, not store state.
  useLanguage()

  const [reading, setReadingState] = useState<ReadingPrefs>(loadReading)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [navOpen, setNavOpen] = useState(false)
  const [dropping, setDropping] = useState(false)
  const dragDepth = useRef(0)

  // The theme needs no shell state: it lives in its own module store, applies
  // the document the moment it is set, and the pre-paint script in
  // `index.html` already put the stored choice on the attribute before this
  // bundle ran. Reading still rides through here because its setter owns the
  // document writes.
  useEffect(() => {
    applyReading(reading)
  }, [reading])

  // Keep a `system` choice in step with the OS, and mount the user.css slot
  // for as long as the shell lives — its disposer takes the style element
  // back, leaving nothing behind.
  useEffect(() => watchSystemTheme(getThemeChoice), [])
  useEffect(() => installUserCssSlot(), [])

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
      className={`iris-shell${settingsOpen ? ' iris-shell--drawer-open' : ''}`}
      // The modifier names the drawer's occupancy of the window (shell.css):
      // while it is open the stage cedes the drawer's width and the sheet
      // re-centres in the region actually visible, instead of sitting under a
      // stationary grid with a dead desk beside the sidebar.
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
            {t('notConnected')}
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
              aria-label={t('dismiss')}
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
            {/*
              The reading column's card stage.

              This wrapper is the rectangle a card's overlay interface is
              confined to: `CardScriptFrames`'s surface is `position:absolute;
              inset:0` inside it, so the browser derives the box from the
              layout — masthead and sidebar stay outside it and stay reachable,
              and there is no measured copy of the geometry to fall out of sync
              with the real one. ChatPane lives in the same wrapper so the two
              fill the sheet exactly as they did when they were its direct
              children; the wrapper is a plain flex column with `position` set,
              nothing more.

              The foreground chat's card scripts still render outside `ChatPane`
              itself, as they always have: a re-render of the conversation must
              not be able to restart a card.
            */}
            <div className="iris-card-stage">
              <ChatPane />
              <CardScriptFrames />
            </div>
          </div>
          <StatePanel />
        </div>
      </main>
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
          reading,
          setReading: setReadingState,
        }}
      />

      {dropping ? (
        <div className="iris-drop" role="status">
          {t('dropCard')}
        </div>
      ) : null}

      {navOpen ? (
        <div className="iris-scrim" role="presentation" onClick={() => setNavOpen(false)} />
      ) : null}

    </div>
  )
}
