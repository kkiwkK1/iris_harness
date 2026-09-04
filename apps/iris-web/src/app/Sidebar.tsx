/**
 * Conversations and the character library.
 *
 * Two lists behind one pair of tabs, because those are the only two things a
 * reader navigates between: what they are reading and who they could read with.
 * Everything else an extension might want to put here goes through
 * `iris.sidebar.panels` rather than being added to the tab strip.
 *
 * @module iris-web/app/Sidebar
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { Slot } from '../slots/Slot.tsx'
import { useLanguage, t } from './i18n/use-language.ts'
import { since, toBase64 } from './format.ts'
import type { Language } from './i18n/strings.ts'
import type { ChatSearchHit } from '@iris/protocol'

/** Which list the sidebar is showing. */
export type SidebarTab = 'chats' | 'characters'

/**
 * Render the sidebar.
 * @param props.open - whether the sidebar is showing on a narrow screen.
 * @returns the sidebar.
 */
export function Sidebar({ open }: { open: boolean }): ReactElement {
  const [tab, setTab] = useState<SidebarTab>('chats')
  const chats = useIris(state => state.chats)
  const characters = useIris(state => state.characters)
  const chatId = useIris(state => state.chatId)
  const actions = useIrisActions()
  const picker = useRef<HTMLInputElement>(null)
  // Subscribed so a language switch re-renders the list's words, not just the
  // moment's rows; `lang` also drives the relative-time units in each row.
  const { lang } = useLanguage()

  // The content filter. `hits` is what the last completed search answered;
  // undefined means no search is in force and the plain list shows. A stale
  // reply is dropped by sequence number, never by trusting arrival order.
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ChatSearchHit[] | undefined>(undefined)
  const searchSeq = useRef(0)
  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed === '') {
      setHits(undefined)
      return
    }
    const seq = searchSeq.current + 1
    searchSeq.current = seq
    const timer = setTimeout(() => {
      void actions.searchChats(trimmed).then(found => {
        if (searchSeq.current === seq) setHits(found)
      })
    }, 250)
    return () => { clearTimeout(timer) }
  }, [query, actions])

  return (
    <nav className={`iris-sidebar${open ? ' iris-sidebar--open' : ''}`} aria-label={t('sidebarAria')}>
      <div className="iris-brand">
        <span className="iris-brand__mark" aria-hidden="true" />
        <span className="iris-brand__name">Iris</span>
      </div>

      <div className="iris-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className="iris-tab"
          aria-selected={tab === 'chats'}
          onClick={() => setTab('chats')}
        >
          {t('tabReading')}
        </button>
        <button
          type="button"
          role="tab"
          className="iris-tab"
          aria-selected={tab === 'characters'}
          onClick={() => setTab('characters')}
        >
          {t('tabCharacters')}
        </button>
      </div>

      <div className="iris-list" role="tabpanel">
        {tab === 'chats' ? (
          <>
            <input
              type="search"
              className="iris-search"
              aria-label={t('chatSearchAria')}
              placeholder={t('chatSearchPlaceholder')}
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
            {hits === undefined ? (
              chats.length === 0 ? (
                <p className="iris-list__empty">{t('chatsEmpty')}</p>
              ) : (
                chats.map(chat => (
                  <ChatRow
                    key={chat.chatId}
                    title={chat.title}
                    meta={`${since(chat.updatedAt, Date.now(), lang)} · ${t('messageCount', { count: chat.messageCount })}`}
                    current={chat.chatId === chatId}
                    onOpen={() => void actions.openChat(chat.chatId)}
                    onDelete={() => void actions.deleteChat(chat.chatId)}
                    deleteLabel={t('deleteConversation')}
                  />
                ))
              )
            ) : hits.length === 0 ? (
              // The no-results row names the query: an empty state that does not
              // say what found nothing is indistinguishable from a broken box.
              <p className="iris-list__empty">{t('chatSearchEmpty', { query: query.trim() })}</p>
            ) : (
              hits.map(hit => (
                <SearchRow
                  key={hit.chatId}
                  hit={hit}
                  current={hit.chatId === chatId}
                  lang={lang}
                  onOpen={() => void actions.openChat(hit.chatId)}
                />
              ))
            )}
          </>
        ) : characters.length === 0 ? (
          <p className="iris-list__empty">
            {t('libraryEmpty')}
          </p>
        ) : (
          characters.map(character => (
            <ChatRow
              key={character.characterId}
              title={character.name}
              meta={character.creator === undefined ? t('noCreatorListed') : t('byCreator', { creator: character.creator })}
              tags={character.tags}
              current={false}
              onOpen={() => void actions.createChat(character.characterId)}
              onDelete={() => void actions.deleteCharacter(character.characterId)}
              deleteLabel={t('removeFromLibrary')}
            />
          ))
        )}

        <Slot name="iris.sidebar.panels" owner={{ chats, characters }} />
      </div>

      <div className="iris-sidebar__foot">
        <input
          ref={picker}
          type="file"
          accept=".png,.jpg,.jpeg,.json,.charx"
          multiple
          hidden
          onChange={async event => {
            const files = [...(event.target.files ?? [])]
            event.target.value = ''
            for (const file of files) await actions.importCard(file.name, await toBase64(file))
          }}
        />
        <Button variant="outline" size="sm" onClick={() => picker.current?.click()}>
          {t('importCard')}
        </Button>
      </div>
    </nav>
  )
}

/**
 * One list row, with an overflow menu for the one destructive action it offers.
 */
function ChatRow({
  title,
  meta,
  tags,
  current,
  onOpen,
  onDelete,
  deleteLabel,
}: {
  title: string
  meta: string
  tags?: string[]
  current: boolean
  onOpen: () => void
  onDelete: () => void
  deleteLabel: string
}): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div className="iris-row-group">
      <button type="button" className="iris-row" aria-current={current} onClick={onOpen}>
        <span className="iris-row__title">{title}</span>
        <span className="iris-row__meta iris-meta">{meta}</span>
        {tags !== undefined && tags.length > 0 ? (
          <span className="iris-row__tags">
            {tags.slice(0, 4).map(tag => (
              <span className="iris-tag" key={tag}>
                {tag}
              </span>
            ))}
          </span>
        ) : null}
      </button>
      <Menu
        open={menuOpen}
        portal
        align="end"
        anchor={
          <button
            type="button"
            className="iris-act"
            aria-label={t('moreActionsFor', { title })}
            onClick={() => setMenuOpen(!menuOpen)}
          >
            ⋯
          </button>
        }
        items={[{ id: 'delete', label: deleteLabel, danger: true }]}
        onSelect={id => {
          setMenuOpen(false)
          if (id === 'delete') onDelete()
        }}
        onClose={() => setMenuOpen(false)}
      />
    </div>
  )
}

/**
 * One content hit: the conversation, and the floor that matched.
 *
 * The snippet is why the row is here; the floor label is where to go. Opening
 * the chat is the whole action — jumping the reading window to the floor is
 * the reading view's business and does not exist yet, so the row says where
 * the hit is rather than pretending it scrolled for you.
 */
function SearchRow({
  hit,
  current,
  lang,
  onOpen,
}: {
  hit: ChatSearchHit
  current: boolean
  lang: Language
  onOpen: () => void
}): ReactElement {
  const first = hit.matches[0]
  return (
    <button type="button" className="iris-row iris-row--hit" aria-current={current} onClick={onOpen}>
      <span className="iris-row__title">{hit.title}</span>
      {first !== undefined ? (
        <span className="iris-row__snippet">{first.snippet}</span>
      ) : null}
      <span className="iris-row__meta iris-meta">
        {first === undefined
          ? since(hit.updatedAt, Date.now(), lang)
          : `${t('chatSearchFloor', { floor: first.messageId })}`
            + (hit.matches.length > 1 ? ` · ${t('chatSearchMore', { count: hit.matches.length - 1 })}` : '')}
      </span>
    </button>
  )
}
