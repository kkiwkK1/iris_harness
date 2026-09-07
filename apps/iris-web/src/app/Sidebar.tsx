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
 * **Neither the open tab nor the chosen character is local state any more.**
 * Both live in the shell (`App.tsx`), because under 「梅花」 the library tab
 * changes the *main area* too: a row opens that character's page rather than
 * starting a conversation with it on the spot. That is the artboards' ruling
 * (`Library.dc.html`), and it also answers a real cost of the old behaviour — a
 * click that created a chat immediately left no way to look at a card first.
 *
 * @module iris-web/app/Sidebar
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button, Menu } from '@deepseek-ai/dsh-client-ui-primitives'

import type { CharacterSummary, ChatSummary } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { Slot } from '../slots/Slot.tsx'
import { Portrait } from './Portrait.tsx'
import { PlumBlossom } from './marks.tsx'
import { useLanguage, t } from './i18n/use-language.ts'
import { since, toBase64 } from './format.ts'
import { CARD_FILE_ACCEPT } from './card-files.ts'
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
 * @param props.tab - which list is showing; held by the shell, because the main
 *   area follows it.
 * @param props.onTab - switch lists.
 * @param props.face - the character whose page is open, if any.
 * @param props.onFace - open a character's page.
 * @returns the sidebar.
 */
export function Sidebar({
  open,
  tab,
  onTab,
  face,
  onFace,
}: {
  open: boolean
  tab: SidebarTab
  onTab: (tab: SidebarTab) => void
  face: string | undefined
  onFace: (characterId: string) => void
}): ReactElement {
  /*
   * Kept under the name the tablist has always written, because
   * `sidebar-tabs.test.ts` pins each `data-tab="…"` against the `setTab('…')`
   * beside it — two literals for one identity, and that test is the only thing
   * that notices when they drift. Renaming the call to `onTab` in the JSX would
   * have silenced it rather than satisfied it.
   */
  const setTab = onTab
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
  // whole list is already in the store, so a keystroke re-renders it at once —
  // a round trip per filter would be latency in front of a list this small.
  const [libraryQuery, setLibraryQuery] = useState('')
  const [sortBy, setSortBy] = useState<CharacterSort>('name')
  // At most one row edits at a time; `undefined` means none does.
  const [renaming, setRenaming] = useState<{ id: string, name: string } | undefined>(undefined)
  const [tagging, setTagging] = useState<{ id: string, tags: string } | undefined>(undefined)

  /** Chats grouped under the parent they were branched from, in list order. */
  const childrenOf = (parentChatId: string): ChatSummary[] =>
    chats.filter(row => row.parentChatId === parentChatId)
  const roots = chats.filter(row =>
    row.parentChatId === undefined || !chats.some(other => other.chatId === row.parentChatId))

  /*
   * One box over names and tags, which is what the artboards' 「搜索角色或标签」
   * promises and what replaced the tag `<select>`. Case-folded on both sides,
   * and a substring rather than a prefix: a corpus card is called
   * `不要被神隐挑战 V1.5.4 测试版`, and a reader looking for it types 神隐.
   */
  const needle = libraryQuery.trim().toLowerCase()
  const visibleCharacters = characters
    .filter(character => needle === ''
      || character.name.toLowerCase().includes(needle)
      || character.tags.some(tag => tag.toLowerCase().includes(needle)))
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
        {/* The centre dot takes the desk this mark sits on, so it reads as a
            blossom rather than as a hole punched in one under 墨. */}
        <PlumBlossom size={22} on="var(--iris-bg-base)" />
        <span className="iris-brand__name">Iris</span>
      </div>

      {/*
       * `data-tab` carries the tab's identity in the state's own vocabulary.
       *
       * Everything else that distinguishes these two buttons is translated text:
       * the class and the role are identical, so an instrument reaching for
       * "Characters" finds it on an English profile and finds `角色库` on this
       * one. Every acceptance script that located a tab by its label broke the
       * day the shell learned to speak the reader's language, and located-by-
       * position is the alternative nobody wants to debug.
       *
       * The value is the state value passed to `setTab` beside it, deliberately
       * — one vocabulary for the store, the DOM and the scripts — and a test
       * pins that they agree, because two spellings of one identity is the
       * failure this exists to prevent.
       */}
      <div className="iris-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className="iris-tab"
          data-tab="chats"
          aria-selected={tab === 'chats'}
          onClick={() => setTab('chats')}
        >
          {t('tabReading')}
        </button>
        <button
          type="button"
          role="tab"
          className="iris-tab"
          data-tab="characters"
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
              A search box and three capsules, as the artboards draw it.

              This replaces two `<select>`s. The tag one is gone because the box
              above searches tags as well — a corpus-wide tag census runs to
              dozens of names, and a menu of them is a scroll rather than a
              filter. The sort one is gone because three words fit on the line:
              a menu that must be opened to reveal its whole set costs a click
              to learn nothing.
            */}
            <input
              type="search"
              className="iris-search"
              aria-label={t('librarySearchAria')}
              placeholder={t('librarySearchPlaceholder')}
              value={libraryQuery}
              onChange={event => setLibraryQuery(event.target.value)}
            />
            <div className="iris-sorts" role="group" aria-label={t('sortByAria')}>
              {([
                ['favorite', t('sortByFavorite')],
                ['updated', t('sortByUpdated')],
                ['name', t('sortByName')],
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className="iris-sort"
                  aria-pressed={sortBy === id}
                  onClick={() => setSortBy(id)}
                >
                  {label}
                </button>
              ))}
            </div>
            {visibleCharacters.length === 0 ? (
              <p className="iris-list__empty">{t('librarySearchEmpty', { query: libraryQuery.trim() })}</p>
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
                    current={character.characterId === face}
                    onOpen={() => { onFace(character.characterId) }}
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
          accept={CARD_FILE_ACCEPT}
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
 * One library row: a portrait, the name, its tags, a star, and the manager menu.
 *
 * The portrait is what makes this row a different shape from a chat row rather
 * than the same shape with different words — a library is scanned by face, and
 * the artboards give it 34px of one. The star is its own control rather than a
 * menu item *only*, because favouriting is the one action a reader does without
 * opening anything, and hiding it a menu deep would starve the sort-by-favorites
 * order of the rows that make it useful. The menu carries the rest: duplicate,
 * rename, tags, export and the chat import that was already here.
 *
 * The row's meta line is now the **tags**, not the date. Both were on it before
 * and the row could not hold both plus a portrait; the artboards choose tags,
 * and the choice is right — a date sorts a library and a tag identifies a card.
 * The date is on the character page, where there is room to say what it means.
 */
function CharacterRow({
  character,
  lang,
  current,
  onOpen,
  onToggleStar,
  menu,
}: {
  character: CharacterSummary
  /** The interface language, for the row's relative-time words. */
  lang: Language
  /** Whether this character's page is the one open. */
  current: boolean
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
      <button
        type="button"
        className="iris-row iris-row--character"
        aria-current={current}
        onClick={onOpen}
      >
        <Portrait character={character} size="row" />
        <span className="iris-row__lines">
          <span className="iris-row__title">{character.name}</span>
          {character.tags.length > 0 ? (
            <span className="iris-row__tags">
              {character.tags.slice(0, 3).map(tag => (
                <span className="iris-tag" key={tag}>
                  {tag}
                </span>
              ))}
            </span>
          ) : (
            // No tags is not nothing to say: the row still has to report when
            // the card last changed, or a whole untagged library shows two
            // lines of name and one of blank.
            <span className="iris-row__meta iris-meta">{meta}</span>
          )}
        </span>
      </button>
      {/*
        The star carries `iris-star` as well as `iris-act`, which it did not
        before: the glyph used to be prefixed to the name *inside* the row and
        the button beside it was an unstyled action, so two marks said one thing
        and only one of them was plum. Now there is one star, and it is the
        control (`shell.css` — plum when on, the faintest ink when not).
      */}
      <button
        type="button"
        className={starred ? 'iris-act iris-star iris-star--on' : 'iris-act iris-star'}
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
