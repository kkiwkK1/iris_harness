/**
 * One message on the reading surface.
 *
 * The layout is a two-column row: marginalia, then text at the measure. What
 * goes in the margin says what the row *is* — a turn ordinal for the reader's
 * own lines, the variant rail for a reply with alternates. There is no bubble,
 * no avatar and no rule, because none of those carry information a reader of a
 * long scene needs, and all of them cost measure.
 *
 * @module iris-web/app/Message
 */

import { memo, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { Menu, writeClipboard, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'

import { MessageActions } from './MessageActions.tsx'
import { MessageInterfaces } from './MessageInterfaces.tsx'
import type { MessageView } from '@iris/protocol'

import { Slot } from '../slots/Slot.tsx'
import { getBodyTag, subscribeBodyTag } from './body-tag.ts'
import { getQuoteScope, subscribeQuoteScope } from './quote-scope.ts'
import {
  clearQuotedDialogue,
  markQuotedDialogue,
  marksQuotedDialogue,
} from './quoted-dialogue.ts'
import { Reasoning } from './Reasoning.tsx'
import { UsagePopover } from './UsagePopover.tsx'
import { VariantRail } from './VariantRail.tsx'
import { usageChipText, usageDetailRows } from './token-format.ts'
import { useLanguage, t } from './i18n/use-language.ts'
import type { BranchLink } from './tree-map.ts'
import { BranchDeleteDialog } from './TreeMap.tsx'
import { useIris, useIrisActions } from '../client/provider.tsx'

/** What a message row can do, supplied by the pane that owns the chat. */
export interface MessageHandlers {
  onSwipe: (turn: number, index: number) => void
  onRegenerate: () => void
  /** Write on from the newest reply; the result rejoins that floor. */
  onContinue: () => void
  /** Have the model write the user's next line instead of a reply. */
  onImpersonate: () => void
  onEdit: (id: number, text: string) => void
  onDelete: (id: number) => void
  onNotify: (text: string) => void
  /** Show how this turn's request was assembled. */
  onExplain: (turn: number) => void
  /** Branch the conversation at this floor, from a given reading when one is named; the branch opens. */
  onBranch: (id: number, swipeId?: number) => void
  /** Go to another conversation of the lineage at a floor. */
  onOpenBranch: (chatId: string, floor: number) => void
}

/**
 * Render one message.
 * @param props.message - the view to render.
 * @param props.canRegenerate - whether this is the row a retry would replace.
 * @param props.handlers - the actions the row offers.
 * @returns the message row.
 */
/*
 * Memoized, and the pane keeps every prop stable for a settled row — the
 * message object (`withStream` reuses the settled rows), the handlers, the
 * branch badges — so a paint of the streaming reply re-renders the streaming
 * row and no other. The row still re-renders on its own subscriptions
 * (language, body tag, quote scope), which `memo` does not block.
 */
/**
 * The ⑂N badge and the list it opens.
 *
 * Each row goes to that conversation at this floor, as before. Under them, two
 * grouped actions name the same conversations again: 「比较变量」 compares this
 * floor's variables with that conversation's same floor (the tree map's compare
 * mode, shown in the margin), and 「删除」 opens the tree map's own delete
 * dialog (`BranchDeleteDialog`, #187), so the two places delete alike.
 *
 * Its own component so the store subscriptions it needs are paid only on the
 * floors that have a badge, not on every row.
 */
function ForkBadge({
  floor,
  branches,
  onOpen,
}: {
  floor: number
  branches: readonly BranchLink[]
  onOpen: (chatId: string, floor: number) => void
}): ReactElement | null {
  const chatId = useIris(state => state.chatId)
  const actions = useIrisActions()
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState<string | undefined>(undefined)
  const label = (link: BranchLink): string => link.relation === 'parent'
    ? t('forkParent', { title: link.title })
    : link.relation === 'sibling'
      ? t('forkSibling', { title: link.title })
      : link.title
  const items: MenuEntry[] = [
    ...branches.map(link => ({ id: `open:${link.chatId}`, label: label(link) })),
    { type: 'separator', id: 'actions' },
    {
      id: 'compare',
      label: t('forkCompare'),
      submenu: branches.map(link => ({ id: `compare:${link.chatId}`, label: label(link) })),
    },
    {
      id: 'delete',
      label: t('forkDeleteGroup'),
      danger: true,
      submenu: branches.map(link => ({ id: `delete:${link.chatId}`, label: label(link), danger: true })),
    },
  ]
  return (
    <>
      <Menu
        open={open}
        portal
        align="start"
        anchor={
          <button
            type="button"
            className="iris-msg__forks"
            data-control="floor-forks"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={t('forkBadgeAria', { n: branches.length })}
            onClick={() => setOpen(!open)}
          >
            ⑂{branches.length}
          </button>
        }
        items={items}
        onSelect={id => {
          setOpen(false)
          const at = id.indexOf(':')
          const verb = id.slice(0, at)
          const target = id.slice(at + 1)
          if (verb === 'open') onOpen(target, floor)
          else if (verb === 'compare' && chatId !== undefined) {
            actions.compareFloors({ chatId, floor }, { chatId: target, floor })
          } else if (verb === 'delete') setDeleting(target)
        }}
        onClose={() => setOpen(false)}
      />
      {deleting === undefined || chatId === undefined ? null : (
        <BranchDeleteDialog
          chatId={deleting}
          viewing={chatId}
          onClose={() => setDeleting(undefined)}
          onConfirm={subBranches => {
            setDeleting(undefined)
            void actions.deleteChat(deleting, { subBranches })
          }}
        />
      )}
    </>
  )
}

export const Message = memo(function Message({
  message,
  canRegenerate,
  handlers,
  branches,
  canBranch = true,
}: {
  message: MessageView
  canRegenerate: boolean
  handlers: MessageHandlers
  /** The other conversations that go on from this floor (the ⑂N badge). */
  branches?: readonly BranchLink[] | undefined
  /** False while a turn is generating: the host refuses a branch then. */
  canBranch?: boolean
}): ReactElement {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.text)
  const field = useRef<HTMLTextAreaElement>(null)
  // Subscribed so a language switch re-renders the row's actions.
  const { lang } = useLanguage()

  useEffect(() => {
    if (editing) field.current?.focus()
  }, [editing])

  const streaming = message.streaming === true
  const swipes = message.swipes
  const turn = message.turn

  /*
   * Quoted dialogue in the theme's quote colour — upstream's `<q>` wrap
   * (`public/script.js:1845-1871`) applied to the rendered prose, because the
   * prose renderer here takes text and lets no HTML into the DOM. The rule and
   * the seam are `app/quoted-dialogue.ts`; the divergence is §121.
   *
   * On the row's own container, not inside `MessageInterfaces`: that component
   * returns a fragment on purpose, and this pass needs one element to walk.
   * The walk skips the interface slots and the scaffolding folds by class, so
   * "prose only" does not depend on where in the fragment a segment landed.
   *
   * **Gated the way upstream gates it, plus one.** Upstream runs the whole
   * block under `if (!isSystem)`, and on nothing else — a user's own line gets
   * its dialogue coloured there, so it does here. The extra gate is streaming:
   * upstream re-formats the entire message per token with no throttling, and
   * this pipeline has declined that bargain everywhere else it appears (the
   * interface claim above is behind the same gate). Dialogue therefore takes
   * its colour when the reply settles.
   *
   * The dependency list is every input the prose DOM is a function of. It has
   * to be complete rather than conservative: a commit this effect does not
   * hear about is one where React has rewritten a text node this pass had
   * emptied, and the `<q>` elements left beside it would then be a stale copy
   * of the previous reading.
   */
  const prose = useRef<HTMLDivElement>(null)
  const bodyTag = useSyncExternalStore(subscribeBodyTag, getBodyTag, getBodyTag)
  // Which quote pairs count: a device preference, and the §122 divergence from
  // upstream's six. Subscribed rather than read once, so flipping the setting
  // re-marks the prose that is already on screen — which is only true because
  // the value is in the dependency list below.
  const quoteScope = useSyncExternalStore(subscribeQuoteScope, getQuoteScope, getQuoteScope)
  // `editing` is not part of the upstream rule: the container simply is not
  // rendered while the textarea is, and leaving it out of this would mean the
  // effect never re-runs for the row that comes back when the edit is over.
  const marked = marksQuotedDialogue(message.role, streaming) && !editing
  useLayoutEffect(() => {
    const root = prose.current
    if (root === null || !marked) return undefined
    markQuotedDialogue(root, quoteScope)
    return () => {
      clearQuotedDialogue(root)
    }
  }, [marked, message.text, message.role, bodyTag, quoteScope, swipes?.index])

  const beginEdit = (): void => {
    setDraft(message.text)
    setEditing(true)
  }

  const commit = (): void => {
    setEditing(false)
    if (draft !== message.text) handlers.onEdit(message.id, draft)
  }

  return (
    <article className={`iris-msg iris-msg--${message.role}`} data-floor={message.id}>
      <div className="iris-msg__margin">
        {message.role === 'assistant' && swipes !== undefined && turn !== undefined ? (
          <VariantRail
            count={swipes.count}
            index={swipes.index}
            interactive={canRegenerate}
            onSelect={index => handlers.onSwipe(turn, index)}
          />
        ) : null}
        {/*
          转成分支, beside the reading control it acts on: the reading on screen
          becomes a conversation of its own, and that conversation opens. Only
          where there is more than one reading — with one, it is the plain
          "Branch" in the row's actions.
        */}
        {message.role === 'assistant' && swipes !== undefined && swipes.count > 1 && !streaming ? (
          <button
            type="button"
            className="iris-rail__branch"
            data-control="swipe-to-branch"
            disabled={!canBranch}
            onClick={() => handlers.onBranch(message.id, swipes.index)}
          >
            ⑂ {t('swipeToBranch')}
          </button>
        ) : null}
        {/*
          The floor's number (upstream's `mesIDDisplay_enabled`, which the
          measured profile turned on). Rendered whenever there is a floor to
          name; the reading preference decides whether it shows, so toggling it
          never remounts a row.
        */}
        <span className="iris-msg__floor" aria-hidden="true">#{message.id}</span>
        {/*
          ⑂N: other conversations go on from this floor. Always shown, unlike
          the floor number, because it is a way somewhere rather than a label.
        */}
        {branches === undefined || branches.length === 0 ? null : (
          <ForkBadge floor={message.id} branches={branches} onOpen={handlers.onOpenBranch} />
        )}
      </div>

      <div className="iris-msg__body">
        <div className="iris-msg__who">{message.name}</div>

        {message.reasoning !== undefined ? (
          <Reasoning
            text={message.reasoning}
            streaming={streaming && message.text === ''}
            // A settled reply with no body: the trace is the reply, and the
            // offer opens the editor on it for the reader to keep or trim.
            onUseAsReply={!streaming && !editing && message.text.trim() === ''
              ? () => { setDraft(message.reasoning ?? ''); setEditing(true) }
              : undefined}
          />
        ) : null}

        {editing ? (
          <>
            <textarea
              ref={field}
              className="iris-edit"
              value={draft}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Escape') setEditing(false)
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) commit()
              }}
            />
            <div className="iris-actions iris-actions--shown">
              <button type="button" className="iris-act" onClick={commit}>
                {t('save')}
              </button>
              <button type="button" className="iris-act" onClick={() => setEditing(false)}>
                {t('cancel')}
              </button>
            </div>
          </>
        ) : (
          <>
            {/*
              Keyed by the visible reading. A swipe therefore remounts this div,
              which is what replays the slip — the animation is attached to mount
              rather than toggled by a class, so it cannot get out of step with
              the state, and streaming (same key throughout) never replays it.
            */}
            <div
              key={swipes?.index ?? 0}
              ref={prose}
              className="iris-msg__text iris-msg__text--enter"
            >
              {/*
                * Every body goes through `MessageInterfaces`, which renders the
                * prose itself and puts a card interface **in place of** the
                * block or bare region that declares it. Rendering `MarkdownText`
                * here as well would show 360 KiB of source above the interface
                * it describes, which is what the first cut did.
                *
                * The row's role travels along, but it never gates this call:
                * upstream renders message HTML wherever the floor sits
                * (`messageFormatting` asks `isUser` only where the regex
                * placement and the name suppression need it), and a console can
                * write a floor of markup onto a user row — which, routed around
                * the pipeline, arrived as 5.8 KiB of visible source. The role
                * decides only the prose between frames: an assistant row's
                * segments read as markdown, a user row's stay the raw text that
                * row has always shown.
                */}
              <MessageInterfaces
                floor={message.id}
                text={message.text}
                streaming={streaming}
                role={message.role}
              />
              {streaming ? <span className="iris-caret" aria-label={t('generatingAria')} /> : null}
            </div>
            <Slot name="iris.message.footer" owner={{ message, streaming }} />

            <div className="iris-actions">
              <button
                type="button"
                className="iris-act"
                onClick={() => {
                  void writeClipboard(message.text)
                  handlers.onNotify(t('copied'))
                }}
              >
                {t('copy')}
              </button>
              <button type="button" className="iris-act" onClick={beginEdit}>
                {t('edit')}
              </button>
              {streaming ? null : (
                <button
                  type="button"
                  className="iris-act"
                  data-control="branch-here"
                  disabled={!canBranch}
                  onClick={() => handlers.onBranch(message.id)}
                >
                  {t('branchHere')}
                </button>
              )}
              {message.role === 'assistant' && turn !== undefined ? (
                <button type="button" className="iris-act" onClick={() => handlers.onExplain(turn)}>
                  {t('promptButton')}
                </button>
              ) : null}
              {canRegenerate ? (
                <>
                  {/*
                    The two generation kinds that act on this floor without
                    replacing it: a continue writes on from THIS reading (the
                    result rejoins it as a new one), and an impersonation has
                    the model write the reader's next line. Both live beside
                    regenerate because they answer the same question — what
                    happens next — just from different seats.
                  */}
                  <button type="button" className="iris-act" onClick={handlers.onContinue}>
                    {t('continueWriting')}
                  </button>
                  <button type="button" className="iris-act" onClick={handlers.onImpersonate}>
                    {t('speakForMe')}
                  </button>
                  <button
                    type="button"
                    className="iris-act iris-act--primary"
                    onClick={handlers.onRegenerate}
                  >
                    {t('regenerate')}
                  </button>
                </>
              ) : null}
              <button
                type="button"
                className="iris-act iris-act--danger"
                onClick={() => handlers.onDelete(message.id)}
              >
                {t('delete')}
              </button>
              {/*
                Provider-contributed actions (the `iris.message.actions`
                seam), folded into one menu so the row's layout does not
                depend on how many providers are installed. Renders nothing —
                literally nothing, no wrapper — when none are.
              */}
              <MessageActions message={message} streaming={streaming} notify={handlers.onNotify} />
              {/*
                What this reply cost, at the end of the row — a reading, not a
                control, which is why it keeps `default` cursor among the
                buttons. It carries the row's own type size and its hover
                reveal, which is the intended loudness: the number is worth
                having and worth nobody looking at it.

                Gated on the fact being present rather than on the role. The
                protocol puts `usage` on an assistant message's selected
                candidate, so `message.usage !== undefined` *is* "an assistant
                reply whose generation was reported"; a role test beside it
                would be this file holding a second opinion about where usage
                lives, and would go quietly wrong if the host ever reported a
                cost for something else.

                Absent for every provider that reports nothing, and for every
                floor imported from a SillyTavern chat file — those were paid
                for somewhere else and Iris has no figure to show. See
                `notes/apps/iris-web/DEVIATIONS.md` 47.

                The breakdown is the hover card (`UsagePopover`), which is the
                anchored dialog this row once promised in a `title`: hover and
                keyboard focus open it, Escape and pointer-out close it, a
                touch tap toggles it, and its rows are `usageDetailRows` — the
                harness dialog's rows, in the harness dialog's order, now read
                by a screen reader as a table instead of one run-on line.

                **The speed rides the same chip, when the host clocked the
                generation.** `message.generation` is a separate optional beside
                `usage` — it has to be, because most OpenAI-compatible
                endpoints report no usage while every generation has a duration,
                and because a duration must never be summed the way a bucket is
                (`@iris/protocol`'s `TurnGeneration`). The chip keeps the word
                「用量」 and appends `· N tok/s`; the rate is the provider's
                output count over the whole generation window, which is
                upstream's own definition, so the number is the one SillyTavern
                would print for the same reply. §92.

                Still gated on `usage`, and deliberately: the rate's numerator
                is the provider's `outputTokens`, so a turn with a stopwatch and
                no bill has nothing to divide and shows neither. What that
                leaves out is a reading with a timing and no usage — visible in
                the popover as nothing at all, rather than as a duration with no
                speed beside it, which is the follow-up §92 names.
              */}
              {message.usage === undefined ? null : (
                <UsagePopover
                  className="iris-act iris-act--reading"
                  heading={t('usageTurnTitle')}
                  rows={usageDetailRows(message.usage, lang, message.generation)}
                >
                  {usageChipText(message.usage, message.generation, lang)}
                </UsagePopover>
              )}
            </div>
          </>
        )}
      </div>
    </article>
  )
})
