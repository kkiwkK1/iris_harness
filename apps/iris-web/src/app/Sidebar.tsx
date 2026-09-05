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

import type { CharacterSummary, ChatSummary } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { Slot } from '../slots/Slot.tsx'
import { useLanguage, t } from './i18n/use-language.ts'
import { since, toBase64 } from './format.ts'
import type { Language } from './i18n/strings.ts'
import type { ChatSearchHit } from '@iris/protocol'

/** Which list the sidebar is showing. */
export type SidebarTab = 'chats' | 'characters'

/** The orders a character list can be read in. */
type CharacterSort = 'name' | 'updated' | 'favorite'

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

  // The library's filter, sort and inline editors. All client-side state: the
  // whole list is already in the store, so a tag click re-renders it at once —
  // a round trip per filter would be latency in front of a list this small.
  const [tagFilter, setTagFilter] = useState('')
  const [sortBy, setSortBy] = useState<CharacterSort>('name')
  // At most one row edits at a time; `undefined` means none does.
  const [renaming, setRenaming] = useState<{ id: string, name: string } | undefined>(undefined)
  const [tagging, setTagging] = useState<{ id: string, tags: string } | undefined>(undefined)

  /** Chats grouped under the parent they were branched from, in list order. */
  const childrenOf = (parentChatId: string): ChatSummary[] =>
    chats.filter(row => row.parentChatId === parentChatId)
  const roots = chats.filter(row =>
    row.parentChatId === undefined || !chats.some(other => other.chatId === row.parentChatId))

  // Every tag the library carries, once, in reading order — the filter's
  // options. A tag no card uses any more disappears from the row by itself.
  const allTags = [...new Set(characters.flatMap(character => character.tags))].sort((a, b) => a.localeCompare(b))
  const visibleCharacters = characters
    .filter(character => tagFilter === '' || character.tags.includes(tagFilter))
    .sort((left, right) => {
      if (sortBy === 'updated') {
        return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
      }
      if (sortBy === 'favorite' && (left.favorite === true) !== (right.favorite === true)) {
        return left.favorite === true ? -1 : 1
      }
      return left.name.localeCompare(right.name)
    })

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
          <>
            {/*
              Filter and sort, above the rows. Two selects rather than a row of
              chips: a corpus-wide tag census runs to dozens of tags, and a chip
              row that scrolls sideways hides the filter it exists to offer.
            */}
            <div className="iris-library-tools">
              <select
                className="iris-search"
                aria-label={t('filterByTag')}
                value={tagFilter}
                onChange={event => setTagFilter(event.target.value)}
              >
                <option value="">{t('allTags')}</option>
                {allTags.map(tag => (
                  <option key={tag} value={tag}>{tag}</option>
                ))}
              </select>
              <select
                className="iris-search"
                aria-label={t('sortByAria')}
                value={sortBy}
                onChange={event => setSortBy(event.target.value as CharacterSort)}
              >
                <option value="name">{t('sortByName')}</option>
                <option value="updated">{t('sortByUpdated')}</option>
                <option value="favorite">{t('sortByFavorite')}</option>
              </select>
            </div>
            {visibleCharacters.length === 0 ? (
              <p className="iris-list__empty">{t('libraryFilteredEmpty', { tag: tagFilter })}</p>
            ) : (
              visibleCharacters.map(character =>
                renaming?.id === character.characterId ? (
                  <InlineEditor
                    key={character.characterId}
                    label={t('characterNameAria')}
                    value={renaming.name}
                    onChange={name => setRenaming({ id: character.characterId, name })}
                    onSave={() => {
                      const name = renaming.name.trim()
                      setRenaming(undefined)
                      if (name.length > 0 && name !== character.name) {
                        void actions.renameCharacter(character.characterId, name)
                      }
                    }}
                    onCancel={() => setRenaming(undefined)}
                  />
                ) : tagging?.id === character.characterId ? (
                  <InlineEditor
                    key={character.characterId}
                    label={t('tagsInputAria')}
                    value={tagging.tags}
                    onChange={tags => setTagging({ id: character.characterId, tags })}
                    onSave={() => {
                      const tags = tagging.tags.split(',').map(tag => tag.trim()).filter(tag => tag !== '')
                      setTagging(undefined)
                      void actions.setCharacterTags(character.characterId, tags)
                    }}
                    onCancel={() => setTagging(undefined)}
                  />
                ) : (
                  <CharacterRow
                    key={character.characterId}
                    character={character}
                    lang={lang}
                    onOpen={() => void actions.createChat(character.characterId)}
                    onToggleStar={() =>
                      void actions.favoriteCharacter(character.characterId, character.favorite !== true)}
                    menu={{
                      items: [
                        {
                          id: 'favorite',
                          label: t(character.favorite === true ? 'unfavorite' : 'favorite'),
                        },
                        { id: 'duplicate', label: t('duplicateCharacter') },
                        { id: 'rename', label: t('renameCharacterMenu') },
                        { id: 'tags', label: t('editTags') },
                        { id: 'exportPng', label: t('exportCardPng') },
                        { id: 'exportJson', label: t('exportCardJson') },
                        { id: 'importChats', label: t('importChats') },
                        { id: 'delete', label: t('removeFromLibrary'), danger: true },
                      ],
                      onSelect: id => {
                        if (id === 'favorite') {
                          void actions.favoriteCharacter(character.characterId, character.favorite !== true)
                        } else if (id === 'duplicate') {
                          void actions.duplicateCharacter(character.characterId)
                        } else if (id === 'rename') {
                          setRenaming({ id: character.characterId, name: character.name })
                        } else if (id === 'tags') {
                          setTagging({ id: character.characterId, tags: character.tags.join(', ') })
                        } else if (id === 'exportPng') {
                          void actions.exportCharacter(character.characterId, 'png')
                        } else if (id === 'exportJson') {
                          void actions.exportCharacter(character.characterId, 'json')
                        } else if (id === 'importChats') {
                          importFor.current = character.characterId
                          chatPicker.current?.click()
                        } else if (id === 'delete') {
                          void actions.deleteCharacter(character.characterId)
                        }
                      },
                    }}
                  />
                ),
              )
            )}
          </>
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
 * One list row, with an overflow menu for the actions it offers. A chat row
 * carries its branch depth: rows under a parent indent and show the branch
 * mark, per the transfer feature.
 *
 * The menu's items come from the caller: a chat row exports and deletes, a
 * character row imports chats and is removed, and hard-coding either set here
 * would make this one row shape pretend to be two.
 */
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
 * One library row: open on click, a star beside it, and the manager menu.
 *
 * The star is its own control rather than menu item *only* — favouriting is
 * the one action a reader does without opening anything, and hiding it a menu
 * deep would starve the sort-by-favorites order of the rows that make it
 * useful. The menu carries the rest: duplicate, rename, tags, export and the
 * chat import that was already here.
 */
function CharacterRow({
  character,
  lang,
  onOpen,
  onToggleStar,
  menu,
}: {
  character: CharacterSummary
  /** The interface language, for the row's relative-time words. */
  lang: Language
  onOpen: () => void
  onToggleStar: () => void
  menu: { items: RowAction[], onSelect: (id: string) => void }
}): ReactElement {
  const [menuOpen, setMenuOpen] = useState(false)
  const starred = character.favorite === true
  const meta = character.updatedAt === undefined
    ? character.creator === undefined
      ? t('noCreatorListed')
      : t('byCreator', { creator: character.creator })
    : since(character.updatedAt, Date.now(), lang)

  return (
    <div className="iris-row-group">
      <button type="button" className="iris-row" onClick={onOpen}>
        <span className="iris-row__title">
          <span className={starred ? 'iris-star iris-star--on' : 'iris-star'} aria-hidden="true">
            {starred ? '★' : '☆'}
          </span>
          {character.name}
        </span>
        <span className="iris-row__meta iris-meta">
          {character.creator === undefined || character.updatedAt === undefined
            ? meta
            : `${meta} · ${t('byCreator', { creator: character.creator })}`}
        </span>
        {character.tags.length > 0 ? (
          <span className="iris-row__tags">
            {character.tags.slice(0, 4).map(tag => (
              <span className="iris-tag" key={tag}>
                {tag}
              </span>
            ))}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        className="iris-act"
        aria-label={t(starred ? 'unfavorite' : 'favorite')}
        aria-pressed={starred}
        title={t(starred ? 'unfavorite' : 'favorite')}
        onClick={onToggleStar}
      >
        {starred ? '★' : '☆'}
      </button>
      <Menu
        open={menuOpen}
        portal
        align="end"
        anchor={
          <button
            type="button"
            className="iris-act"
            aria-label={t('moreActionsFor', { title: character.name })}
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
 * One row's in-place editor: rename and tags both, because they are the same
 * gesture — a field, a confirm, an escape. The editor replaces the row rather
 * than floating over it, so the row it edits stays exactly where the cursor
 * left it.
 */
function InlineEditor({
  label,
  value,
  onChange,
  onSave,
  onCancel,
}: {
  label: string
  value: string
  onChange: (next: string) => void
  onSave: () => void
  onCancel: () => void
}): ReactElement {
  const focus = useRef<HTMLInputElement>(null)
  useEffect(() => { focus.current?.focus() }, [])
  return (
    <div className="iris-row-group">
      <input
        ref={focus}
        type="text"
        className="iris-search"
        aria-label={label}
        value={value}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') onSave()
          else if (event.key === 'Escape') onCancel()
        }}
      />
      <button type="button" className="iris-act iris-act--primary" onClick={onSave}>
        {t('save')}
      </button>
      <button type="button" className="iris-act" onClick={onCancel}>
        {t('cancel')}
      </button>
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
