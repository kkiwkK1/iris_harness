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
import { CharacterPage } from './CharacterPage.tsx'
import { SettingsDrawer } from './SettingsDrawer.tsx'
import { Masthead } from './Masthead.tsx'
import { Sidebar } from './Sidebar.tsx'
import type { SidebarTab } from './Sidebar.tsx'
import { CardScriptFrames } from './useCardScripts.tsx'
import { ConsentAsk } from './ConsentAsk.tsx'
import { CardPopup } from './CardPopup.tsx'
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
  /*
   * Which list the sidebar shows, and which character's page is open.
   *
   * Held here rather than in `Sidebar` because under 「梅花」 the tab governs the
   * **main area** as well: 阅读 shows the conversation, 角色库 shows a character's
   * page (`Library.dc.html`). `face` is the chosen character, kept across a tab
   * switch so going back to the library returns to the card the reader was
   * looking at.
   */
  const [tab, setTab] = useState<SidebarTab>('chats')
  const [face, setFace] = useState<string | undefined>(undefined)
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
      className="iris-shell"
      // No drawer-open modifier on the shell, still — but for a new reason. The
      // drawer used to be a pure overlay nothing reacted to; it is now a grid
      // track, and a track that appears is the whole reaction. Nothing has to be
      // told about it.
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
      <Sidebar
        open={navOpen}
        tab={tab}
        onTab={setTab}
        face={face}
        onFace={characterId => {
          setFace(characterId)
        }}
      />

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
          said nothing about a decision waiting. `docs/AUTORUN.md` §1 requires the
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
          {/*
            The library tab shows a character's page in the reading area's own
            track, so the two are siblings rather than one nested in the other.
          */}
          {tab === 'characters'
            ? (
              <CharacterPage
                characterId={face}
                /*
                  The page can open a conversation now — one row per chat under
                  its 对话 column — and opening one has to bring the reading
                  surface with it. Which surface is showing is this component's
                  own state (`tab`), unreachable from the page, so the page is
                  handed the one line it needs. 「开始新对话」 calls the same
                  thing: before this it created a chat and left the reader on the
                  card page, with the new conversation behind a tab they had to
                  find on their own.
                */
                onEnterReading={() => setTab('chats')}
              />
            )
            : null}
          {/*
            **Hidden, never unmounted.** `CardScriptFrames` lives inside this
            subtree, and unmounting it would tear down every running card script
            — a tab switch is navigation, not a reason to restart a card that has
            been listening for twenty floors. `hidden` takes the boxes out of
            layout and out of the accessibility tree while React keeps the tree,
            so the `<iframe>` elements are never detached and their documents
            keep running.

            One consequence, recorded rather than fixed: while it is hidden the
            reading scroller has no height, so the frame band ChatPane publishes
            would be zero — `frameBandPixels` already refuses to hand back zero,
            for exactly this class of transient reading.
          */}
          <div className="iris-sheet" hidden={tab === 'characters'}>
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
          {/*
            The variable margin belongs to the conversation, so it stands down
            while the library is showing — a column of one chat's variables
            beside another character's card page is two subjects in one window.
          */}
          {/*
            `drawerOpen` is passed rather than read from anywhere: above 1200px
            the drawer is a grid track, and on a window that cannot pay for
            sidebar + margin + drawer + a readable measure the margin yields its
            column (`state-panel.ts`, 让位). The shell holds the drawer's state,
            so the shell is the only thing that can say so — and saying it as a
            prop keeps the margin's own stored preference untouched.
          */}
          {tab === 'characters' ? null : <StatePanel drawerOpen={settingsOpen} />}
          {/*
            The settings drawer is the stage's third track now, not an overlay on
            the page: opening it narrows the reading area and the prose re-wraps
            (canvas.json: 占一列 392px 把阅读区挤窄,不再 overlay + 遮罩). It has to
            live inside the grid to be a track at all, which is why it moved out
            of the shell's top level — where it sat because it was `position:
            fixed` and needed no ancestor.
          */}
          <SettingsDrawer
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            control={{
              reading,
              setReading: setReadingState,
            }}
          />
        </div>
      </main>
      {/*
        The host's cleaning offer, at the top level rather than inside the
        drawer or the sheet: it is a modal question about deleting the open
        chat's data, and it must not be reachable only by opening a panel first.
        Renders nothing until the host actually asks.
      */}
      <CleanupOffer />

      {/*
        A card's own popup, at the same level and for a weaker version of the
        same reason: the card that raised it is *blocked* until it is answered,
        so it cannot be reachable only by opening something first. It sits below
        the cleaning offer in the z ladder — that one destroys data and this one
        is content asking a question. Renders nothing until a card asks.
      */}
      <CardPopup />

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
