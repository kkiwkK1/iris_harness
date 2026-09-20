import { useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import { ChoiceField, NumberField, ToggleField } from './fields.tsx'
import { READING_LIMITS } from '../theme/theme.ts'
import type { ReadingControl } from './SettingsDrawer.tsx'
import { getQuoteScope, setQuoteScope, subscribeQuoteScope } from './quote-scope.ts'
import type { QuoteScope } from './quoted-dialogue.ts'
import { useLanguage, t } from './i18n/use-language.ts'
import type { Language } from './i18n/strings.ts'

export function ReadingPanel({ control }: { control: ReadingControl }): ReactElement {
 const { lang, setLang } = useLanguage()
 const quoteScope = useSyncExternalStore(subscribeQuoteScope, getQuoteScope, getQuoteScope)
 return (<section className="iris-section">
          <h3 className="iris-label iris-section__head">{t('sectionReading')}</h3>
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
            `--iris-measure` → `--iris-column-max` → `--sheldWidth` broke at its
            first link on 2026-09-21, when the column cap became a fixed length
            (`tokens.css`) — the middle is bounded again, but by a ruling value
            and not by this slider, which would otherwise resize every card
            interface on the page. The measure still round-trips through an
            exported settings file; it just has no reader today.

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
            Which quotation marks take the theme's quote colour. The default is
            speech only, which is a documented divergence from SillyTavern's six
            (notes/apps/iris-web/DEVIATIONS.md §122): 「…」 and 『…』 mostly mark
            terms and emphasis in Chinese prose, so colouring them paints the
            page instead of the dialogue. The second option is the way back to
            upstream's set, and it takes effect on the spot — every message on
            screen re-marks itself.
          */}
          <ChoiceField
            label={t('quoteScope')}
            value={quoteScope}
            options={[
              { id: 'dialogue' as QuoteScope, label: t('quoteScopeDialogue') },
              { id: 'upstream' as QuoteScope, label: t('quoteScopeUpstream') },
            ]}
            onSelect={(id: QuoteScope) => setQuoteScope(id)}
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

 </section>)
}
