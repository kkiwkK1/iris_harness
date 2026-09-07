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

**Iris has not chosen its licence yet.** There is no `LICENSE` file in this
repository, and nothing below should be read as one. The constraints the choice
has to satisfy — which upstream code was transcribed, under what terms, and
where two of those terms cannot both be met — are worked through in
`notes/LICENSE-INVENTORY.md`. Until a decision is recorded there and a `LICENSE`
file exists, the status is: **licence pending**.

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
modelled on — and out of which one file was transcribed.

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
  - **Algorithm transcription (1):** `apps/iris-web/src/app/token-format.ts` —
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
  - **Elsewhere in Iris:** the application framework and host harness as
    **published packages** — see npm dependencies below, same copyright line.
- **Version read** — **0.1.3-alpha.1**, commit `d347e70`. That is the working
  copy the transcription was made from; the checkout in this repository at
  `.reference/deepseek-harness` is **0.1.2-alpha.2**, commit `0a53fb5`, and the
  transcribed file is **byte-identical between the two** (`diff -q`), so either
  reads as the source.

---

## npm dependencies

Taken from `pnpm licenses list --json` against the current lockfile:
**54 packages across 4 licences** — 46 production, 8 development.
The `.reference/` checkouts (MagVarUpdate, deepseek-harness) are reference
material, not dependencies, and are not counted here.

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
