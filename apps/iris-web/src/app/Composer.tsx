/**
 * Where the reader writes their part.
 *
 * **The one place 「梅花」 lets the hand off the brake** (canvas.json: 这一屏唯一
 * 放开手的地方). A branch crosses the top edge in place of a hairline, the paper
 * is dyed 藕粉 downward, the writing surface is a sheet laid on it with a plum
 * blossom sealed into its corner, and the send key is a plum stamp. Everything
 * decorative on this page is here or over the character page; the rest of Iris
 * is 1px rules.
 *
 * It grows with the draft up to a cap, because a reader writing three paragraphs
 * of scene should see them. Under the field, two capsules say what is in force —
 * the prompt and the model — which is the pair of facts a reader checks before
 * pressing send and which previously lived only behind the settings drawer.
 *
 * @module iris-web/app/Composer
 */

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import { useIris } from '../client/provider.tsx'
import type { ResolvedButton } from './script-buttons.ts'
import { Slot } from '../slots/Slot.tsx'
import { PlumBlossom, PlumBranch } from './marks.tsx'
import { ScriptButtons } from './ScriptButtons.tsx'
import { registerComposer } from './composer-bus.ts'
import { usageLineGroups } from './token-format.ts'
import { useLanguage, t } from './i18n/use-language.ts'

/**
 * Render the composer.
 * @param props.chatId - the open chat, for extension contributions.
 * @param props.generating - whether a reply is arriving; Send becomes Stop.
 * @param props.onSend - called with the trimmed draft.
 * @param props.onStop - called to interrupt the reply in flight.
 * @param props.onPreviewPrompt - opens the breakdown of what would be sent next.
 * @returns the composer.
 */
export function Composer({
  chatId,
  generating,
  onSend,
  onStop,
  onPreviewPrompt,
  onPressButton,
}: {
  chatId: string
  generating: boolean
  onSend: (text: string) => void
  onStop: () => void
  onPreviewPrompt: () => void
  /**
   * Press one of the card-script buttons.
   *
   * A prop rather than something this component resolves, for the reason the
   * seam exists: the event name a press must emit is
   * `${scriptId}_${cyrb53(buttonName)}`, and that hash has to be bit-identical
   * to upstream’s or the card’s own listener is never called — silently. The
   * hash lives in one shared place; this file does not get a copy.
   */
  onPressButton: (button: ResolvedButton) => void
}): ReactElement {
  /*
   * Read here rather than threaded down. The script list is store state, and
   * this component already re-renders on every keystroke of the draft — one
   * more prop through that path is one more chance to hold a stale copy.
   */
  const scripts = useIris(state => state.scripts)
  /*
   * What the two capsules report. Both may be absent and both are rendered only
   * when they are not: `activePreset` is loaded by the preset panel rather than
   * at boot (`client/store.ts`), so a reader who has never opened that panel has
   * no preset name to show — and 「提示词 · —」 would be a capsule reporting that
   * the interface does not know, which is worse than one fewer capsule.
   */
  const model = useIris(state => state.settings?.model)
  const preset = useIris(state => state.activePreset)
  /*
   * What the conversation has cost so far — every generation it ever paid for,
   * summed by the host (`ChatView.usage`), swipes included. Read here because
   * this is where the reader is when the question comes up: the number is
   * consulted before pressing send, not while reading back.
   *
   * Selected as the field rather than the whole view, so a delta arriving on a
   * streaming message does not re-render the composer through this line.
   */
  const usage = useIris(state => state.view?.usage)
  const [draft, setDraft] = useState('')
  const field = useRef<HTMLTextAreaElement>(null)
  // Subscribed so a language switch re-renders the composer's words.
  const { lang } = useLanguage()

  // Grow to fit. Measured in a layout effect rather than tracked as state: the
  // height is a function of the text, and holding it in state means a render
  // where the box and its contents disagree.
  useLayoutEffect(() => {
    const node = field.current
    if (node === null) return
    node.style.height = 'auto'
    node.style.height = `${node.scrollHeight}px`
  }, [draft])

  // Focus follows the chat: opening a conversation puts the cursor where the
  // reader is going to type next.
  useEffect(() => {
    field.current?.focus()
  }, [chatId])

  const empty = draft.trim() === ''
  const stats = usageLineGroups(usage, lang)

  const submit = (): void => {
    const text = draft.trim()
    if (text === '' || generating) return
    setDraft('')
    onSend(text)
  }

  /*
   * A card's way in, for the send path upstream gives it.
   *
   * Cards write `#send_textarea.value` and click `#send_but` — 44 measured that
   * in nine cards, eight of them from interface code — so Iris serves it rather
   * than refusing. What Iris adds is that the panel says it happened.
   *
   * **The send reads the field's DOM value, not `draft`.** In this build the
   * card's write already went through `setDraft`, so the two agree; the DOM is
   * the conservative source anyway, because it is what the *card* would have
   * seen and it is one indirection closer to what actually gets sent. It also
   * keeps this correct if anything ever writes the element directly, where
   * React's value tracker leaves `draft` stale.
   *
   * Re-registered whenever `generating` changes, so a card clicking send during
   * a generation is refused with the **current** answer rather than the one from
   * the render where it registered.
   */
  useEffect(() => registerComposer({
    setDraft: text => {
      setDraft(text)
    },
    send: () => {
      if (generating) return 'a generation is already running'
      const text = (field.current?.value ?? draft).trim()
      if (text === '') return 'the composer is empty, so there was nothing to send'
      setDraft('')
      onSend(text)
      return undefined
    },
  }), [generating, draft, onSend])

  return (
    <div className="iris-composer">
      {/* The branch across the top edge, in place of the hairline. Outside
          `__inner` because `__inner` is the scroll container that reserves the
          scrollbar lane, and a scroll container clips what crosses its edge —
          `panels.css` says so where the two rules live. */}
      <PlumBranch />
      <div className="iris-composer__inner">
        {/*
          * Above the field, which is where upstream puts it — it prepends its bar
          * to the send form. Inside `__inner` rather than beside it so the bar
          * lines up with the field's own left edge instead of the panel's.
          */}
        <ScriptButtons scripts={scripts} onPress={onPressButton} />
        <div className="iris-composer__write">
          {/*
            The writing surface. The textarea has no border or ground of its own
            any more — this box draws the paper, the corner and the focus ring
            (`:focus-within`, so no JavaScript has to know the field exists) —
            which is what lets the blossom sit *inside* the sheet rather than
            beside it.
          */}
          <div className="iris-composer__sheet">
            <span className="iris-composer__seal">
              {/* The centre dot takes the raised paper it sits on, not white:
                  under 墨 a white dot would be a hole in the mark. */}
              <PlumBlossom size={18} on="var(--iris-bg-raised)" />
            </span>
            <textarea
              ref={field}
              className="iris-composer__field"
              rows={1}
              value={draft}
              placeholder={generating ? t('irisWriting') : t('writeYourPart')}
              aria-label={t('yourMessage')}
              onChange={event => setDraft(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  submit()
                }
              }}
            />
          </div>
          {generating ? (
            <Button
              variant="outline"
              size="sm"
              className="iris-composer__send iris-composer__send--idle"
              onClick={onStop}
            >
              {t('stop')}
            </Button>
          ) : (
            /*
             * The stamp. Still the primitives' `Button` under the paint, and
             * saturated in both states, as the artboards draw it (user ruling,
             * 2026-09-07, overturning the older "quiet until there is something
             * to send" rule). What the older rule guarded against - a
             * permanently-disabled primary button reading as broken - is met
             * differently now: the seal is `disabled` only while the field is
             * empty and inks up on the first keystroke, and `panels.css` gives
             * the idle state no cast shadow, so it sits *in* the page rather
             * than standing off it. `tools/render-check.tsx` pins the disabled
             * half.
             *
             * `icon` puts the arrow above the word, because the button is a flex
             * *column* here — the component's own `.icon` span is the slot, so
             * the geometry comes from CSS and no markup is duplicated.
             */
            <Button
              variant="primary"
              size="sm"
              className={`iris-composer__send iris-composer__send--${empty ? 'idle' : 'ready'}`}
              icon={<SendArrow />}
              onClick={submit}
              disabled={empty}
            >
              {t('send')}
            </Button>
          )}
        </div>
        <div className="iris-composer__row">
          {/*
            What is in force, as two readouts. The prompt capsule is a button
            because pressing it answers the question the capsule raises — the
            breakdown of what would actually be sent. The per-turn record hangs
            off each message instead.
          */}
          <button
            type="button"
            className="iris-composer__pill iris-composer__pill--action"
            onClick={onPreviewPrompt}
          >
            {preset === undefined ? t('promptButton') : `${t('promptButton')} · ${preset}`}
          </button>
          {model === undefined || model === '' ? null : (
            <span className="iris-composer__pill" title={model}>{model}</span>
          )}
          <Slot name="iris.composer.actions" owner={{ chatId, generating }} />
          <span className="iris-composer__hint">
            {t('composerHint')}
          </span>
        </div>
        {/*
          * What the conversation has cost, under the two capsules.
          *
          * **No row at all when there is nothing to report**, rather than an
          * empty one: `usage` is absent until a generation reports any, so a
          * conversation that has not been generated in yet would otherwise
          * reserve a line of blank height under the field for its whole life,
          * and the composer would jump the first time a reply arrived.
          *
          * Groups separated by `|`, items within a group by `·`, and a group
          * with no data disappears whole (`usageLineGroups`) — the harness's
          * stats strip, whose grouping is the part worth copying: it is what
          * lets a provider that reports no caching simply not have a cache
          * group, instead of having one that says nothing.
          *
          * A native `title` carrying the same line, because the row is one
          * ellipsised line: measuring whether it actually overflowed would
          * mean a `ResizeObserver` per composer to decide whether to attach a
          * tooltip, and a `title` that repeats a fully-visible line costs the
          * reader nothing.
          */}
        {stats.length === 0 ? null : (
          <div className="iris-composer__stats" title={stats.join(' | ')}>
            {stats.map((group, at) => (
              <Fragment key={group}>
                {at === 0 ? null : (
                  <span className="iris-composer__stats-sep" aria-hidden="true">|</span>
                )}
                <span>{group}</span>
              </Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The stamp's arrow.
 *
 * Not in `marks.tsx`: that module is the 「梅花」 decoration, and this is an icon
 * — the difference is that a reader is meant to read this one.
 * @returns the arrow.
 */
function SendArrow(): ReactElement {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.5 8h9M8 4.5 11.5 8 8 11.5" />
    </svg>
  )
}
