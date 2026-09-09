/**
 * Settings, ordered rather than pruned.
 *
 * The loudest complaint about SillyTavern is that every knob is on screen at
 * once and a newcomer cannot tell which four matter. So: the parameters that
 * change a scene are at the top, the ones tuned once per model are behind one
 * disclosure, and reading preferences — which are not model settings at all and
 * live on the device — are their own section at the bottom. Nothing was removed.
 *
 * The drawer overlays the page instead of resizing it, because reflowing a page
 * of prose while a slider is being dragged is disorienting.
 *
 * @module iris-web/app/SettingsDrawer
 */

import { useState } from 'react'
import type { ReactElement } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'

import type { ContinuePostfix, GenerationSettings } from '@iris/protocol'
import { MAX_CONTEXT_WINDOW } from '@iris/protocol'

import { useIris, useIrisActions } from '../client/provider.tsx'
import { Slot } from '../slots/Slot.tsx'
import { ChoiceField, CollapsibleSection, NumberField, TextField, ToggleField } from './fields.tsx'
import { AboutCard } from './AboutCard.tsx'
import { BackupPanel } from './BackupPanel.tsx'
import { ConnectionPanel } from './ConnectionPanel.tsx'
import { DemoActionsSection } from './DemoActionsSection.tsx'
import { HostReports } from './HostReports.tsx'
import { NoticeLog } from './NoticeLog.tsx'
import { PresetPanel } from './PresetPanel.tsx'
import { PresetRegexPanel } from './PresetRegexPanel.tsx'
import { PersonaPanel } from './PersonaPanel.tsx'
import { RegexPanel } from './RegexPanel.tsx'
import { ScopedRegexPanel } from './ScopedRegexPanel.tsx'
import { ScriptLibraryPanel } from './ScriptLibraryPanel.tsx'
import { ScriptPanel } from './ScriptPanel.tsx'
import { UsageSection } from './UsageSection.tsx'
import { WorldbookPanel } from './WorldbookPanel.tsx'
import { SandboxProbe } from '../dev/SandboxProbe.tsx'
import { RailPreview } from '../dev/RailPreview.tsx'
import { AppearanceCard } from './AppearanceCard.tsx'
import { READING_LIMITS, type ReadingPrefs } from '../theme/theme.ts'
import { useLanguage, t } from './i18n/use-language.ts'
import type { Language, StringKey } from './i18n/strings.ts'

/** The continue separator's menu words, by the wire word the setting stores. */
const POSTFIX_LABEL: Record<ContinuePostfix, StringKey> = {
  none: 'postfixNone',
  space: 'postfixSpace',
  newline: 'postfixNewline',
  double: 'postfixDouble',
}

/** The sampling fields, for the sampling card's summary count. */
const SAMPLING_KEYS = [
  'temperature', 'maxTokens', 'topP', 'topK', 'minP', 'repetitionPenalty',
  'frequencyPenalty', 'presencePenalty', 'seed', 'stop', 'contextWindow', 'reasoningEffort',
] as const

/**
 * The reply card's summary: what is shaping replies right now.
 *
 * The separator always runs (its default is upstream's), so it is the
 * summary's backbone; the two switches appear only while they are on.
 */
function repliesSummaryOf(settings: GenerationSettings): string {
  const parts: string[] = []
  if (settings.trimSentences === true) parts.push(t('repliesTrim'))
  if (settings.squashSystemMessages === true) parts.push(t('repliesSquash'))
  // Named only when it is OFF, the mirror of the two above: this one is on by
  // default, so its interesting state — the one a reader wants the summary to
  // surface without opening the card — is having been switched off.
  if (settings.cacheFriendly === false) parts.push(t('repliesCacheOff'))
  parts.push(t('repliesContinue', { word: t(POSTFIX_LABEL[settings.continuePostfix ?? 'space']) }))
  return parts.join(' · ')
}

/** Reading preferences and their setter, owned by the shell because they are per-device.
 *
 * The theme is not here: it moved to the appearance card, which reads the
 * theme store directly — a choice drawn as swatches wants the store, not a
 * prop drilled from the shell.
 */
export interface ReadingControl {
  reading: ReadingPrefs
  setReading: (prefs: ReadingPrefs) => void
}

/**
 * Render the settings drawer.
 * @param props.open - whether it is showing.
 * @param props.onClose - called on the close button or Escape.
 * @param props.control - reading preferences, which do not go to the host.
 * @returns the drawer.
 */
export function SettingsDrawer({
  open,
  onClose,
  control,
}: {
  open: boolean
  onClose: () => void
  control: ReadingControl
}): ReactElement {
  const settings = useIris(state => state.settings)
  const chatId = useIris(state => state.chatId)
  const actions = useIrisActions()
  const [expanded, setExpanded] = useState(false)
  // The language control, and the subscription that makes a switch repaint this
  // drawer without a reload.
  const { lang, setLang } = useLanguage()

  const patch = (key: string, value: number | string | boolean | null | string[]): void => {
    void actions.patchSettings({ [key]: value })
  }

  // Computed per render, guarded the way the branch below is: the reply card
  // only exists when the settings exist.
  const repliesSummary = settings === undefined ? undefined : repliesSummaryOf(settings)

  return (
    <aside
      className={`iris-drawer${open ? ' iris-drawer--open' : ''}`}
      aria-label={t('drawerAria')}
      aria-hidden={!open}
      onKeyDown={event => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="iris-drawer__head">
        <h2 className="iris-label iris-drawer__title">
          {chatId === undefined ? t('defaultsForNew') : t('thisConversation')}
        </h2>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t('close')}
        </Button>
      </div>

      <div className="iris-drawer__body">
        {settings === undefined ? (
          <p className="iris-list__empty">{t('settingsNotLoaded')}</p>
        ) : (
          <>
            <ConnectionPanel />

            {/*
              The preset library and the prompt manager, above the per-field
              controls: a preset switch rewrites several of the values below at
              once (temperature, window, effort), so the reader meets the thing
              that changes them before the things changed.
            */}
            <PresetPanel />

            {/*
              The global regex tier, after the presets: like a preset, it is a
              profile-wide surface that shapes what the reader and the model see
              on every conversation, and the drawer is where a reader looks for
              the things that change text they did not type.
            */}
            <RegexPanel />

            {/*
              The active preset's own tier, between the profile's and the card's,
              because that is where it runs: upstream's `SCRIPT_TYPES` iterates
              global → preset → character. It sits here rather than under the
              preset section above — which is its *subject* — because these
              sections are read as a sequence, and a reader comparing them is
              comparing along the axis that decides which rewrite wins.
            */}
            <PresetRegexPanel />

            {/*
              The card's own tier, under the other two, because that is the order
              they run in — upstream's `SCRIPT_TYPES` iteration puts global
              first and the card's last. A reader comparing the lists is
              comparing them along the axis that decides which rewrite wins.
            */}
            <ScopedRegexPanel />

            {/*
              **The 「路由」 card is gone** (2026-09-09, with the connection
              panel's rebuild). It was `provider` and `model` as two free-text
              fields on the global settings layer — a third place to set the
              route, beside the provider list above and the model capsule under
              the composer, and the only one of the three that took a typed
              string with nothing to check it against. That is the failure the
              whole connection surface is built to prevent: the profile measured
              on a real SillyTavern install was named `deepseek deepseek-chat`
              and pointed at Gemini, and a free-text `model` is how the same
              drift starts here. Both values are still fully settable — a
              provider's own editor writes them together with the endpoint and
              the credential they belong to, and `settings.set` still carries
              them for anything that asks — so nothing is lost but the loose
              field.
            */}
            <CollapsibleSection
              id="sampling"
              title={t('sectionSampling')}
              summary={SAMPLING_KEYS.some(key => settings[key] !== undefined)
                ? t('samplingSet', { count: SAMPLING_KEYS.filter(key => settings[key] !== undefined).length })
                : t('samplingDefault')}
            >
              <NumberField
                label={t('temperature')}
                value={settings.temperature}
                bounds={{ min: 0, max: 2, step: 0.01 }}
                fallback={1}
                note={t('temperatureNote')}
                onCommit={value => patch('temperature', value)}
              />
              <NumberField
                label={t('replyLengthCap')}
                value={settings.maxTokens}
                bounds={{ min: 128, max: 8192, step: 64 }}
                fallback={1024}
                decimals={0}
                note={t('replyLengthCapNote')}
                onCommit={value => patch('maxTokens', value)}
              />
              <NumberField
                label={t('topP')}
                value={settings.topP}
                bounds={{ min: 0, max: 1, step: 0.01 }}
                fallback={0.95}
                note={t('topPNote')}
                onCommit={value => patch('topP', value)}
              />
              <NumberField
                label={t('repetitionPenalty')}
                value={settings.repetitionPenalty}
                bounds={{ min: 1, max: 1.5, step: 0.01 }}
                fallback={1.05}
                note={t('repetitionPenaltyNote')}
                onCommit={value => patch('repetitionPenalty', value)}
              />

              <div className="iris-field">
                <button
                  type="button"
                  className="iris-reason__toggle iris-field__control"
                  aria-expanded={expanded}
                  onClick={() => setExpanded(!expanded)}
                >
                  <span
                    className={`iris-reason__chevron${expanded ? ' iris-reason__chevron--open' : ''}`}
                    aria-hidden="true"
                  >
                    ▸
                  </span>
                  {expanded ? t('fewerParameters') : t('moreParameters')}
                </button>
              </div>

              {expanded ? (
                <>
                  <NumberField
                    label={t('topK')}
                    value={settings.topK}
                    bounds={{ min: 0, max: 200, step: 1 }}
                    fallback={40}
                    decimals={0}
                    onCommit={value => patch('topK', value)}
                  />
                  <NumberField
                    label={t('minP')}
                    value={settings.minP}
                    bounds={{ min: 0, max: 0.5, step: 0.005 }}
                    fallback={0.05}
                    decimals={3}
                    onCommit={value => patch('minP', value)}
                  />
                  <NumberField
                    label={t('frequencyPenalty')}
                    value={settings.frequencyPenalty}
                    bounds={{ min: -2, max: 2, step: 0.01 }}
                    fallback={0}
                    onCommit={value => patch('frequencyPenalty', value)}
                  />
                  <NumberField
                    label={t('presencePenalty')}
                    value={settings.presencePenalty}
                    bounds={{ min: -2, max: 2, step: 0.01 }}
                    fallback={0}
                    onCommit={value => patch('presencePenalty', value)}
                  />
                  {/*
                    The window and the effort a reasoning model spends. Behind
                    the disclosure because a preset usually set them: they are
                    shown so a switch's effect can be read and corrected, not
                    because they are tuned every day.
                  */}
                  <NumberField
                    label={t('contextWindow')}
                    value={settings.contextWindow}
                    /*
                      4 000 000, which is `MAX_CONTEXT_WINDOW` — the ceiling the
                      settings store, the probe and the wire schema all check.
                      It was 2 000 000, which is upstream's `unlocked_max`
                      verbatim, and that made the unlock switch below argue
                      against a bound this control was still imposing: the
                      reason not to borrow upstream's 2M is that it would cap a
                      future 4M model at a 2026 constant, and the slider was
                      capping it anyway.
                    */
                    bounds={{ min: 512, max: MAX_CONTEXT_WINDOW, step: 512 }}
                    fallback={32_768}
                    decimals={0}
                    note={t('contextWindowNote')}
                    onCommit={value => patch('contextWindow', value)}
                  />
                  {/*
                    Beside the window and not elsewhere, because it is the other
                    half of one decision: the number above is capped at what the
                    model is known to accept until this is on. Upstream's
                    `max_context_unlocked` — where it lives beside the same
                    slider, for the same reason.
                  */}
                  <ToggleField
                    label={t('contextUnlocked')}
                    note={t('contextUnlockedNote')}
                    value={settings.contextUnlocked === true}
                    onToggle={next => patch('contextUnlocked', next)}
                  />
                  <ChoiceField
                    label={t('reasoningEffort')}
                    value={settings.reasoningEffort ?? 'auto'}
                    options={[
                      // Upstream's own value words (`reasoning_effort_types`);
                      // they name provider request fields and stay as written.
                      { id: 'auto', label: 'auto' },
                      { id: 'min', label: 'min' },
                      { id: 'low', label: 'low' },
                      { id: 'medium', label: 'medium' },
                      { id: 'high', label: 'high' },
                      { id: 'max', label: 'max' },
                    ]}
                    onSelect={id => patch('reasoningEffort', id === 'auto' ? null : id)}
                  />
                  <p className="iris-field__note">{t('reasoningEffortNote')}</p>
                  <NumberField
                    label={t('seed')}
                    value={settings.seed}
                    bounds={{ min: 0, max: 1000000, step: 1 }}
                    fallback={0}
                    decimals={0}
                    note={t('seedNote')}
                    onCommit={value => patch('seed', value)}
                  />
                  <TextField
                    label={t('stopAt')}
                    value={(settings.stop ?? []).join(' | ')}
                    placeholder={t('stopPlaceholder')}
                    onCommit={value =>
                      patch(
                        'stop',
                        value
                          .split('|')
                          .map(row => row.trim())
                          .filter(row => row !== ''),
                      )
                    }
                  />
                </>
              ) : null}
            </CollapsibleSection>

            {/*
              The reply shapers — what happens to the text around the model's
              words. Each one backs a stored setting with a real consumer: the
              trim runs before a reply is stored, the separator rides the
              continue request and the painted floor, and the squash changes the
              messages a provider is sent.
            */}
            <CollapsibleSection id="replies" title={t('sectionReplies')} summary={repliesSummary}>
              <ToggleField
                label={t('trimSentences')}
                note={t('trimSentencesNote')}
                value={settings.trimSentences === true}
                onToggle={next => patch('trimSentences', next)}
              />
              <ChoiceField<ContinuePostfix>
                label={t('continuePostfix')}
                value={settings.continuePostfix ?? 'space'}
                options={[
                  { id: 'none', label: t('postfixNone') },
                  { id: 'space', label: t('postfixSpace') },
                  { id: 'newline', label: t('postfixNewline') },
                  { id: 'double', label: t('postfixDouble') },
                ]}
                onSelect={id => patch('continuePostfix', id)}
              />
              <p className="iris-field__note">{t('continuePostfixNote')}</p>
              <ToggleField
                label={t('squashSystemMessages')}
                note={t('squashSystemMessagesNote')}
                value={settings.squashSystemMessages === true}
                onToggle={next => patch('squashSystemMessages', next)}
              />
              {/*
                The one switch on this card whose **absence means on**, so the
                value reads `!== false` rather than `=== true`. Spelled out here
                rather than folded into a helper: the asymmetry is the fact a
                reader of this line needs, and a helper would hide it.
              */}
              <ToggleField
                label={t('cacheFriendly')}
                note={t('cacheFriendlyNote')}
                value={settings.cacheFriendly !== false}
                onToggle={next => patch('cacheFriendly', next)}
              />
            </CollapsibleSection>
          </>
        )}

        {/*
          The appearance card, before the reading card: how the page is painted
          (themes, user.css, the theme package) is the louder half of
          "screen on the outside", and the theme choice lives here now — drawn
          as swatches — rather than as a menu in the reading card.
        */}
        <AppearanceCard />

        <CollapsibleSection
          id="reading"
          title={t('sectionReading')}
          summary={`${control.reading.size}px`}
        >
          <NumberField
            label={t('proseSize')}
            value={control.reading.size}
            bounds={READING_LIMITS.size}
            fallback={17}
            decimals={0}
            onCommit={value => {
              if (value !== null) control.setReading({ ...control.reading, size: value })
            }}
          />
          {/*
            **No 行宽 control here any more, and its absence is the honest
            reading of the 「梅花」 layout.**

            It was a 48-96ch slider over `--iris-measure`, which capped the prose
            column. canvas.json removes that cap — 正文、卡的界面、输入框三者同宽
            … 不留死槽 — so the slider went on writing a token that no longer
            bounded anything a reader could see. A control that moves nothing is
            worse than one that is absent: it teaches the reader that the panel
            lies.

            **What was deliberately kept**, because the token still has one real
            consumer: `ReadingPrefs.measure`, `READING_LIMITS.measure`,
            `DEFAULT_READING.measure`, `applyReading`'s `--iris-measure` write
            and `settings-transfer`'s clamp all stand. The chain
            `--iris-measure` → `--iris-column-max` → `--sheldWidth` is upstream
            compatibility (a card's inline HTML may read SillyTavern's chat-column
            width), so the value must keep existing and keep round-tripping
            through an exported settings file — it just is not a knob any more.

            To put a reader-visible measure back, the question to answer first is
            which surface it caps, because capping the prose alone re-opens the
            dead channel the artboards were drawn to close.
          */}
          {/*
            The floor numbers (upstream's `mesIDDisplay_enabled`, which the
            measured profile turned on): marginalia in the row's margin, shown
            by a document attribute rather than per-row props.
          */}
          <ToggleField
            label={t('showFloorNumbers')}
            note={t('showFloorNumbersNote')}
            value={control.reading.floors}
            onToggle={next => control.setReading({ ...control.reading, floors: next })}
          />
          {/*
            The interface language. Lives beside the theme because it is the same
            kind of thing — a per-device choice about the shell's own surface
            (notes/SETTINGS-IA.md 意图 #4, 界面本地) — and takes effect on the spot,
            like the theme does.
          */}
          <ChoiceField
            label={t('sectionLanguage')}
            value={lang}
            options={[
              // Each option is shown in its own language, always: a reader who
              // has switched to a language they cannot yet read has to be able
              // to find their way back by shape.
              { id: 'en', label: t('langEn') },
              { id: 'zh', label: t('langZh') },
            ]}
            onSelect={(id: Language) => setLang(id)}
          />
        </CollapsibleSection>

        <ScriptPanel />

        {/*
          The user's own scripts, after the card's. They run in the same frame,
          under the same per-card consent and the same remote-code allowlist —
          `ScriptPanel` above is where all three of those are governed, for
          every script in the conversation regardless of which repository it
          came out of, which is why the switchboard is there and this panel is
          only the library.
        */}
        <ScriptLibraryPanel />

        {/*
          The world books panel, beside the script panel because it answers the
          same kind of question from the other side: what shapes the model's
          view of this scene. Its data is installation-wide rather than per
          chat, which is why it sits outside the `settings === undefined`
          branch — like the host reports below, it is meaningful with no
          conversation open at all.
        */}
        <WorldbookPanel />

        {/*
          The persona panel, beside the world books because both are
          profile-wide inputs to every prompt: who the user is, and what the
          world knows. Outside the `settings === undefined` branch for the same
          reason the world books are — a persona is meaningful with no
          conversation open at all.
        */}
        <PersonaPanel />

        {/*
          The backups panel, beside the persona panel because both are
          profile-wide surfaces that work with no conversation open: who the
          user is, and the copies the host has taken of their conversations.
          A snapshot names the chat it protects and the operation it was taken
          in front of, so the card is where "can I undo this" is answered.
        */}
        <BackupPanel />

        {/*
          The usage page's entry, beside the backups card because both are
          profile-wide readings that work with no conversation open: what the
          host has copied, and what the host has spent. It is the third usage
          surface and the only one that can answer *across* conversations — the
          composer's line is one chat, and a reply's reading is one turn.

          `onNavigate` is the drawer's own close: a subtotal row opens a
          conversation, and leaving the settings panel standing over the chat
          the reader just asked for would hide it.
        */}
        <UsageSection onNavigate={onClose} />

        {/*
          The host's own reports, **outside** the `settings === undefined`
          branch above and after the card panel.

          Outside, because a failed settings load makes these *more* worth
          reading, not less — a drawer that hides its diagnostics exactly when
          something is wrong is the shape this whole view exists to end. After
          the card panel, because it answers a different question: `ScriptPanel`
          is about the card in front of you and is empty in a chat with no
          scripts, while the host trims variables and materialises books
          regardless of whether any card is running.
        */}
        <HostReports />

        {/*
          The notice history, beside the host's reports because they answer the
          same question from two sides: what did this session say, and is it
          still sayable. The bar itself is gone in three seconds.
        */}
        <NoticeLog />

        {/*
          The B10 seam's demo provider and its switch — not a dev probe (it is
          meant to be observable in a production build, which is exactly what
          the seam's acceptance asks for), and not a feature: it contributes
          one floor action through `iris.message.actions` and takes it back on
          uninstall, leaving nothing behind.
        */}
        <DemoActionsSection />

        {/*
          The general card: startup, the settings file in and out, and the
          credential statement — the parts of the drawer that are not about the
          conversation at all, which is why they sit last and work with no chat
          open.
        */}
        <AboutCard control={control} />

        {/*
          Dev only, and written so the branch is statically dead in a production
          build: `import.meta.env.DEV` is replaced with `false`, so the whole
          harness — and the runner it pulls in — drops out of the bundle.
        */}
        {import.meta.env.DEV ? <SandboxProbe /> : null}
        {import.meta.env.DEV ? <RailPreview /> : null}

        <Slot name="iris.settings.sections" owner={{}} />
      </div>
    </aside>
  )
}
