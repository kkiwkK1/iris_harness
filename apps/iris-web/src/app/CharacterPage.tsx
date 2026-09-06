/**
 * One character's page: the library's other half.
 *
 * `Library.dc.html` is the spec — a branch over the head, a 116px portrait, the
 * name at 22px, tag capsules, 「开始新对话」 in plum, and a row of facts divided
 * by hairlines. It exists because a library row used to *start a conversation on
 * click*, which made the library a launcher with no way to look at a card first.
 *
 * **What the artboards ask for and this page does not show, and why.** They draw
 * a 62ch 简介 and three fact columns: 对话 / 世界书 / 脚本. Of those five things
 * the library actually carries two:
 *
 * - **对话** — derivable. `ChatSummary.characterId` groups the chat list, so the
 *   count and the most recent one are real facts about any character.
 * - **标签 / 卡片文件** — `tags`, `creator` and `updatedAt` are on every summary.
 * - **简介** — *not carried*. `CharacterSummary` has no description field at all
 *   (`iris-protocol/src/views.ts`); the artboard's paragraph is invented prose.
 * - **世界书** — carried for **one** character only. `CharacterSummary.data`
 *   holds `character_book` and, by design, "only for the character being
 *   played": handing out every card's embedded book would put the whole
 *   library's world info in a page that asked about one card.
 * - **脚本** — `state.scripts` describes the **open chat's** character, guarded
 *   by `state.scriptsFor`. There is no per-character script count to show for a
 *   card nobody has opened.
 *
 * So this page shows what is knowable and says nothing where nothing is known,
 * per the standing rule: 没有的数据不编. Two of the artboards' columns are
 * therefore absent rather than filled with dashes, and the grid is `auto-fit`
 * (`shell.css`) so the row reads as finished at whatever count arrives. Adding
 * 简介, 世界书 and 脚本 needs protocol fields that do not exist; that is a
 * request for the host, not something a stylesheet can answer.
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

        <section className="iris-fact">
          <h2 className="iris-label iris-fact__head">{t('faceTags')}</h2>
          <p className="iris-fact__value">
            {character.tags.length === 0
              ? t('faceNoTags')
              : t('faceTagCount', { n: character.tags.length })}
          </p>
        </section>

        <section className="iris-fact">
          <h2 className="iris-label iris-fact__head">{t('faceCardFile')}</h2>
          {/*
            `updatedAt` is the card *file's* last modification and a rename or a
            tag edit touches it, so the sentence says "changed" rather than
            "added" — which is what the protocol's own comment insists the number
            means. When the host reports none, the page says that instead of
            drawing a dash.
          */}
          <p className="iris-fact__value">
            {character.updatedAt === undefined
              ? t('faceUpdatedUnknown')
              : t('faceUpdated', { when: since(character.updatedAt, Date.now(), lang) })}
          </p>
        </section>
      </div>
    </div>
  )
}
