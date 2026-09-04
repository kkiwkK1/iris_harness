/**
 * Conversations and the character library.
 *
 * Two lists behind one pair of tabs, because those are the only two things a
 * reader navigates between: what they are reading and who they could read with.
 * Everything else an extension might want to put here goes through
 * `iris.sidebar.panels` rather than being added to the tab strip.
 *
 * Branches render **under** the conversation they left, indented — the shape
 * the list already carries (`ChatSummary.parentChatId`) and the one a reader
 * expects: a branch is a continuation of something, not a sibling of it. A
 * branch whose parent is not in the list is a top-level row; a wrong-looking
 * guess at the parent would be worse than a flat list.
 *
 * @module iris-web/app/Sidebar
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ChatSummary } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { Slot } from '../slots/Slot.tsx'
import { useLanguage, t } from './i18n/use-language.ts'
import { since, toBase64 } from './format.ts'
import type { Language } from './i18n/strings.ts'
import type { ChatSearchHit } from '@iris/protocol'

/** Which list the sidebar is showing. */
export type SidebarTab = 'chats' | 'characters'

/** One non-destructive row action, alongside the delete every row carries. */
interface RowAction {
  id: string
  label: string
  danger?: boolean
}

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
  // Chats import under the character whose menu row opened the picker, so the
  // hidden input has to remember who it is picking for until the change fires.
  const chatPicker = useRef<HTMLInputElement>(null)
  const importFor = useRef<string>('')
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
  /** Chats grouped under the parent they were branched from, in list order. */
  const childrenOf = (parentChatId: string): ChatSummary[] =>
    chats.filter(row => row.parentChatId === parentChatId)
  const roots = chats.filter(row =>
    row.parentChatId === undefined || !chats.some(other => other.chatId === row.parentChatId))

  const renderChatRows = (rows: readonly ChatSummary[], depth: number): ReactElement[] =>
    rows.flatMap(row => [
      <ChatRow
        key={row.chatId}
        title={row.title}
        meta={`${since(row.updatedAt, Date.now(), lang)} · ${t('messageCount', { count: row.messageCount })}`}
        current={row.chatId === chatId}
        depth={depth}
        branched={depth > 0}
        onOpen={() => void actions.openChat(row.chatId)}
        menu={{
          items: [
            ...(row.parentChatId === undefined ? [] : [{ id: 'parent', label: t('openParentChat') }]),
            { id: 'export', label: t('exportChat') },
            { id: 'delete', label: t('deleteConversation'), danger: true },
          ],
          onSelect: id => {
            if (id === 'export') void actions.exportChat(row.chatId)
            else if (id === 'parent' && row.parentChatId !== undefined) {
              void actions.openChat(row.parentChatId)
            } else if (id === 'delete') void actions.deleteChat(row.chatId)
          },
        }}
      />,
      ...renderChatRows(childrenOf(row.chatId), depth + 1),
    ])

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
                renderChatRows(roots, 0)
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
              menu={{
                items: [
                  { id: 'importChats', label: t('importChats') },
                  { id: 'delete', label: t('removeFromLibrary'), danger: true },
                ],
                onSelect: id => {
                  if (id === 'importChats') {
                    importFor.current = character.characterId
                    chatPicker.current?.click()
                  } else if (id === 'delete') {
                    void actions.deleteCharacter(character.characterId)
                  }
                },
              }}
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
        {/* Owned by the character whose menu opened it; `importFor` says who. */}
        <input
          ref={chatPicker}
          type="file"
          accept=".jsonl"
          multiple
          hidden
          onChange={async event => {
            const files = [...(event.target.files ?? [])]
            event.target.value = ''
            const characterId = importFor.current
            importFor.current = ''
            if (characterId === '' || files.length === 0) return
            await actions.importChats(
              characterId,
              await Promise.all(files.map(async file => ({ filename: file.name, base64: await toBase64(file) }))),
            )
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
/**
 * One list row, with an overflow menu for the actions it offers. A chat row
 * carries its branch depth: rows under a parent indent and show the branch
 * mark, per the transfer feature.
 *
 * The menu's items come from the caller: a chat row exports and deletes, a
 * character row imports chats and is removed, and hard-coding either set here
 * would make this one row shape pretend to be two.
 */ */
function ChatRow({
  title,
  meta,
  tags,
  current,
  depth = 0,
  branched = false,
  onOpen,
  menu,
}: {
  title: string
  meta: string
  tags?: string[]
  current: boolean
  /** Indent level, for a branch sitting under the conversation it left. */
  depth?: number
  /** Whether the row is a branch, which is marked as such for a reader. */
  branched?: boolean
  onOpen: () => void
  menu: { items: RowAction[], onSelect: (id: string) => void }
}): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div
      className="iris-row-group"
      style={depth > 0 ? { marginInlineStart: `${String(depth * 18)}px` } : undefined}
    >
      <button type="button" className="iris-row" aria-current={current} onClick={onOpen}>
        <span className="iris-row__title">
          {branched ? <span className="iris-row__branch" aria-hidden="true">↳ </span> : null}
          {title}
        </span>
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
        items={menu.items}
        onSelect={id => {
          setMenuOpen(false)
          menu.onSelect(id)
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
