/**
 * Where the context went.
 *
 * The panel's shape comes from one measurement rather than from a guess about
 * what a breakdown looks like: on a real preset and card, 1920 of 2929 prompt
 * tokens were a single world-info injection. So this is not a chart of comparable
 * parts — it is one column and a pile of rubble, and the design follows from
 * that.
 *
 * - **A proportion bar first**, because "one thing is eating everything" is the
 *   headline and a table of numbers makes the reader compute it.
 * - **Rows ordered by size by default**, so the answer is the first line rather
 *   than somewhere in the middle of forty two-token rows.
 * - **`label`, never `id`.** 29 of that preset's 41 prompts identify themselves
 *   with a UUID; the label is the string SillyTavern shows, so a user who
 *   imported the preset recognises the row.
 * - **Nothing merged into an "other".** The rubble is thin but it is real, and a
 *   panel whose job is accounting must not round away the parts it finds small.
 * - **Every row says why.** A part that cost nothing reads as "empty", and the
 *   three ordinary reasons a real preset produces — a prompt that is only
 *   `{{setvar}}` macros, a marker slot this turn filled with nothing, a preset
 *   item left blank — lead a reader to three different places. The host sends
 *   the reason; this panel renders it.
 *
 * @module iris-web/app/PromptPanel
 */

import { useEffect, useState } from 'react'
import type { ReactElement } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptDivergence, PromptDivergenceItem, PromptItemization } from '@iris/protocol'

import { useIrisActions } from '../client/provider.tsx'
import {
  budgetUse,
  contributing,
  discrepancy,
  itemizationMode,
  macroNote,
  messageRows,
  regexNote,
  rowsFor,
  sourceNoteKey,
  splitMembers,
  zeroReasonKey,
  type Explained,
  type ItemOrder,
  type MessageRow,
} from './itemization.ts'
import {
  cacheCeiling,
  itemName,
  itemsById,
  providerExcuse,
  providerFellShort,
  providerShare,
  unservedItems,
} from './divergence.ts'
import { useLanguage, t } from './i18n/use-language.ts'
import type { StringKey } from './i18n/strings.ts'

/** One decimal, and only where it says something: 0.4% and 66% both have to read cleanly. */
function percent(share: number): string {
  const value = share * 100
  if (value >= 10) return `${Math.round(value)}%`
  if (value >= 1) return `${value.toFixed(1)}%`
  return value === 0 ? '0%' : '<1%'
}

/** Bytes, grouped, with the unit the dictionary supplies. */
function bytes(count: number): string {
  return t('divergenceBytes', { bytes: count.toLocaleString() })
}

/** What the panel is doing. */
type PanelState =
  | { kind: 'loading' }
  | { kind: 'error', message: string }
  | { kind: 'ready', itemization: PromptItemization, divergence?: PromptDivergence }

/**
 * Render the breakdown panel.
 * @param props.open - whether the panel is showing.
 * @param props.turn - the turn to itemize, or undefined to preview the next request.
 * @param props.onClose - dismissal.
 * @returns the modal.
 */
export function PromptPanel({
  open,
  turn,
  onClose,
}: {
  open: boolean
  turn: number | undefined
  onClose: () => void
}): ReactElement {
  const actions = useIrisActions()
  const [order, setOrder] = useState<ItemOrder>('size')
  const [state, setState] = useState<PanelState>({ kind: 'loading' })
  // Subscribed so a language switch re-renders the panel's words.
  useLanguage()

  useEffect(() => {
    if (!open) return
    let live = true
    setState({ kind: 'loading' })
    // The comparison is fetched beside the itemization and **not keyed to
    // `turn`**: an itemization is an account of one assembly, while a divergence
    // is a comparison of the two newest requests, and a turn can have sent
    // several (every swipe is one). Asking for "turn 4's divergence" would be
    // asking a question with no single answer. It also must not decide this
    // panel's state — the breakdown is the panel, and a store switched off has
    // to leave it standing.
    void Promise.all([actions.itemize(turn), actions.divergence()]).then(([itemized, diverged]) => {
      if (!live) return
      setState(
        itemized.ok
          ? {
              kind: 'ready',
              itemization: itemized.itemization,
              ...diverged.ok && diverged.divergence !== undefined ? { divergence: diverged.divergence } : {},
            }
          : { kind: 'error', message: `${itemized.error.code}: ${itemized.error.message}` },
      )
    })
    return () => {
      live = false
    }
  }, [open, turn, actions])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={turn === undefined ? t('promptNextTitle') : t('promptTurnTitle', { turn })}
      closeLabel={t('close')}
      /*
        The primitive's dialog card is 380px wide and clips its overflow — a
        measure for a confirmation, not for a four-column table. Left at that
        width the share and token columns fell outside the card and were cut
        off, which is what a reader saw as "rows without numbers". The dialog,
        not the table, has to carry the wider measure, because the clip is on
        the dialog.
      */
      className="iris-prompt-dialog"
    >
      {state.kind === 'loading' ? <p className="iris-list__empty">{t('counting')}</p> : null}
      {state.kind === 'error' ? <p className="iris-list__empty">{state.message}</p> : null}
      {state.kind === 'ready' ? (
        <Breakdown
          itemization={state.itemization}
          divergence={state.divergence}
          requestedTurn={turn}
          order={order}
          onOrder={setOrder}
        />
      ) : null}
    </Modal>
  )
}

/** The breakdown itself, once it has arrived. */
function Breakdown({
  itemization,
  divergence,
  requestedTurn,
  order,
  onOrder,
}: {
  itemization: PromptItemization
  divergence: PromptDivergence | undefined
  requestedTurn: number | undefined
  order: ItemOrder
  onOrder: (order: ItemOrder) => void
}): ReactElement {
  const rows = rowsFor(itemization.entries, order, itemization.tokens)
  const compared = itemsById(divergence)
  const use = budgetUse(itemization)
  const mismatch = discrepancy(itemization)
  const mode = itemizationMode(itemization, requestedTurn)
  const [view, setView] = useState<'rows' | 'messages'>('rows')
  const messages = messageRows(itemization)
  // The parent subscribed to the language; these words follow it.
  useLanguage()

  return (
    <div className="iris-prompt">
      {mode === 'expired' ? (
        <p className="iris-prompt__notice">
          {t('promptExpired')}
        </p>
      ) : null}
      {mismatch === undefined ? null : (
        <p className="iris-prompt__notice iris-prompt__notice--wrong">
          {t('promptMismatch', {
            sum: (itemization.tokens + mismatch).toLocaleString(),
            reported: itemization.tokens.toLocaleString(),
          })}
        </p>
      )}

      <div className="iris-prompt__totals">
        <div className="iris-prompt__total">
          <span className="iris-prompt__figure">{itemization.tokens.toLocaleString()}</span>
          <span className="iris-label">{t('promptEstimated')}</span>
        </div>
        {itemization.actualTokens === undefined ? null : (
          <div className="iris-prompt__total">
            <span className="iris-prompt__figure">{itemization.actualTokens.toLocaleString()}</span>
            {/* Both, side by side: the only way to answer "is the estimate
                trustworthy", which the reader cannot otherwise ask. */}
            <span className="iris-label">{t('promptProviderCounted')}</span>
          </div>
        )}
        <div className="iris-prompt__total">
          <span className="iris-prompt__figure">{percent(use.used)}</span>
          <span className="iris-label">{t('promptOfAvailable', { n: use.available.toLocaleString() })}</span>
        </div>
      </div>

      {/*
        One bar, proportions only, always in assembly order — the bar answers
        "how is it divided", and reordering its segments would make the same
        prompt look like a different one depending on a control above it.
        Nothing is merged, so a one-pixel segment stays a real part.
      */}
      <div className="iris-prompt__bar" role="img" aria-label={t('promptShareAria')}>
        {rowsFor(contributing(itemization.entries), 'assembly', itemization.tokens).map(row => (
          <span
            key={row.entry.id}
            className={`iris-prompt__slice iris-prompt__slice--${row.entry.kind}`}
            style={{ width: `${row.share * 100}%` }}
            title={`${row.entry.label} · ${row.entry.tokens.toLocaleString()}`}
          />
        ))}
      </div>

      <div className="iris-prompt__controls">
        {/*
          The same request read the other way round: by part (a table that says
          which message each went to) or by message (a list that says which
          parts each holds). Both come from the host's one assembly pass, so
          switching between them cannot show two different requests.

          Only offered when the host sends `messages` — an older record has no
          reverse index, and a tab that opened an empty view would read as a
          defect rather than as an old host.
        */}
        {messages.length === 0 ? null : (
          <div className="iris-choice" role="group" aria-label={t('promptViewAria')}>
            <button
              type="button"
              className="iris-choice__option"
              aria-pressed={view === 'rows'}
              data-control="prompt-view-rows"
              onClick={() => setView('rows')}
            >
              {t('promptViewTabRows')}
            </button>
            <button
              type="button"
              className="iris-choice__option"
              aria-pressed={view === 'messages'}
              data-control="prompt-view-messages"
              onClick={() => setView('messages')}
            >
              {t('promptViewTabMessages')}
            </button>
          </div>
        )}
        <div className="iris-choice" role="group" aria-label={t('rowOrderAria')}>
          <button
            type="button"
            className="iris-choice__option"
            aria-pressed={order === 'size'}
            onClick={() => onOrder('size')}
          >
            {t('orderLargest')}
          </button>
          <button
            type="button"
            className="iris-choice__option"
            aria-pressed={order === 'assembly'}
            onClick={() => onOrder('assembly')}
          >
            {t('orderAssembly')}
          </button>
        </div>
        {itemization.droppedHistory === 0 ? null : (
          <span className="iris-meta">
            {t('droppedToFit', { n: itemization.droppedHistory })}
          </span>
        )}
        {itemization.overBudget ? <span className="iris-prompt__over">{t('overBudget')}</span> : null}
      </div>

      {divergence === undefined ? null : <Divergence divergence={divergence} />}

      {view === 'messages'
        ? <MessageView messages={messages} />
        : (
      <ul className="iris-prompt__rows">
        {rows.map(row => (
          <li
            className={`iris-prompt__row${
              row.entry.deferred === true ? ' iris-prompt__row--deferred' : ''}${
              row.entry.promoted === true ? ' iris-prompt__row--promoted' : ''}`}
            key={row.entry.id}
          >
            <span className={`iris-prompt__kind iris-prompt__kind--${row.entry.kind}`}>
              {row.entry.kind === 'depth' ? `@${row.entry.depth ?? 0}` : row.entry.kind}
            </span>
            {/* The id is the tooltip, not the text: it is usually a UUID. */}
            <span className="iris-prompt__label" title={row.entry.id}>
              {row.entry.label}
              {row.entry.role === undefined ? null : <span className="iris-meta"> {row.entry.role}</span>}
              {/*
                Both halves, always together. The badge says the row is not
                being sent from where it sits; the position says where it sits,
                which is where the reader put it and where they will go to
                change it. A badge without the position would tell someone their
                prompt moved and give them nowhere to look.
              */}
              {row.entry.deferred !== true && row.entry.promoted !== true
                ? null
                : (
                    <span
                      className={row.entry.promoted === true
                        ? 'iris-prompt__deferred iris-prompt__deferred--promoted'
                        : 'iris-prompt__deferred'}
                      title={t(row.entry.promoted === true ? 'promptPromotedAria' : 'promptDeferredAria')}
                      data-control={row.entry.promoted === true ? 'prompt-promoted' : 'prompt-deferred'}
                    >
                      {t(row.entry.promoted === true ? 'promptPromoted' : 'promptDeferred')}
                      <span className="iris-meta">
                        {' '}
                        {t('promptDeferredWhere', { n: row.origin.at, total: row.origin.total })}
                      </span>
                    </span>
                  )}
              {/*
                What became of this part between the last two requests, on the
                part's own row — a reader looking at a 5 601-token world-info
                section wants to know whether they paid for it again, and that
                answer belongs next to the section, not in a second table.

                **Only rows the comparison actually names.** The itemization
                folds the whole conversation into one `chatHistory` row while the
                comparison lists floors one by one, so the history row has no
                counterpart here and gets no mark; its bytes are in the summary's
                `new` term above. A mark invented for it would be a claim about a
                part that was never compared.
              */}
              {compared.get(row.entry.id) === undefined ? null : (
                <ItemMark item={compared.get(row.entry.id) as PromptDivergenceItem} />
              )}
            </span>
            {/*
              A zero-token part reads as "empty", not as "0". They are common — 14
              of one real preset's 53, 23 of 38 on a measured conversation — and a
              reader looking for one is asking why their X did not get through.
              Seeing it present and empty answers that; seeing `0` invites them to
              wonder if the count is broken.

              The word alone is where the panel used to stop. The reason under it
              is the answer: three ordinary causes — a variable-only preset
              prompt, a slot nothing filled, a preset item left blank — used to
              render as one identical "empty".
            */}
            <span className="iris-prompt__share iris-meta">
              {row.entry.tokens === 0 ? '' : percent(row.share)}
            </span>
            <span className={`iris-prompt__tokens${row.entry.tokens === 0 ? ' iris-prompt__tokens--empty' : ''}`}>
              {row.entry.tokens === 0 ? t('tokenEmpty') : row.entry.tokens.toLocaleString()}
            </span>
            {/*
              Why this row is what it is, when the host explains it: who wrote
              the bytes, and (on a zero row) why there are none. Absent from an
              older host's record, and rendered as nothing then — a sentence
              invented for that state would claim a cause nobody measured.
            */}
            <Explanation entry={row.entry} />
            {/*
              The entries a split row is the join of, when they did not all go
              the same way. A world-info depth bucket is one row here and
              several world-info entries in the request, and once two of them
              are in the prefix and a third is not, the row above carries no
              badge at all — deliberately, since none would be true of it. This
              is where the answer lives instead.

              `splitMembers` holds the decision about *when* to show them —
              only when the split actually did something — because that
              condition is worth a test of its own and a condition written in
              here is only reachable through a rendered DOM.
            */}
            {splitMembers(row.entry).length === 0
              ? null
              : (
                  <ul className="iris-prompt__members">
                    {splitMembers(row.entry).map(member => (
                      <li
                        className={`iris-prompt__member${
                          member.deferred === true ? ' iris-prompt__row--deferred' : ''}${
                          member.promoted === true ? ' iris-prompt__row--promoted' : ''}`}
                        key={member.id}
                      >
                        <span className="iris-prompt__label" title={member.id}>
                          {member.label}
                          {member.deferred !== true && member.promoted !== true
                            ? null
                            : (
                                <span
                                  className={member.promoted === true
                                    ? 'iris-prompt__deferred iris-prompt__deferred--promoted'
                                    : 'iris-prompt__deferred'}
                                  title={t(member.promoted === true ? 'promptPromotedAria' : 'promptDeferredAria')}
                                  data-control={member.promoted === true
                                    ? 'prompt-member-promoted'
                                    : 'prompt-member-deferred'}
                                >
                                  {t(member.promoted === true ? 'promptPromoted' : 'promptDeferred')}
                                </span>
                              )}
                          {/*
                            The comparison names members by the same id the
                            itemization does, so an entry that was re-sent
                            verbatim says so on its own line rather than on its
                            bucket's — which is the whole reason the bucket was
                            split.
                          */}
                          {compared.get(member.id) === undefined ? null : (
                            <ItemMark item={compared.get(member.id) as PromptDivergenceItem} />
                          )}
                        </span>
                        <span className="iris-prompt__tokens">
                          {member.tokens === 0 ? t('tokenEmpty') : member.tokens.toLocaleString()}
                        </span>
                        {/* A member carries the same explanation shape the row
                            does, so one component renders both. */}
                        <Explanation entry={member} />
                      </li>
                    ))}
                  </ul>
                )}
          </li>
        ))}
      </ul>
        )}
    </div>
  )
}

/**
 * The request as a list of messages, each with the parts it holds.
 *
 * The reverse of the table above, and the same request: a reader who asks "what
 * actually goes out, in what order" gets a straight answer here, and a reader
 * asking "what is eating my context" keeps the size-ordered table. The two are
 * offered as a switch rather than side by side because they answer one question
 * with two shapes and a reader picks the shape, not both at once.
 *
 * A message's parts hang under it as the row view's members do, so the same
 * explanation renders in both — who wrote the part and, on a zero, why there is
 * nothing. A floor says its number and nothing more: the contract folds the
 * conversation into one aggregate row, so a floor has no entry to look up.
 * @param props.messages - the rows from `messageRows`.
 * @returns the message list.
 */
function MessageView({ messages }: { messages: MessageRow[] }): ReactElement {
  return (
    <ul className="iris-prompt__messages" data-control="prompt-messages">
      {messages.map(message => (
        <li className="iris-prompt__message" key={message.index}>
          <div className="iris-prompt__message-head">
            <span className="iris-prompt__kind iris-prompt__kind--message">
              {t('promptMessageHeading', { n: message.index + 1 })}
            </span>
            <span className="iris-prompt__label">{message.role}</span>
            <span className={message.stable ? 'iris-meta' : 'iris-prompt__zero-reason'}>
              {t(message.stable ? 'promptMessageStable' : 'promptMessageUnstable')}
            </span>
            <span className="iris-prompt__tokens">{message.tokens.toLocaleString()}</span>
          </div>
          {message.parts.length === 0
            ? <p className="iris-prompt__message-empty iris-meta">{t('promptMessageEmpty')}</p>
            : (
                <ul className="iris-prompt__members">
                  {message.parts.map(part => (
                    <li className="iris-prompt__member" key={part.id}>
                      <span className="iris-prompt__label" title={part.id}>
                        {part.floor
                          ? t('promptMessageFloor', { n: part.label.replace(/^floor /u, '') })
                          : part.label}
                        {part.kind === 'depth' && part.explanation?.placement?.depth !== undefined
                          ? <span className="iris-meta"> @{part.explanation.placement.depth}</span>
                          : null}
                      </span>
                      {/* The same explanation the row view renders, so one
                          component holds the copy for both. */}
                      {part.explanation === undefined
                        ? null
                        : <Explanation entry={{ tokens: 0, explanation: part.explanation }} />}
                    </li>
                  ))}
                </ul>
              )}
        </li>
      ))}
    </ul>
  )
}

/**
 * Who wrote this row's bytes, and — on a zero row — why there are none, and what
 * the macro and regex stages did to it.
 *
 * One component for the row and its member sub-rows: the contract carries the
 * same `PromptItemExplanation` on both, and a second renderer would be a second
 * place for the copy to drift. `sourceNoteKey`, `zeroReasonKey`, `macroNote` and
 * `regexNote` hold the decisions as pure functions, so this stays layout.
 * @param props.entry - the row or member to explain.
 * @returns the explanation lines, or null when the host did not explain it.
 */
function Explanation({ entry }: { entry: Explained }): ReactElement | null {
  const source = sourceNoteKey(entry)
  const reason = zeroReasonKey(entry)
  const macros = macroNote(entry)
  const regex = regexNote(entry)
  if (source === null && reason === null && macros === null && regex === null) return null
  return (
    <span className="iris-prompt__explain" data-control="prompt-explained">
      {source === null ? null : <span className="iris-meta">{t(source.key as StringKey, { name: source.name })}</span>}
      {reason === null ? null : (
        <span className="iris-prompt__zero-reason">{t(reason as StringKey)}</span>
      )}
      {macros === null ? null : (
        <span className="iris-meta">
          {t('promptMacros', {
            kinds: macros.kinds,
            top: macros.top,
            count: macros.count,
            before: macros.before.toLocaleString(),
            after: macros.after.toLocaleString(),
          })}
        </span>
      )}
      {/*
        The regex stage, and **both states say something**: a chain that ran and
        changed nothing is not the same fact as a host that did not record, and
        an empty line would read as the first when it might be the second.
      */}
      {regex === null ? null : (
        <span className="iris-meta">
          {regex.length === 0
            ? t('promptRegexNone')
            : t('promptRegex', { rules: regex.join(', ') })}
        </span>
      )}
    </span>
  )
}

/** What became of one part, as a mark beside its label. */
function ItemMark({ item }: { item: PromptDivergenceItem }): ReactElement {
  const word = {
    same: 'divergenceStateSame',
    changed: 'divergenceStateChanged',
    added: 'divergenceStateAdded',
    gone: 'divergenceStateGone',
  }[item.state] as StringKey
  /*
   * A part that did not change and was re-sent in full is marked differently
   * from one that did not change and was served from cache — same `state`,
   * opposite outcome. This is the shape depth injection produces on every turn
   * of a real conversation (measured: 51%–76% of the loss on five of nine
   * adjacent pairs of `爱衣`), and a panel that showed both as "unchanged" would
   * hide the single largest recoverable cost in the product.
   */
  const stranded = item.state === 'same' && item.uncachedBytes > 0
  return (
    <span
      className={`iris-prompt__diverge iris-prompt__diverge--${stranded ? 'stranded' : item.state}`}
      title={stranded ? t('divergenceStranded') : undefined}
    >
      {t(word)}
      {item.uncachedBytes === 0 ? null : ` ${bytes(item.uncachedBytes)}`}
    </span>
  )
}

/**
 * The comparison against the previous request, above the token table.
 *
 * Its own block rather than a column, because it is a different measurement of a
 * different thing: the table is this assembly's estimated tokens, and this is two
 * requests' actual bytes. Putting the ceiling and the provider's own figure on
 * one line is the point — the gap between them is what settles whether a turn
 * that reported nothing was the prompt's fault or the provider's, which is the
 * question three turns of the user's corpus have been unable to answer.
 * @param props.divergence - the comparison.
 * @returns the block.
 */
function Divergence({ divergence }: { divergence: PromptDivergence }): ReactElement {
  const ceiling = cacheCeiling(divergence)
  const served = providerShare(divergence)
  const excuse = providerExcuse(divergence)
  const worst = unservedItems(divergence)
  return (
    <section className="iris-prompt__diverged" data-control="prompt-divergence">
      <p className="iris-prompt__notice">
        <span className="iris-label">
          {t('divergenceHeading', { kind: divergence.kind, previousKind: divergence.previousKind })}
        </span>
        {' '}
        {t('divergenceCeiling', { percent: percent(ceiling) })}
        {' · '}
        {served === null
          ? t('divergenceUnreported')
          : t('divergenceServed', { percent: percent(served) })}
        {providerFellShort(divergence) ? ` — ${t('divergenceShortfall')}` : ''}
      </p>
      {/*
        Why a shortfall may be nobody's defect, said **before** a reader starts
        looking for one. A cold start, an expired entry, a model switch and an
        interrupted reply each produce a miss on an identical prompt, and all
        four are ordinary; a panel that reported only the gap would spend the
        reader's attention on false alarms before the real one.
      */}
      {excuse === null ? null : (
        <p className="iris-meta">
          {excuse === 'cold-start' ? t('divergenceColdStart') : null}
          {excuse === 'stale' ? t('divergenceStale') : null}
          {excuse === 'route'
            ? t('divergenceRoute', { from: divergence.previousModel, to: divergence.model })
            : null}
          {excuse === 'interrupted' ? t('divergenceInterrupted') : null}
        </p>
      )}
      {/*
        The four terms, which add up to the total exactly. §1.2 of CACHE-PREFIX.md
        split the loss two ways and left a few hundred bytes unaccounted for; a
        reader who adds these up must get the total, or the next reader assumes
        the rest is rounding and there is no rounding here.
      */}
      <p className="iris-meta">
        {t('divergenceSplit', {
          total: divergence.uncacheableBytes.toLocaleString(),
          added: bytes(divergence.addedBytes),
          changed: bytes(divergence.changedBytes),
          repeated: bytes(divergence.repeatedBytes),
          structure: bytes(divergence.structureBytes),
        })}
      </p>
      {divergence.attributed ? null : (
        <p className="iris-prompt__notice iris-prompt__notice--wrong">
          {t('divergenceUnattributed', { reason: divergence.attributionNote ?? '' })}
        </p>
      )}
      {/*
        Worst first, and only the parts that cost something. A list of every part
        buries the answer under the sections that behaved — and the largest part
        of a request is routinely one that was fully cached.
      */}
      <ul className="iris-prompt__unserved">
        {worst.map(item => (
          <li key={item.id}>
            <span className="iris-prompt__label">
              {itemName(item, floor => t('divergenceFloor', { n: floor }))}
            </span>
            <ItemMark item={item} />
          </li>
        ))}
      </ul>
    </section>
  )
}
