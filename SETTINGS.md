# Settings, reorganised by intent

SillyTavern's most common complaint is that its settings are overwhelming.
`ROADMAP.md` lists "设置项铺天盖地" first among the things Iris will not copy.
This file is the measurement behind that decision, and the information
architecture it produces.

The finding that matters is sharper than "too many settings": some of them are
**used at a negative rate** — the user changes them and they silently do
nothing. That is the same product claim d7's charter makes about card failures,
one layer up. A card that breaks should say so; a setting that cannot apply
should say so too.

## The trap: `default/content/settings.json` is not the defaults

Read this before measuring anything about settings. The obvious baseline is the
shipped default profile, and it is wrong.

| | leaves |
|---|---|
| `default/content/settings.json` | **347** |
| a profile that has been saved once | **865** |

SillyTavern persists its **in-memory** defaults on first save, so a saved
profile carries hundreds of keys the shipped file never had. Diffing against the
file reports roughly **233 "user-created" settings that the user never touched**.

The real defaults are object literals in source:

- `public/scripts/openai.js` → `const default_settings = {` (103 keys)
- `public/scripts/power-user.js` → `export const power_user = {` (133 keys)

Both reference constants (`max_4k`, `tokenizers.BEST_MATCH`, and a
`getComputedStyle` call). `scripts/settings-usage-census.mjs` extracts them by
brace-matching and evaluates them with every free identifier resolving to a
sentinel; anything that resolves to a sentinel is reported as **unadjudicable**
— never as changed, never as unchanged.

## Scope of the measurement

Stated because a negative conclusion carries its search scope (`METHODS.md`,
sixth lesson).

**Excluded, and why.** `textgenerationwebui_settings`, `nai_settings`,
`kai_settings`, `horde_settings`: this profile's `main_api` is `openai`, so every
difference in them is a persisted default rather than a user act — and there is
no source baseline for them here. `extension_settings`: per-extension state, not
the settings UI. Session state (`active_character`, `tag_map`, `background`, …):
not settings at all.

**n = 1.** One heavy user's profile. The ratio below is that user's magnitude,
not a distribution. The two findings under
[What the data decides on its own](#what-the-data-decides-on-its-own) do **not**
depend on n — they follow structurally from `main_api`.

## (a) Measured: how much of the surface is used

| | |
|---|---|
| baseline leaves (core) | **383** |
| **changed from a known default** | **41** |
| present live, absent from the baseline | 11 |
| default is a source constant — unadjudicable | 54 |
| **deliberately-changed share of the adjudicable surface** | **12.5%** |

Grouped by the question the user was asking:

| count | intent | examples |
|---|---|---|
| 12 | behaviour / automation | `auto_connect`, `forbid_external_media`, `reasoning.prefix`/`suffix`/`separator`, `experimental_macro_engine` |
| 9 | world info | `world_info_budget` 25 → 100, `include_names`, `match_whole_words`, recursion depth |
| 9 | appearance / reading | theme, `allow_name1/2_display`, `mesIDDisplay_enabled`, `message_token_count_enabled` |
| 6 | formatting templates | `instruct.system_sequence`, three `*_suffix`, `skip_examples`, `always_force_name2` |
| 6 | connection / model | preset, `stream_openai`, `openai_max_tokens` 300 → 30000, `custom_url`, model name |
| 4 | other | `main_api`, `custom_model`, `media_inlining` |
| 3 | persona | username, persona description |
| 3 | prompt assembly | `prompts` (41 entries), `prompt_order`, `squash_system_messages` |
| **0** | **sampling / randomness** | — |

## What the data decides on its own

Two entries need no product judgment. Both follow from this profile's
`main_api`, so neither rests on n = 1.

### The formatting panel is used at a negative rate

`main_api: openai`, `chat_completion_source: custom` — the Chat Completion path.
SillyTavern's own documentation, on the panel in question:

> Most of the settings in this panel do not apply to Chat Completions APIs as
> they are governed by the prompt manager system instead.
> — [Advanced Formatting](https://docs.sillytavern.app/usage/core-concepts/advancedformatting/)

The profile nevertheless stores **36 leaves** of it (instruct 24, context 9,
sysprompt 3), and the user **deliberately changed 6**. All six are inert, and the
five `instruct.*` ones are inert twice over: `instruct.enabled` is `false`.

It also stores **90 leaves** of `textgenerationwebui_settings`, for an API this
profile never uses.

**Decision: on a Chat Completion connection, the text-completion formatting
settings are not shown at all.** Not collapsed — absent. A control that cannot
affect the output must not be offered, and if it must exist, it says why it is
inactive.

### Sampling is used at a rate of zero

Every sampler in the profile is at its factory value: `temp` 1.0, `top_p` 1.0,
`top_k` 0, `min_p` 0, `top_a` 0, frequency and presence penalties 0,
`repetition_penalty` 1, `seed` −1. So is every sampler in the preset the user
actually runs (`梦境思客V1-0425`). What that preset *does* change is
`openai_max_context` (2 000 000), `openai_max_tokens` (30 000) and 41 prompts.

A user who built a 41-prompt stack and unlocked context to two million tokens has
never once adjusted randomness — and the sampler block is the most prominent
section of the panel.

**Decision: sampling is collapsed by default, behind one control that says the
preset governs it.** Expanding it is one click; occupying the top of the panel is
not free.

## (b) The community side — four statements, not a statistic

**This is weak evidence and is labelled as such.** SillyTavern's issue tracker is
not a source for it: `label:"UI/UX"` returns no results, and keyword searches
surface specific refactor proposals rather than any clustering of "settings are
confusing". The complaints live in Discord and Reddit, which were not enumerable
here. What follows is four citable statements. **It is not a topic distribution
and must not be counted as one.**

1. **Upstream documents the overlap itself** — the Advanced Formatting quote
   above, and its companion pointing Chat Completion users to
   [Prompt Manager](https://docs.sillytavern.app/usage/prompts/prompt-manager/)
   instead.
2. **Beginners report density without explanation** — menus everywhere, dozens
   of options, "what does this slider do", nothing phrased for a non-expert.
   ([SillyTavern for Beginners](https://www.lemon8-app.com/@wudis04/7518333865404989965?region=us))
3. **Preset types are not interchangeable, and fail silently** — sampler values
   copied from a Text Completion preset into a Chat Completion preset do nothing,
   because the field names differ (`temp` vs `temperature`).
   ([Template and sampler settings, 2026](https://note.com/aipartner_lab/n/nb511ec21dcd4?hl=en))
4. **Hot-swapping a preset keeps the old prompt** — switch without starting a new
   chat and the length and person settings do not change.
   ([Sphiratrioth presets](https://huggingface.co/sphiratrioth666/SillyTavern-Presets-Sphiratrioth))

All four share one shape: **a setting was changed and silently did not take
effect** — wrong panel, mismatched field name, or overridden elsewhere. That is
the same shape as the measurement in (a), reached independently.

## The ten entries

**This table is the first draft of Iris's settings information architecture.**
Ordered by measured change volume plus the failure modes above. The last column
is what a user has to visit today to answer the question once.

| # | "I want to change…" | Grounds | Scattered across today |
|---|---|---|---|
| 1 | **which model I'm talking to** | 6 changes; everyone's first act | API panel + preset + `custom_url`/`custom_model` |
| 2 | **how much it remembers** | `max_context_unlocked`, `openai_max_tokens` 300→30000, preset's `openai_max_context` 2 M, `chat_truncation`, world-info budget | **4 panels — see below** |
| 3 | **when world info fires** | 9 changes, joint most | world-info panel + `power_user.wi_*` |
| 4 | **what's on screen** | 9 changes | a dozen places in User Settings |
| 5 | **how the prompt is assembled** | 3 changes but the heaviest (41 prompts + order) | Prompt Manager, overlapping #6 |
| 6 | **how thinking blocks are handled** | 3 changes (`reasoning.prefix`/`suffix`/`separator`) | buried in User Settings |
| 7 | **what happens automatically** | most of the 12 behaviour changes | three separate collapsibles |
| 8 | **who I am** | 3 changes | its own panel, overlapping characters |
| 9 | **how random replies are** | **0 changes** → collapsed by default | currently the most prominent block |
| 10 | **text-completion formatting** | **6 changes, all inert** → hidden on Chat Completion | three panels (context / instruct / sysprompt) |

### #2 is the intent most in need of merging

"How much does it remember" is one question, and answering it today means
visiting four panels — two of which (`openai_max_context` in settings and in the
active preset) **overwrite each other** depending on load order. Merging this one
intent removes more confusion than any other entry in the table.

## Not done

- **No real community topic distribution.** GitHub is not the source; Discord and
  Reddit could not be enumerated. Making this rigorous means exporting Discord or
  sampling the Reddit API — a different order of work, and the conclusions above
  do not rest on it.
- **One profile.** See the scope note; the two decisions above do not depend on it.
- **The census reads ST's source structure and is therefore brittle.** See the
  header of `scripts/settings-usage-census.mjs`.

## Implementation-level IA

This document stops at what was measured and what the measurements decide. The
screen-by-screen information architecture built on top of it lives in
`SETTINGS-IA.md`, so that a change to the layout does not edit the evidence and
a re-measurement does not edit the layout.
