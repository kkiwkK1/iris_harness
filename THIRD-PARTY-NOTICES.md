# Third-Party Notices

Iris builds on other people's work. This file lists what, under which licence,
and exactly how each one is used — because "how" is what decides the obligation,
and a notice that does not say it is not much of a notice.

**Every version below is the copy that was actually read**, not the newest
release. Line references elsewhere in this repository are against these versions
and drift when upstream moves.

**A line marked "to verify" is a fact the shipped files do not state.** It is
not a gap in this survey: where an upstream project ships a licence whose own
instructions ask for a copyright line and that line was never filled in, the
honest record is to say so and attribute by the identifiers the project does
publish — its name, its repository URL and its author handle. See the last
section.

## Iris itself

**Iris is licensed under the GNU Affero General Public License v3.0**
(`AGPL-3.0-only` — the unmodified FSF text ships as `LICENSE`). The ruling and
its reasoning are recorded in `notes/LICENSE-INVENTORY.md`; in short: the
repository carries a verbatim port and algorithm transcriptions from
SillyTavern and ST-Prompt-Template, both AGPL-3.0, whose §5(c) obligation
attaches to the work as a whole — AGPL-3.0 is the licence that obligation
demands, and the one this project would have chosen for its own reasons
(network copyleft for a host that is meant to be served). Source for any
network-served copy is the repository itself:
`https://github.com/kkiwkK1/iris_harness`.

Copyright line for the work: `Copyright (C) 2026 kkiwkK1 and Iris contributors`.

---

## SillyTavern

- **Project** — SillyTavern · `https://github.com/SillyTavern/SillyTavern.git`
  (`package.json` `repository`)
- **Licence** — `AGPL-3.0` (`package.json` `"license": "AGPL-3.0"`; `LICENSE`
  carries the full GNU AGPLv3 text, 661 lines)
- **Copyright line** — **to verify.** The shipped `LICENSE` is the unmodified
  AGPLv3 text: its only copyright line is the licence document's own
  (`Copyright (C) 2007 Free Software Foundation, Inc. <https://fsf.org/>`,
  line 4), and line 633 is still the blank template
  `Copyright (C) <year>  <name of author>`. Neither `README.md`, `package.json`
  nor `public/index.html` states a project copyright holder.
- **What Iris uses** —
  - **Verbatim port (1):** `packages/iris-app-service/src/reply-trim.ts` —
    `trimToEndSentence` and its punctuation set (`public/scripts/utils.js:883`,
    `:887`).
  - **Algorithm transcription (7):** `packages/iris-lorebook/src/activate.ts`
    (`checkWorldInfo`); `packages/iris-lorebook/src/matching.ts`
    (`WorldInfoBuffer.matchKeys`); `packages/iris-lorebook/src/parse.ts:422/:476/:536`
    (`convertAgnaiMemoryBook` / `convertRisuLorebook` / `convertNovelLorebook`,
    `world-info.js:5358/:5403/:5448`); `packages/iris-app-service/src/prompt.ts:256`
    (`getSortedEntries`, `world-info.js:4478`);
    `apps/iris-web/src/app/WorldbookPanel.tsx:15` (the entry-list sort
    predicates); `packages/iris-app-service/src/library.ts:341`
    (`unsetPrivateFields`, `characters.js:498` — which fields an export clears);
    `packages/iris-compat-tavernhelper/src/slash.ts:59`
    (`SlashCommandParser`'s escape counting).
  - **Interface compatibility:** the chat-completion preset format, the chat
    JSONL shape, the world-info entry fields, the settings keys — reproduced so
    that a SillyTavern install's files open here unchanged.
- **Version read** — **1.18.0** (`package.json`), release `51ad27fb`

---

## TavernHelper (JS-Slash-Runner)

- **Project** — 酒馆助手 / JS-Slash-Runner ·
  `https://github.com/N0VI028/JS-Slash-Runner` (`manifest.json` `homePage`);
  author `KAKAA` (`manifest.json`)
- **Licence** — **Aladdin Free Public License, Version 9** — no SPDX identifier
  exists for it. Declared in `README.md` §许可证 (`- [Aladdin](LICENSE)`);
  neither `package.json` nor `manifest.json` carries a `license` field.
- **Copyright line** — **to verify.** The shipped `LICENSE` is a generic AFPL
  text whose §0 was never adapted to this project: it still says the Program is
  `"AFPL Ghostscript"` and names Artifex Software Inc. and artofcode LLC as the
  copyright holders, and its own notice reads
  `Copyright (C) 1994, 1995, 1997, 1998, 1999, 2000 Aladdin Enterprises, Menlo Park, California, U.S.A.`
  — none of which is a copyright statement *for this work*.
- **What Iris uses** —
  - **Interface compatibility (the bulk of it, and the intended relationship):**
    `apps/iris-web/src/sandbox/upstream-surface.ts` (the 171 member names
    upstream's type definitions declare), `identity.ts` (the 31 Iris implements
    and which script each answers for), `preset-globals.ts` (which globals the
    script frame is seeded with, and in what order),
    `packages/iris-script/src/types.ts:58` (the script-button shape
    `{enabled, buttons:[{name, visible}]}`), and `sandbox/frame.ts` (the
    `predefine.js` getter behaviour and `waitGlobalInitialized`'s semantics).
    **Names and behaviour, not implementation** — a card written for TavernHelper
    has to find the same names doing the same things, and that is the floor this
    project is built to.
  - **Algorithm transcription (1):**
    `packages/iris-compat-tavernhelper/src/macros.ts` — the macro output format
    from `src/function/macro_like.ts`. **Flagged, not decided:** a clean-room
    re-derivation has been proposed so that this line can be withdrawn; until
    that is done and recorded, the transcription stands as listed.
  - **Rules copied (1, small):** `apps/iris-web/src/sandbox/script-source.ts:4`
    — two script-source rules.
- **Version read** — **4.9.1** (`manifest.json` and `package.json` agree)

---

## MagVarUpdate (MVU)

- **Project** — MagVarUpdate ·
  `https://github.com/MagicalAstrogy/MagVarUpdate`
- **Licence** — **MIT** (`LICENSE` carries the MIT text; `README.md:20` states
  it; `package.json` has no `license` field)
- **Copyright line** — verbatim from `LICENSE`:

  > `Copyright (c) 2025 MagicalAstrogy & StageDog.`

- **What Iris uses** —
  - **Algorithm transcription (1):** `packages/iris-mvu/src/schema.ts:62` — the
    schema walk, copied deliberately including the behaviour that looks like a
    bug (a missing key stops the walk; it does not fall back to an extensible
    parent's `template`).
  - **Interface compatibility:** the `Mvu` member surface, the event names, the
    variable-cleanup parameters and the `ignore_cleanup` key at upstream's own
    position (`chat[1].variables[0].ignore_cleanup`).
- **Version read** — **v0.182.0** (`git describe --tags`, commit `6a11e2f`;
  newest CHANGELOG entry 2026-08-14. `package.json` says `1.0.0`, which is a
  placeholder.)

---

## ST-Prompt-Template

- **Project** — Prompt Template / 提示词模板 ·
  `https://github.com/zonde306/ST-Prompt-Template` (`manifest.json` `homePage`);
  author `zonde306`
- **Licence** — `AGPL-3.0` (`LICENSE` carries the full GNU AGPLv3 text)
- **Copyright line** — **to verify.** As with SillyTavern, the shipped `LICENSE`
  is the unmodified AGPLv3 text and line 633 is still the blank template
  `Copyright (C) <year>  <name of author>`; no project copyright statement
  appears in `LICENSE`, `README.md` or `README_CN.md`.
- **What Iris uses** —
  - **Algorithm transcription (2):**
    `packages/iris-compat-prompt-template/src/environment.ts:312`
    (`prepareContext`) and `:427` (`precacheVariables`, where the order is
    load-bearing).
  - **Interface compatibility:** the EJS template dialect the extension gives
    cards, and its `extension_settings.EjsTemplate` settings key.
  - **Not attributed here:** the nested-delimiter patch in
    `packages/iris-compat-prompt-template/src/upstream.ts:251` was transcribed
    from this project's `src/3rdparty/ejs.js`, which is a **vendored copy of
    EJS** — the rights holder for that code is EJS's, so it is recorded in the
    EJS section below.
- **Version read** — **1.17.4.1** (`manifest.json`)

---

## EJS

Listed separately because Iris meets EJS twice: once as a dependency, and once
through a patch transcribed out of a copy of it that a *different* project
vendored.

- **Project** — EJS (Embedded JavaScript templates) ·
  `https://github.com/mde/ejs`
- **Licence** — `Apache-2.0` (`package.json` `"license"`; `LICENSE` carries the
  Apache-2.0 text)
- **Copyright line** — **to verify.** The shipped `LICENSE` is the Apache-2.0
  boilerplate with no filled copyright line and there is no `NOTICE` file;
  the attributable holder is the `package.json` author,
  `Matthew Eernisse <mde@fleegix.org>`.
- **What Iris uses** —
  - **Dependency:** `ejs@3.1.9`, served to the prompt-template compatibility
    layer.
  - **Near-verbatim (1):** `packages/iris-compat-prompt-template/src/upstream.ts:251`
    — the nested-delimiter patch to `Template.prototype.generateSource`,
    structure preserved including a redundant final guard. **Transcribed from
    `ST-Prompt-Template`'s `src/3rdparty/ejs.js` at that project's v1.17.4.1**,
    i.e. from a vendored and locally patched copy of EJS rather than from EJS's
    own release.
- **Version read** — `ejs@3.1.9` as the dependency; the transcribed copy was
  read at **ST-Prompt-Template 1.17.4.1**
- **To verify** — that vendored file **cannot be checked on this machine**: the
  installed ST-Prompt-Template ships only `dist/`, `libs/`, `include/`, `docs/`
  and `locales/`, with no `src/`. The citation comes from the transcriber's
  reading of the GitHub checkout, so **which of the two copyright holders that
  particular code belongs to has not been verified here** — the patch may be
  EJS's code, ST-Prompt-Template's modification of it, or a mix.

---

## deepseek-harness

Iris meets this project twice, and the two are separate obligations. As
**dependencies** its published `@deepseek-ai/dsh-*` packages are listed under
npm dependencies below. This section is about the **source checkout**, which is
reference material here — the harness is the interface Iris's own shell is
modelled on — and out of which five files were transcribed.

- **Project** — deepseek-harness ·
  `https://github.com/deepseek-ai/deepseek-harness`
  (`packages/client/ui-chat/package.json` `repository.url`)
- **Licence** — `MIT` (root `package.json` `"license": "MIT"`, and the same
  field on the transcribed package; `LICENSE` carries the MIT text)
- **Copyright line** — verbatim from `LICENSE`:

  > `Copyright (c) 2026 DeepSeek`

- **Full licence text** — the MIT text is **not reproduced in this file**; it is
  in the checkout at `.reference/deepseek-harness/LICENSE`. That path is
  `.gitignore`d (`.gitignore:9`), so a clone of this repository does not carry
  it — **the text has to travel with any distribution of the transcribed code**,
  and that is a condition this file records rather than satisfies. See
  `notes/LICENSE-INVENTORY.md`.
- **What Iris uses** —
  - **Algorithm transcription (1 of 5):** `apps/iris-web/src/app/token-format.ts` —
    `formatTokens`, `formatExactTokens` and `formatCacheHitPercent` (including
    its helpers `roundedPercentUnits` and `displayPercentUnits`), from
    `packages/client/ui-chat/src/client/chat/token-format.ts`. Structure and
    arithmetic preserved, including the property the file exists for: a partial
    cache hit is never rounded up to `100%`. Changed in the transcription: the
    locale seat is Iris's `i18n/strings.ts` rather than a slot-passed `t`, the
    counts are clamped to non-negative integers on the way in, and the
    `TurnUsage` readers that live beside them
    (`billedInputTokens`, `totalTokens`, `cacheHitPercent`,
    `usageLineGroups`, `usageDetailText`) are Iris's own.
  - **Interface compatibility / design reference (not code):** the usage line's
    grouping and the per-turn breakdown's rows, from the same package's
    `StatsLine.tsx` and `TurnUsagePanel.tsx`; the copy from its `locale.ts`,
    re-keyed into Iris's dictionary. Iris renders both with its own markup and
    its own tokens, and uses a native `title` where the harness uses its
    `Tooltip` primitive and an anchored dialog.

    The same vocabulary is reused, deliberately, by Iris's profile-wide **usage
    page** (`apps/iris-web/src/app/UsagePanel.tsx`), so a reader who has met the
    per-turn dialog reads the same words at the larger scale: the disjoint
    prompt-side split (uncached input / cache hit / cache write), output with
    reasoning named as a share of it rather than a bucket beside it, and a
    cache-hit share that is absent rather than zero where no provider reported
    one. The harness has **no usage chart and no cross-conversation summary** —
    its figures are per session, off a live projection — so the page itself, its
    `usage.summary` host aggregation, and the SVG line chart with its
    token-based series palette and geometry
    (`apps/iris-web/src/app/usage-stats.ts`) are Iris's own, with nothing
    transcribed.

  - **Algorithm transcription (4), added with the context meter and history
    compaction:**
    - `apps/iris-web/src/app/context-occupancy.ts` — `contextOccupancy`'s shape
      (one bounded reading, `null` until both numerator and capacity are known)
      from `packages/client/ui-conversation/src/client/context-occupancy.ts`,
      and `meterSegments`' rule from
      `packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx`:
      the bar's overall length stays the exact occupancy while the breakdown
      only proportions its coloured parts, and a zero-width part is dropped
      rather than drawn at the hairline minimum. **Changed in the
      transcription:** the harness's three buckets (system prompt, tools,
      conversation) become six assembly sources read off the ids the host
      mints, and the denominator is `context - reserve` rather than the whole
      window, because Iris's assembler holds a reply reserve the harness's
      formula has no term for.
    - `apps/iris-web/src/app/ContextMeter.tsx` — the same file's panel: the
      click-open breakdown, its headline/bar/legend order, and its dismissal on
      outside pointerdown or Escape with one document listener each while open.
      **Changed:** a capsule instead of the progress ring (the composer's row is
      already a strip of capsules), and the panel is CSS-positioned against the
      composer rather than portaled, because the box it hangs off already has
      `position: relative` and no `overflow`.
    - `apps/iris-web/src/app/CompactionNote.tsx` — the collapsed marker row and
      its summary disclosure, from
      `packages/client/ui-chat/src/client/chat/CompactionItem.tsx`, including the
      property its opening comment names: a compaction marker does not replace
      the rows it describes. **Changed:** it sits at the head of the column
      rather than at the boundary it names, because Iris's reading surface mounts
      a tail and a marker at that boundary would not render at all.
    - `packages/iris-app-service/src/compaction.ts` and
      `compaction-prompt.ts` — from
      `packages/compaction/compaction-basic/src/{config,region,summarizer}.ts`
      and `packages/compaction/command-compact/src/index.ts`: the two ratios
      (`thresholdRatio` `0.8`, `retainRatio` `0.16`) and the validation that
      retention must stay under the threshold; `selectCompactableRange`'s
      accumulate-from-the-newest-end selection and its head anchoring; the
      shrink guard that refuses a replacement no smaller than what it replaces;
      `frameSummary`'s checkpoint framing and tags; the summarization call's
      shape (the conversation's own system prompt, the span replayed, the
      instruction as the **final user message**, for prefix-cache reuse); the
      structure of `COMPACTION_INSTRUCTION` including "write every section,
      `(none)` included" and the merge-a-prior-checkpoint rule; the
      `agent/pre-step` trigger's order (measure, threshold, select, summarize,
      commit, log and continue the turn on failure); and `/compact`'s
      retention-zero manual case with its three outcomes. **Changed:** the
      section headings are a scene's rather than a coding session's; the
      threshold is scaled against `context - reserve`; the harness's
      tool-pairing boundary walk is dropped because a roleplay log has no
      tool-call/result pair to split; and the durable record is a top-level chat
      header key (`iris_compaction`) instead of the harness's own append-only
      session log, because the record has to survive being written to a
      SillyTavern chat file and read back.
  - **Elsewhere in Iris:** the application framework and host harness as
    **published packages** — see npm dependencies below, same copyright line.
- **Version read** — **0.1.3-alpha.1**, commit `d347e70`. That is the working
  copy the transcription was made from; the checkout in this repository at
  `.reference/deepseek-harness` is **0.1.2-alpha.2**, commit `0a53fb5`, and the
  transcribed file is **byte-identical between the two** (`diff -q`), so either
  reads as the source.

---

## jQuery (ST-compat pilot vendor)

- **Project** — jQuery · `https://jquery.com` (the copy read: the file the reference
  SillyTavern install ships at `public/lib/jquery-3.5.1.min.js`)
- **Version** — 3.5.1 (stated in the file's own banner comment)
- **Licence** — MIT (the copyright and licence statement the file itself carries)
- **How used** — copied verbatim into `apps/iris-web/public/st-ext/vendor/jquery.min.js`
  and served into the ST-compat pilot's extension frame as the global `$`,
  which the unmodified ST-Prompt-Template bundle requires for its self-start
  and its DOM work. Not bundled, not modified, not reachable from card frames.

## lodash (ST-compat pilot vendor)

- **Project** — lodash · `https://lodash.com` (the copy read: the file the
  reference SillyTavern install carries in its dependencies,
  `node_modules/lodash/lodash.min.js`)
- **Version** — the version the minified banner in the shipped file states
- **Licence** — MIT (per the banner the file itself carries)
- **How used** — copied verbatim into `apps/iris-web/public/st-ext/vendor/lodash.min.js`
  and served into the ST-compat pilot's extension frame as the global `_`,
  which the upstream code assumes present. Same fences as jQuery above.

## npm dependencies

Taken from `pnpm licenses list --json` against the current lockfile:
**54 packages across 4 licences** — 46 production, 8 development.
The `.reference/` checkouts (MagVarUpdate, deepseek-harness) are reference
material, not dependencies, and are not counted here.

> **Re-read 2026-09-17 (`main` `96b1a8e`):** the totals above are unchanged —
> `pnpm licenses list` still reports **54 packages across 4 licences**, MIT 47 /
> Apache-2.0 4 / ISC 2 / Python-2.0 1, name for name, and the 23
> `@deepseek-ai/*` are still 23. The one figure that moved is the
> production/development split: today `pnpm licenses list --prod` reports
> **47 production, 7 development** (this line said 46 / 8), and the one package
> that changed sides is **`typescript`** — `packages/iris-compat-st-extension`
> declares it in `dependencies`, not `devDependencies`, because
> `src/analyze.ts:34` imports the compiler API at runtime. Composition is
> otherwise unchanged apart from `ejs@3.1.9 → 3.1.10`; the diff against the
> lockfile of 2026-09-10 is that one line, and the four `package.json` commits
> since (`2079dbe1`, `2eccf30f`, `963744a`, `dd1cc24d`) moved workspace links and
> declaration positions and no third-party name. Details in
> `notes/LICENSE-INVENTORY.md` §六.
> **This section covers the pnpm workspace only** — the second dependency tree
> below was never in it.

| Licence | Packages |
| --- | --- |
| MIT | 47 |
| Apache-2.0 | 4 |
| ISC | 2 |
| Python-2.0 | 1 |

**Used as dependencies only** — no code from any of them is copied into this
repository.

### `@deepseek-ai/*` — 23 packages, all MIT

The application framework (Cordis) and the host harness. Two copyright lines
cover the whole family, both verbatim from the packages' own `LICENSE` files:

> `Copyright (c) 2021-present Shigma`

— `@deepseek-ai/cordis@4.0.2`, `cosmokit@1.8.2`/`1.8.3`,
`schemastery@3.18.1`/`3.18.2`, and the plugins `cordis-plugin-group@1.0.2`,
`cordis-plugin-hmr@1.0.17`, `cordis-plugin-include@1.0.7`,
`cordis-plugin-loader@1.0.3`, `cordis-plugin-logger-console@1.0.2`,
`cordis-plugin-timer@1.1.4`.

> `Copyright (c) 2026 DeepSeek`

— the `dsh-*` family, all `0.1.1-rc.2`: `dsh-app-boot`, `dsh-attachment`,
`dsh-brand`, `dsh-home-paths`, `dsh-host-frontend-static`, `dsh-host-webserver`,
`dsh-invariants`, `dsh-launch-environment`, `dsh-llm`, `dsh-scope`,
`dsh-session`, `dsh-system-prompt`, `dsh-timeout`, `dsh-typert-protocol`.

*(The pnpm store also holds `dsh-client-modules`, `dsh-client-ui-primitives`,
`dsh-client-ui-slots` and `dsh-client-web` at the same version and under the same
copyright; they are in the store but not in the set `pnpm licenses list`
reports for this lockfile. Listed here for completeness — **to verify** whether
they are actually reachable at runtime.)*

### Apache-2.0 — 4 packages

| Package | Version | Attributable holder | Notice file present? |
| --- | --- | --- | --- |
| `ejs` | 3.1.9 | `Matthew Eernisse <mde@fleegix.org>` (`package.json` author) | `LICENSE` — the Apache-2.0 boilerplate, **no filled copyright line**. **Iris also transcribed code from a vendored copy of it — see the EJS section above.** |
| `filelist` | 1.0.6 | `Matthew Eernisse <mde@fleegix.org>` | **no licence file in the published package** |
| `jake` | 10.9.4 | `Matthew Eernisse <mde@fleegix.org>` | **no licence file in the published package** |
| `typescript` | 5.9.3 | `Microsoft Corp.` (`package.json` author) | `LICENSE.txt` — Apache-2.0 boilerplate, no filled copyright line |

Apache-2.0 §4 requires retaining the licence, any `NOTICE` file, and attribution
notices. **None of these four ships a `NOTICE` file**, and three of the four
state no copyright line at all — hence the author field as the attributable
holder, marked to verify. Two of them (`filelist`, `jake`) ship **no licence
file in the published package at all**, so the `Apache-2.0` above comes from
their `package.json` `license` field and nothing else.

> **One version in the table above is out of date, and the line is left standing
> on purpose.** `ejs` moved **3.1.9 → 3.1.10** on 2026-09-11 (commit `9d93280`,
> CVE-2024-33883); the licence is unchanged, so every statement on that row —
> Apache-2.0, the author, the absent `NOTICE`, the absent copyright line — still
> holds at 3.1.10. The **EJS section above** also reads `ejs@3.1.9` in two
> places (`What Iris uses` and `Version read`) and is likewise uncorrected here.
> The date on this file is 2026-09-11–16; this note is 2026-09-17. Same
> correction, with the same date, is in `notes/LICENSE-INVENTORY.md` §二, which
> made it when the bump landed.

### ISC — 2 packages

> `Copyright (c) 2011-2023 Isaac Z. Schlueter and Contributors` — `minimatch@5.1.9`

> `Copyright (c) 2021-2024 Oleksii Raspopov, Kostiantyn Denysov, Anton Verinov` — `picocolors@1.1.1`

### Python-2.0 — 1 package

`argparse@2.0.1` — a JavaScript port of Python's `argparse`, distributed under
the **PSF License Agreement** (`"license": "Python-2.0"`; `LICENSE` carries the
full PSF text including the history of the software section). It is a permissive
licence, and it is the only dependency outside the MIT / ISC / BSD / Apache set.
**To verify** — the PSF text's copyright is Python's own
(`Copyright (c) 2001…2010 Python Software Foundation`); the JavaScript port's own
copyright line is not stated in the shipped package.

---

## apps/iris-web npm dependencies (2026-09-17)

**The second dependency tree, and it is not the one above.** `apps/iris-web` is
npm-managed and sits outside the pnpm workspace (its own README says why), so
`pnpm licenses list` cannot see it and neither could any earlier version of this
file. This part of Iris's dependency surface was, until today, recorded
**nowhere**. It is the larger half: **251 third-party package-versions on 248
names**, of which **twelve are `@deepseek-ai/*`** — the published half of
**deepseek-harness**, whose copyright line is quoted in the section above.
`react`, `react-dom`, `vite`, `vue` and `zod` were absent from every list here,
and so was every one of these 251.

**Licences of record.** The expression below is each package's own
`package.json` `license` field, verbatim; 245 of the 251 also ship a licence
file, and the six that do not are named at the end of this section.

**The tree this was read from.** `apps/iris-web/node_modules`, walked by the
script in `notes/tasks/REVIEW-7-LICENSE-INVENTORY-RECONCILE.md` §1. `@iris/*`
entries the walk also visits (five packages, six rows) are **junctions back to
`packages/`** — our own code under `AGPL-3.0-only` in its own `package.json` —
and are excluded from every count here.

**One "to verify" in the section above, answered here.** The
`@deepseek-ai/*` note says the store holds `dsh-client-modules`,
`dsh-client-ui-primitives`, `dsh-client-ui-slots` and `dsh-client-web` and asks
whether they are reachable at runtime. **They are: all four are direct
dependencies of `apps/iris-web` and all four appear in the walk** — this tree is
the reason `pnpm licenses list` never listed them, since it is not the tree they
are installed in. All four are on the direct table below. The workspace's own 23
and this tree's 12 are otherwise disjoint sets of names, so the two
`@deepseek-ai/*` lists do not overlap and each must be read on its own.

| Licence expression | Packages |
| --- | --- |
| `MIT` | 226 |
| `ISC` | 8 |
| `Apache-2.0` | 3 |
| `BSD-2-Clause` | 3 |
| `MIT-0` | 2 |
| `BSD-3-Clause` | 2 |
| `Python-2.0` | 1 |
| `CC0-1.0` | 1 |
| `BlueOak-1.0.0` | 1 |
| `CC-BY-4.0` | 1 |
| `(CC-BY-4.0 AND OFL-1.1 AND MIT)` | 1 |
| `(MPL-2.0 OR Apache-2.0)` | 1 |
| `Dual licensed under the MIT or GPL Version 2 licenses.` | 1 |

Counted as **package-version pairs**, not directory rows: the walk visits 251
third-party directories, and three names appear at two versions each
(`commander` 8.3.0 + 9.5.0, `entities` 7.0.1 + 8.1.0, `lru-cache` 5.1.1 +
11.5.2), so 251 rows are 248 distinct names.

**Every one of the 251 is a dependency in the ordinary sense** — no file from
this tree is transcribed into `src/`, and the one transcription relationship
these packages do carry is the `@deepseek-ai/*` family's, recorded in that
section. (`ejs` is **not** in this tree: the near-verbatim patch attributed to
it belongs to the `ejs` row in the workspace list above, and to the EJS section.)
`react`, `vue`, `lodash-es`, `yaml`, `zod`, `jquery` and `showdown` are supplied
to card frames as **globals** by `src/sandbox/preset-entry.ts`; that is a runtime
dependency and a licence obligation in the usual way, not a copy.

### Direct dependencies (37) — the ones the obligation mostly attaches to

The 29 `dependencies` plus 8 `devDependencies` of
`apps/iris-web/package.json`. Versions are what is installed today.

| Package | Version | Licence | How Iris uses it |
| --- | --- | --- | --- |
| `@deepseek-ai/cordis` | 4.0.2 | MIT | The application framework's `Context` and plugin declaration merging for the browser shell — see the `deepseek-harness` section above for the copyright line. |
| `@deepseek-ai/cordis-plugin-group` | 1.0.2 | MIT | Cordis plugin grouping; same family, same copyright line. |
| `@deepseek-ai/cordis-plugin-include` | 1.0.7 | MIT | Cordis configuration includes; same family. |
| `@deepseek-ai/cordis-plugin-loader` | 1.0.3 | MIT | The loader the browser shell boots through; a peer the `dsh-client-*` packages declare. |
| `@deepseek-ai/dsh-client-modules` | 0.1.1-rc.2 | MIT | The browser module system: its `/client` entry registers the bundle and is imported dynamically in `src/main.tsx`. |
| `@deepseek-ai/dsh-client-ui-primitives` | 0.1.1-rc.2 | MIT | The shell's UI primitives (`Button`, `Menu`, `Modal`, `writeClipboard`) and, through them, `katex`. |
| `@deepseek-ai/dsh-client-ui-slots` | 0.1.1-rc.2 | MIT | The slot model the message-action surfaces are built on. |
| `@deepseek-ai/dsh-client-web` | 0.1.1-rc.2 | MIT | `AppWebEntry` — the boot the browser entry hands the container to. |
| `@deepseek-ai/dsh-invariants` | 0.1.1-rc.2 | MIT | Runtime-invariant registry declared as a peer by the four `dsh-client-*` packages. |
| `@fortawesome/fontawesome-free` | 6.5.2 | `(CC-BY-4.0 AND OFL-1.1 AND MIT)` | The icon sheets inlined into the message-frame bundle; the font files are inlined as data URIs. **待裁** — see below. |
| `@iris/client-fake` | *workspace* | AGPL-3.0-only | Our own package, linked in: the fake client the shell and its tests run against. |
| `@iris/compat-tavernhelper-core` | *workspace* | AGPL-3.0-only | Our own package: the event bus and event names the card frame speaks. |
| `@iris/plugin-web-api` | *workspace* | AGPL-3.0-only | Our own package: the plugin asset manifest parser the shell reads. |
| `@iris/protocol` | *workspace* | AGPL-3.0-only | Our own package: the request/response schemas every panel is typed against. |
| `@iris/text` | *workspace* | AGPL-3.0-only | Our own package: `stringHash` and the bilingual-copy audit shared with the host. |
| `@tailwindcss/browser` | 4.1.12 | MIT | Tailwind, as the message frame gets it; pinned to the copy the ST extension vendors. |
| `dompurify` | 3.4.14 | `(MPL-2.0 OR Apache-2.0)` | HTML sanitising for message bodies. **待裁** — see below. |
| `jquery` | 3.5.1 | MIT | The `$` global in both frame kinds, pinned to what SillyTavern serves. |
| `jquery-ui` | 1.13.2 | MIT | Declared and version-pinned, and deliberately **not** shipped in any frame (see below). |
| `jquery-ui-touch-punch` | 0.2.3 | `Dual licensed under the MIT or GPL Version 2 licenses.` | Same — declared, pinned, not shipped. **待裁** — see below. |
| `lodash-es` | 4.18.1 | MIT | The `_` global in preset frames. |
| `react` | 18.3.1 | MIT | The shell's renderer. |
| `react-dom` | 18.3.1 | MIT | The shell's DOM renderer. |
| `showdown` | 2.1.0 | MIT | Markdown in preset frames, as the `showdown` global. |
| `vue` | 3.5.42 | MIT | The `Vue` global in preset frames. |
| `vue-router` | 4.6.4 | MIT | Companion to `vue` for the frames that route. |
| `yaml` | 2.9.0 | ISC | The `YAML` global in preset frames. |
| `zod` | 4.5.4 | MIT | The `z` global in preset frames. |
| `zustand` | 4.5.7 | MIT | The shell's client-side store. |
| `@types/lodash-es` | 4.17.12 | MIT | Types for `lodash-es` (dev). |
| `@types/node` | 22.20.1 | MIT | Node types for the Vite config and tools (dev). |
| `@types/react` | 18.3.31 | MIT | Types for `react` (dev). |
| `@types/react-dom` | 18.3.7 | MIT | Types for `react-dom` (dev). |
| `@vitejs/plugin-react` | 4.7.0 | MIT | The React transform in `vite.config.ts` (dev). |
| `jsdom` | 29.1.1 | MIT | The DOM the browser-shell tests run in (dev). |
| `typescript` | 5.9.3 | Apache-2.0 | The compiler (dev); the same version as the workspace's, same notice caveat — it ships `LICENSE.txt` and a `ThirdPartyNoticeText.txt`, and nothing named `NOTICE`. |
| `vite` | 6.4.3 | MIT | The bundler for the shell and the four frame bundles (dev). |

**A note on `jquery-ui` and `jquery-ui-touch-punch`, because "declared but not
shipped" is the sort of fact that goes stale.** Both are dependencies with exact
pins and both are **absent from every frame bundle** — measured: no bundle under
`apps/iris-web/public/sandbox/` contains a jQuery UI token, and
`src/sandbox/jquery-plugin-gap.ts` exists precisely to *report* a card that
reaches for `$.fn.draggable` and gets `undefined`, which is what it would get
from a SillyTavern install without the plugin. The pins are asserted by
`tests/message-preset.test.ts` so the versions cannot drift; the absence is a
decision recorded in `message-preset-entry.ts` (316 KB cold-fetched per frame
against zero corpus uses). A reader asking "is this shipped?" should answer it
from the bundles, not from `package.json` — and this file now says so.

### Transitive dependencies (214 distinct) — summarised by family

The remainder, reached only through the 37 above. Notification obligations are
mostly the direct packages' business; these are recorded by family and by the
six that ship no licence file of their own.

**The families below count all 251**, direct and transitive together — the table
at the head of this section is the same 251, split by expression rather than by
reach; a family line naming a package marked "also direct" above is in both.
What is *only* transitive is the 214, and no claim is made here that each of
them needs its own notice.

- **MIT — 226.** The four heaviest sub-trees, by who pulls them in:
  `rollup` and `esbuild` (through `vite`), the `@babel/*` family (through
  `@vitejs/plugin-react`), and `react-dom`'s own dependency chain (through
  `@deepseek-ai/dsh-client-ui-primitives`, and directly).
- **ISC — 8**, including `yaml@2.9.0` (also direct, above).
- **Apache-2.0 — 3**, of which one is also direct: `typescript@5.9.3`, plus
  `baseline-browser-mapping` and `xml-name-validator`. **No package anywhere in
  this tree ships a file named `NOTICE`** (`find . -iname 'NOTICE*'` → 0), so
  Apache-2.0 §4's NOTICE clause has nothing to carry here; each of the three
  does ship an Apache-2.0 `LICENSE.txt`. `typescript` additionally ships
  `ThirdPartyNoticeText.txt`, which is not a `NOTICE` file and is named here so
  a reader who finds it is not left guessing.
- **BSD-3-Clause — 2**: `source-map-js`, `tough-cookie`. **BSD-2-Clause — 3**:
  `entities` (both versions), `webidl-conversions`.
- **MIT-0 — 2**: `@csstools/color-helpers`, `@csstools/css-syntax-patches-for-csstree`.
- **CC0-1.0 — 1**: `mdn-data`. **BlueOak-1.0.0 — 1**: `lru-cache@11.5.2`.
- **Python-2.0 — 1**: `argparse` (also in the workspace tree).
- **CC-BY-4.0 — 1**: `caniuse-lite`, reached as
  `@vitejs/plugin-react → @babel/core → @babel/helper-compilation-targets →
  browserslist → caniuse-lite`. **It is a build-time browser-support database,
  not shipped runtime code**, and its `LICENSE` carries a real attribution line.

### 待裁 — recorded, not judged

Five entries, each with its path, per this file's rule that a licence question
is named here rather than answered here.

| Package | Version | Expression | Path | What is unresolved (fact only) |
| --- | --- | --- | --- | --- |
| `jquery-ui-touch-punch` | 0.2.3 | `Dual licensed under the MIT or GPL Version 2 licenses.` | `apps/iris-web/node_modules/jquery-ui-touch-punch` | Not an SPDX expression; the package ships **no licence file**, only the header comment in `jquery.ui.touch-punch.js` (`Copyright 2011–2014, Dave Furfero`) and the same sentence in `package.json`. The GPL-2.0 arm is the one that would matter. **Not shipped in any frame** (see above) — but it is a declared direct dependency. |
| `dompurify` | 3.4.14 | `(MPL-2.0 OR Apache-2.0)` | `apps/iris-web/node_modules/dompurify` | A disjunction, and both halves ship (`LICENSE` is Apache-2.0, `LICENSE-MPL` is MPL-2.0). MPL-2.0 is file-level copyleft and the choice between the arms is ours to make or record. Used in `src/app/sanitize-html.ts`, i.e. shipped. |
| `@fortawesome/fontawesome-free` | 6.5.2 | `(CC-BY-4.0 AND OFL-1.1 AND MIT)` | `apps/iris-web/node_modules/@fortawesome/fontawesome-free` | Three licences by asset kind — `LICENSE.txt` states icons are CC-BY-4.0, fonts OFL-1.1 (`Copyright (c) 2024 Fonticons, Inc.`, Reserved Font Name "Font Awesome"), code MIT. **CC-BY-4.0 requires attribution and OFL has a reserved-name clause**; the sheets are inlined into the message-frame bundle, so this travels to every frame. |
| `caniuse-lite` | 1.0.30001810 | `CC-BY-4.0` | `apps/iris-web/node_modules/caniuse-lite` | Reached only through `browserslist` under the Vite React plugin, i.e. **not in any shipped artifact**. `LICENSE` carries `Copyright (c) 2014-present Alexis Deveria` and the CC-BY-4.0 reference. |
| `lru-cache` | 11.5.2 | `BlueOak-1.0.0` | `apps/iris-web/node_modules/jsdom/node_modules/lru-cache` | Reached only through `jsdom` (a devDependency) — **not shipped**. `lru-cache@5.1.1` elsewhere in the tree is ISC. |

### Six packages ship no licence file of their own

Each carries a `license` field and nothing readable in the package: the two
platform-specific binaries `@esbuild/win32-x64@0.25.12` and
`@rollup/rollup-win32-x64-gnu@4.63.1` / `-msvc@4.63.1` (MIT, the parent
projects' licence, not restated in the platform package), `@vue/devtools-api@6.6.4`
(MIT), `saxes@6.0.0` (ISC), and `jquery-ui-touch-punch@0.2.3` (the non-SPDX entry
above, whose terms live in a source comment). Recorded rather than resolved,
and it is the same situation the workspace's four Apache-2.0 packages are
already in — two of those (`filelist`, `jake`) ship no licence file at all.
`notes/LICENSE-INVENTORY.md`'s standing rule is that a missing file is a fact
about the package, not a gap in this survey.

**One measurement this section cannot make on its own, and the check that
closes it instead.** The 251 are what the installed tree holds today, while
`apps/iris-web/package-lock.json` is the authority on what a fresh `npm ci`
would produce. Comparing the two — the walk's `name@version` pairs against
every `node_modules/` entry in the lock, the five `link: true` workspace
entries excluded — resolves exactly:

- **In the walk and not the lock: 0.**
- **In the lock and not the walk: 50**, and every one is **os/cpu/optional
gated**: 48 `@esbuild/*` and `@rollup/*` platform binaries, plus
`@napi-rs/lzma-linux-x64-gnu` and `fsevents` — the copies for other operating
systems, which `npm ci` on Windows does not install. **301 lock entries (the
five workspace `link` entries excluded) − 50 OS-gated = 251, exactly the walk's
251 package-version pairs.**

So the tree on disk is the lockfile's, with nothing unaccounted for on either
side. That is the shape the pnpm half cannot have (its lock and disk agree by
construction, and the *file* it is checked against is the stale artifact).
`notes/LICENSE-INVENTORY.md` §六 records the same boundary.

---

## On the lines marked "to verify"

**Four of the projects above did not perform a step their own licence asks for**,
and that is why several copyright lines here are marked rather than quoted:

- **SillyTavern** and **ST-Prompt-Template** ship the unmodified GNU AGPLv3
  text, whose own closing instructions ("How to Apply These Terms to Your New
  Programs") tell an author to attach a copyright line. Line 633 of both files
  is still the blank template `Copyright (C) <year>  <name of author>`, and no
  copyright statement appears in either project's README, `package.json` or
  served HTML.
- **TavernHelper** ships an Aladdin Free Public License whose §0 the licence
  itself requires be rewritten to describe the work and its copyright holder.
  It was not: §0 still names *AFPL Ghostscript* and Artifex Software Inc. /
  artofcode LLC, and the file's only copyright notice is Aladdin Enterprises'
  own.
- **EJS** (and three of the four Apache-2.0 dependencies) ship the Apache-2.0
  boilerplate with no filled copyright line and no `NOTICE` file; two ship no
  licence file in the published package at all.

Where that is the case, this file attributes by the identifiers each project
*does* publish — its name, its repository URL, and its author handle — and says
so. **Nothing here was resolved by guessing a holder**, and none of these
projects was contacted or looked up beyond the copies read on the machine that
produced this file. A reader who needs a filled copyright line should go to the
project.

## What this file does not do

It records **what we used and under which licence**. It does not decide whether
any transcription above constitutes a derivative work, and it is not a licence
choice for this repository — that question is worked through in
`notes/LICENSE-INVENTORY.md`, and the answer depends on judgements this file
deliberately does not make.

The port list is **self-declared**: it comes from the transcription notes the
authors wrote in the source, not from an independent similarity audit. A port
that was never labelled as one would not appear here.
