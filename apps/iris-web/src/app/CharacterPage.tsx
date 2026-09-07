/**
 * One character's page: the library's other half.
 *
 * `Library.dc.html` is the spec — a branch over the head, a 116px portrait, the
 * name at 22px, tag capsules, 「开始新对话」 in plum, and a row of facts divided
 * by hairlines. It exists because a library row used to *start a conversation on
 * click*, which made the library a launcher with no way to look at a card first.
 *
 * **The facts are now the artboards' own.** They draw a 简介 paragraph over
 * three columns — 对话 / 世界书 / 脚本 — and until `CharacterSummary` grew
 * `description`, `bookEntryCount` and `scriptCount` two of those three could
 * only be filled for the one character being played, so the page stood in 标签
 * and 卡片文件 instead. The protocol carries counts and one clipped string now,
 * never contents, which is what makes them affordable for every row: a whole
 * card is a median of 494 KiB and up to 2.8 MiB, and none of that is on the
 * wire here.
 *
 * **Each column is a count over a list now, and the list is fetched.** A count
 * answers "how much" and nothing else: the page said 「1 个进行中」,「内嵌 140
 * 条」,「1 个」 over most of a screen of white space, and a reader who wanted to
 * know *which* conversation, *which* entries or *which* scripts had to go
 * somewhere else for all three. So the page asks for the rest **once per card**
 * — `loadCharacterDetail`, which is `worldbook.charDigest` plus `script.list`
 * held against the character id — and each list sits under the count that was
 * already there. The counts stay the anchor deliberately: a host with no book
 * store refuses the digest, and the column then reads exactly as it did before
 * rather than emptying out.
 *
 * What is on the wire is the point. `worldbook.charDigest` sends an entry's
 * name, keys, flags and position and **no `content`**, which is what makes the
 * 140-entry card 23 KB rather than 341 KB; and a book folds shut behind its own
 * three figures (`<details>`), with its entries scrolling inside the column,
 * because 140 rows laid out at once is the shape this page was asked not to
 * become.
 *
 * **Most cards will show fewer than three columns, by measurement.** Of the 19
 * local cards, 15 carry no description at all, 2 embed no world book and 5 carry
 * no scripts — the modern Chinese cards keep everything in the world book. So
 * absence is the common case rather than the degenerate one: a missing fact
 * removes its column (`没有的数据不编`), and the grid is `auto-fit`
 * (`shell.css`) so the row reads as finished at one column, at two and at three.
 * 对话 is the column that is always knowable — a count over `state.chats`, and
 * now its rows too, because neither needs a host call — which is why it stays:
 * without it a plain V1 card would render a facts row with nothing in it.
 *
 * The one thing this page will not do is *change* a card's scripts.
 * `script.setEnabled` is scoped to the card whose conversation is open (the
 * store's `scriptsFor`) and its switch lives in `ScriptPanel` beside that
 * conversation; a card merely being browsed has both its switches reported here
 * and is told where the control is.
 *
 * @module iris-web/app/CharacterPage
 */

import { useEffect } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { PlumBough } from './marks.tsx'
import { Portrait } from './Portrait.tsx'
import { describeBytes, since } from './format.ts'
import {
  bookFigures,
  chatsOf,
  describeBookOrigin,
  describeButtons,
  describePlace,
  describeScriptSwitch,
  describeTrigger,
  latestActivity,
} from './character-facts.ts'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * Render the character page.
 * @param props.characterId - whose page, or `undefined` before one is chosen.
 * @param props.onEnterReading - called when the reader opens or starts a
 *   conversation from this page, so the shell can put the reading surface in
 *   front. Required rather than optional: which surface is showing is `App`'s
 *   own state and nothing here can reach it, and a conversation the reader
 *   cannot see is the same failure whether it was opened or created.
 * @returns the page, or the prompt to choose someone.
 */
export function CharacterPage({
  characterId,
  onEnterReading,
}: {
  characterId: string | undefined
  onEnterReading: () => void
}): ReactElement {
  const characters = useIris(state => state.characters)
  const chats = useIris(state => state.chats)
  /*
   * The consent answer, and which card it was given about.
   *
   * Both, never just the answer: `scriptsAllowed` describes whatever card
   * `scriptsFor` names, so reading it on a page about a different character
   * would report one card's decision as another's — the same fault the store
   * clears the field for when a chat opens. A card nobody has opened has no
   * answer here, and this page then says nothing about authorisation rather
   * than implying "not yet allowed".
   */
  const scriptsFor = useIris(state => state.scriptsFor)
  const scriptsAllowed = useIris(state => state.scriptsAllowed)
  /*
   * What this page fetched about the card, **and which card that was** — read
   * together for the same reason the consent pair is. A detail slice naming
   * another character is one card's books under another card's name, and the
   * store carries the id precisely so that a reader cannot be shown that.
   */
  const detail = useIris(state => state.characterDetail)
  const actions = useIrisActions()
  // Subscribed so a language switch re-renders every word this page shows.
  const { lang } = useLanguage()

  /*
   * One fetch per card, on arrival and on every switch.
   *
   * The action refuses a card it already holds, so this effect firing again — a
   * re-render, a language switch, the reader coming back to a card they looked
   * at earlier — costs nothing. The guard is on the store side rather than here
   * because the store is what knows what it holds; a page-side flag would go
   * stale the moment a second surface asked.
   */
  useEffect(() => {
    if (characterId !== undefined) void actions.loadCharacterDetail(characterId)
  }, [characterId, actions])

  const character = characters.find(row => row.characterId === characterId)

  if (character === undefined) {
    return (
      <div className="iris-face">
        <div className="iris-empty">
          <p className="iris-empty__line">{t('facePickHint')}</p>
        </div>
      </div>
    )
  }

  /*
   * This character's conversations, newest first, and when it was last active.
   *
   * Both derived from `state.chats` (`character-facts.ts`) with no host call,
   * which is what keeps this column answerable for every card on every host.
   * The filter is on `characterId`, which is optional on a `ChatSummary` — a
   * chat with none is not this character's, so comparing against a defined id
   * is already the right test.
   */
  const theirs = chatsOf(chats, character.characterId)
  const latest = latestActivity(theirs)

  // The fetched halves, but only if they describe *this* card.
  const mine = detail?.characterId === character.characterId ? detail : undefined
  const books = mine?.books
  const scripts = mine?.scripts
  const reading = mine === undefined || mine.loading

  /*
   * The authorisation line under the script count, when there is one to draw.
   *
   * Written as an **allow-list of the two answered states**, not as a list of
   * the states to skip. Three things print nothing here — a card this page's
   * store holds no answer for, an answer still in flight (`unknown`) and a
   * question never put (`unasked`) — and all three mean "the user has not
   * decided", which a page must not render as a decision. A deny-list would
   * hand a fourth state, added later to `ConsentState`, the *reported* branch by
   * default; silence is the safe default for a permission.
   *
   * The two sentences are two literal `t('…')` calls rather than one call over a
   * computed key: `i18n.test.ts` finds the shell's keys by scanning for exactly
   * that form, so a key reached through a ternary *inside* `t()` is invisible to
   * it and would be held by the compiler alone.
   */
  const decided = scriptsFor === character.characterId
    && (scriptsAllowed === 'allowed' || scriptsAllowed === 'declined')
  const authorised = !decided
    ? undefined
    : scriptsAllowed === 'allowed' ? t('faceScriptsAllowed') : t('faceScriptsDeclined')

  /*
   * Whether the world book column exists at all.
   *
   * Two facts can put it there, and the second one is new: the card embeds a
   * book (`bookEntryCount`, which the library carries for every row), **or** the
   * host listed one. A card that embeds nothing and binds a book by name has
   * world info that no count on the summary can see — and 18 of the 19 local
   * cards bind something. Neither fact present is still absence: no column.
   */
  const hasBooks = books !== undefined && books.length > 0
  const bookColumn = character.bookEntryCount !== undefined || hasBooks

  return (
    <div className="iris-face" aria-label={t('characterPageAria')}>
      {/* The one large decoration on the product. It is behind the head, which
          is why the head carries 96px of top padding: the content sits in the
          branch's lower half rather than on top of it. */}
      <PlumBough />

      <div className="iris-face__head">
        <Portrait character={character} size="page" />
        <div className="iris-face__lines">
          <h1 className="iris-face__name">{character.name}</h1>
          {character.creator === undefined || character.creator === '' ? null : (
            <p className="iris-face__by">{t('faceCreator', { creator: character.creator })}</p>
          )}
          {character.tags.length === 0 ? null : (
            <div className="iris-face__tags">
              {character.tags.map(tag => (
                <span className="iris-tag" key={tag}>{tag}</span>
              ))}
            </div>
          )}
        </div>
        <div className="iris-face__actions">
          {/*
            The whole reason the page exists: starting a conversation is now a
            decision taken here rather than the side effect of clicking a row.
            It hands over to the reading surface exactly as the rows below do —
            a new conversation the reader cannot see is the same failure as an
            opened one they cannot see.
          */}
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              void actions.createChat(character.characterId)
              onEnterReading()
            }}
          >
            {t('startNewChat')}
          </Button>
        </div>
      </div>

      {/*
        The 简介 as its own band above the columns, which is how the artboards
        draw it. A one-column `iris-face__facts` rather than a bare paragraph:
        the grid is what carries the page's gutter, so a paragraph outside it
        would sit flush against the window edge. The empty string is refused
        alongside `undefined` — the protocol drops the field when a card's
        description is blank, and a client that sent one anyway would otherwise
        get a heading over nothing.
      */}
      {character.description === undefined || character.description === '' ? null : (
        <div className="iris-face__facts">
          <section className="iris-fact iris-fact--prose">
            <h2 className="iris-label iris-fact__head">{t('faceDescription')}</h2>
            <p className="iris-fact__value">{character.description}</p>
          </section>
        </div>
      )}

      <div className="iris-face__facts">
        <section className="iris-fact">
          <h2 className="iris-label iris-fact__head">{t('faceConversations')}</h2>
          <p className="iris-fact__value">
            {theirs.length === 0
              ? t('faceNoConversations')
              : theirs.length === 1
                ? t('faceOneConversation')
                : t('faceOpenCount', { n: theirs.length })}
          </p>
          {latest === undefined ? null : (
            <p className="iris-fact__note">
              {t('faceLatest', { when: since(latest, Date.now(), lang) })}
            </p>
          )}
          {/*
            One row per conversation, and the row *is* the library's existing
            open action: `openChat` is what the sidebar's rows call, so this is a
            second place to reach it rather than a second way to open a chat.
            「开始新对话」 above remains the create path.
          */}
          {theirs.length === 0 ? null : (
            <ul className="iris-fact__list">
              {theirs.map(row => (
                <li key={row.chatId}>
                  <button
                    type="button"
                    className="iris-fact__row"
                    aria-label={t('faceOpenConversation', { title: row.title })}
                    onClick={() => {
                      void actions.openChat(row.chatId)
                      onEnterReading()
                    }}
                  >
                    <span className="iris-fact__name">{row.title}</span>
                    <span className="iris-meta iris-fact__meta">
                      {`${since(row.updatedAt, Date.now(), lang)} · ${t('messageCount', { count: row.messageCount })}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/*
          The embedded book's entry count, and now the books themselves.

          `0` is a real answer — a card that ships an empty book is not a card
          that ships none, and the protocol keeps those apart — so the zero case
          gets its own sentence rather than reading as 「内嵌 0 条」.

          The count line is still only about the *embedded* book, because that is
          the only book `CharacterSummary` knows about. The rows under it are the
          host's own answer to which books this card involves, each saying what
          it is. The two numbers can differ — a book edited after it was
          materialised out of the card — and that difference is worth seeing.
        */}
        {!bookColumn ? null : (
          <section className="iris-fact">
            <h2 className="iris-label iris-fact__head">{t('faceWorldbook')}</h2>
            {character.bookEntryCount === undefined ? null : (
              <p className="iris-fact__value">
                {character.bookEntryCount === 0
                  ? t('faceBookEmpty')
                  : t('faceBookEntries', { n: character.bookEntryCount })}
              </p>
            )}
            {/*
              While the fetch is in flight the column says so. Once it has
              settled, an absent list is the host declining to answer — no book
              store — and nothing more is printed: the count above is still true,
              and an empty list here would read as "this card has no books".
            */}
            {books === undefined ? (
              reading ? <p className="iris-fact__note">{t('readingCard')}</p> : null
            ) : (
              books.map(book => {
                const figures = bookFigures(book)
                const origin = describeBookOrigin(book, lang)
                return (
                  <details className="iris-fact__book" key={`${book.role}:${book.name}`}>
                    <summary className="iris-fact__row">
                      {/*
                        The name is clipped to one line (`shell.css`), and a book
                        name is exactly the string a reader is hunting for — the
                        measured failure this whole family exists for is a reader
                        unable to find their own card's book among nine. So the
                        full name is on the hover as well.
                      */}
                      <span className="iris-fact__name" title={book.name}>{book.name}</span>
                      <span className="iris-meta iris-fact__meta">
                        {[
                          figures.entries === 0
                            ? t('faceBookNoEntries')
                            : t('faceBookFigures', {
                                n: figures.entries,
                                enabled: figures.enabled,
                                constant: figures.constant,
                              }),
                          origin,
                        ].filter(part => part !== undefined).join(' · ')}
                      </span>
                    </summary>
                    {/*
                      The entries scroll inside the column rather than
                      lengthening the page: the largest local book is 153
                      entries, and a column that grew by 153 rows would push
                      whatever is beside it off the screen the moment one book
                      was opened.
                    */}
                    {book.entries.length === 0 ? null : (
                      <ul className="iris-fact__entries">
                        {book.entries.map(entry => (
                          <li className="iris-fact__entry" key={entry.uid}>
                            <span className="iris-fact__name" title={entry.name}>
                              {entry.name === '' ? `#${String(entry.uid)}` : entry.name}
                            </span>
                            <span className="iris-meta iris-fact__meta">
                              {[
                                entry.constant ? t('faceEntryConstant') : undefined,
                                describeTrigger(entry, lang),
                                describePlace(entry, lang),
                                entry.keysSecondary === undefined
                                  ? undefined
                                  : t('faceEntrySecondary', { n: entry.keysSecondary.length }),
                                entry.enabled ? undefined : t('faceEntryOff'),
                              ].filter(part => part !== undefined).join(' · ')}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </details>
                )
              })
            )}
          </section>
        )}

        {character.scriptCount === undefined ? null : (
          <section className="iris-fact">
            <h2 className="iris-label iris-fact__head">{t('faceScripts')}</h2>
            <p className="iris-fact__value">{t('faceScriptCount', { n: character.scriptCount })}</p>
            {authorised === undefined ? null : (
              <p className="iris-fact__note">{authorised}</p>
            )}
            {scripts === undefined ? (
              reading ? <p className="iris-fact__note">{t('readingCard')}</p> : null
            ) : (
              <>
                <ul className="iris-fact__list">
                  {scripts.map(script => (
                    <li className="iris-fact__entry" key={script.id}>
                      <span className="iris-fact__name" title={script.name}>{script.name}</span>
                      <span className="iris-meta iris-fact__meta">
                        {[
                          /*
                            Every row here came out of the card: `script.list`
                            answers with the card's own scripts and there is no
                            other tier behind it (the corpus's 42 scripts all
                            declare ST's `type: 'script'`). Said rather than
                            assumed, because "where is this from" is the first
                            question a list of runnable code raises.
                          */
                          t('faceScriptInCard'),
                          describeScriptSwitch(script, lang),
                          describeBytes(script.bytes, lang),
                          describeButtons(script, lang),
                        ].filter(part => part !== undefined).join(' · ')}
                      </span>
                      {script.info === undefined || script.info === '' ? null : (
                        <span className="iris-fact__note">{script.info}</span>
                      )}
                    </li>
                  ))}
                </ul>
                {scripts.length === 0 ? null : (
                  <p className="iris-fact__note">{t('faceScriptSwitchNote')}</p>
                )}
              </>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
