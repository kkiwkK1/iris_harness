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
 * **Most cards will show fewer than three columns, by measurement.** Of the 19
 * local cards, 15 carry no description at all, 2 embed no world book and 5 carry
 * no scripts — the modern Chinese cards keep everything in the world book. So
 * absence is the common case rather than the degenerate one: a missing fact
 * removes its column (`没有的数据不编`), and the grid is `auto-fit`
 * (`shell.css`) so the row reads as finished at one column, at two and at three.
 * 对话 is the column that is always knowable — a count over `state.chats`,
 * zero included — which is also why it stays: without it a plain V1 card would
 * render a facts row with nothing in it.
 *
 * What is still not shown: the 62ch measure the artboards give the 简介. It
 * needs a rule in `shell.css`, which this page does not own; the paragraph
 * currently takes the page's own width, and the host's 200-code-point clip is
 * what keeps it from becoming a wall.
 *
 * @module iris-web/app/CharacterPage
 */

import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { PlumBough } from './marks.tsx'
import { Portrait } from './Portrait.tsx'
import { since } from './format.ts'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * Render the character page.
 * @param props.characterId - whose page, or `undefined` before one is chosen.
 * @returns the page, or the prompt to choose someone.
 */
export function CharacterPage({ characterId }: { characterId: string | undefined }): ReactElement {
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
  const actions = useIrisActions()
  // Subscribed so a language switch re-renders every word this page shows.
  const { lang } = useLanguage()

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
   * This character's conversations. Matched on `characterId`, which is optional
   * on a `ChatSummary` — a chat with none is not this character's, so the
   * comparison against a defined id is already the right filter and no
   * `undefined === undefined` case can slip through.
   */
  const theirs = chats.filter(row => row.characterId === character.characterId)
  const latest = theirs.reduce<number | undefined>(
    (newest, row) => (newest === undefined || row.updatedAt > newest ? row.updatedAt : newest),
    undefined,
  )

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
          */}
          <Button
            variant="primary"
            size="sm"
            onClick={() => void actions.createChat(character.characterId)}
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
        </section>

        {/*
          The embedded book's entry count. `0` is a real answer — a card that
          ships an empty book is not a card that ships none, and the protocol
          keeps those apart — so the zero case gets its own sentence rather than
          reading as 「内嵌 0 条」.

          Only the *embedded* book. A card's bindings to books by name are a
          different fact, not on this summary, and saying "N entries" over a
          count that mixed them would be wrong in a way nobody could see.
        */}
        {character.bookEntryCount === undefined ? null : (
          <section className="iris-fact">
            <h2 className="iris-label iris-fact__head">{t('faceWorldbook')}</h2>
            <p className="iris-fact__value">
              {character.bookEntryCount === 0
                ? t('faceBookEmpty')
                : t('faceBookEntries', { n: character.bookEntryCount })}
            </p>
          </section>
        )}

        {character.scriptCount === undefined ? null : (
          <section className="iris-fact">
            <h2 className="iris-label iris-fact__head">{t('faceScripts')}</h2>
            <p className="iris-fact__value">{t('faceScriptCount', { n: character.scriptCount })}</p>
            {authorised === undefined ? null : (
              <p className="iris-fact__note">{authorised}</p>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
