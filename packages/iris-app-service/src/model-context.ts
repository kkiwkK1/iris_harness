/**
 * How long a model's context is, and what that does to the window a chat
 * assembles under.
 *
 * Three questions live here, in the order the host asks them.
 *
 * **1. Did the provider say?** A `/models` probe often carries the number, and
 * a number the endpoint itself reported beats anything baked in. The field is
 * spelled differently by every serve, so {@link CONTEXT_LENGTH_FIELDS} is one
 * ranked list of paths, each annotated with the provider whose documentation
 * uses it and the date that page was read.
 *
 * **2. If not, does the table know?** {@link MODEL_CONTEXT_TABLE} is a
 * model-id → window list, first match wins, every row carrying its source. It
 * is deliberately small and deliberately incomplete: a model this table has
 * never heard of returns `undefined`, and `undefined` means *no clamp*. The
 * alternative — SillyTavern's own `return max_128k; // Safe default for most
 * modern models` (`public/scripts/openai.js:4996-4997`) — would silently cut a 1M
 * window down to 128k for every model added after this file was written, which
 * is the failure mode a made-up number always has.
 *
 * **3. What window does the chat actually get?** {@link resolveWindow}. The
 * user's (or their preset's) `contextWindow` is clamped to the model's known
 * window, because a preset tuned for one model assembled against another
 * silently trims a different part of the conversation. `contextUnlocked`
 * (upstream's `max_context_unlocked`) turns the clamp off.
 *
 * **`provider` is not a key here, and cannot be.** The brief for this module
 * asked for provider + model. But this host's `GenerationSettings.provider` is
 * the *cordis route name* a request generates through — `'default'` on the
 * measured install — not a vendor. `PROVIDER_PRESETS` in `@iris/protocol` does
 * name vendors, but it names the ones a *connection form* offers, and a chat's
 * settings carry no link to the profile that was active when they were written.
 * So the model id is the whole key, which is also what upstream's own tables
 * match on inside a source branch.
 *
 * @module @iris/app-service/model-context
 */

import type { GenerationSettings, ModelContextLength, ContextWindowSource } from '@iris/protocol'

/**
 * One place a `/models` row is documented to carry a context length.
 *
 * Ranked by how well the number describes *what the endpoint will actually
 * accept*: a served window beats a model ceiling, because a ceiling read as a
 * budget produces requests the serve refuses.
 */
export interface ContextLengthField {
  /** Property path from the model row down to the number. */
  path: readonly string[]
  /** Whose documentation spells it this way. */
  provider: string
  /** Where that was read, and when. */
  source: string
}

/**
 * The field paths this host reads off a `/models` row, in priority order.
 *
 * Every entry was confirmed against a documentation page or the serve's own
 * pinned source on **2026-09-08**; nothing here is a guess. Three names that
 * circulate in the wild are deliberately **absent**, and their absence is the
 * point of writing them down:
 *
 * - `context_window`, `max_input_tokens`, `max_tokens` — no provider surveyed
 *   documents any of these on a `/models` row. Probing them would mean reading
 *   an unrelated number (`max_tokens` in particular is an *output* cap on every
 *   endpoint that has it) and reporting it as a context length.
 * - `loaded_context_length` — appears only in third-party issue threads, never
 *   on an LM Studio documentation page.
 *
 * Two documented sources are also missing because **this host's probe never
 * requests the endpoint they live on**, not because they were rejected:
 * LM Studio's `GET /api/v1/models` → `models[].loaded_instances[].config
 * .context_length` (the most accurate LM Studio reading, and the only one that
 * describes the loaded window rather than the model's ceiling), and Ollama's
 * `POST /api/show` → `model_info["<general.architecture>.context_length"]`.
 * Both would need a second request per model, which is a probe of a different
 * shape than the one `connection.test` runs.
 */
export const CONTEXT_LENGTH_FIELDS: readonly ContextLengthField[] = [
  {
    path: ['max_model_len'],
    provider: 'vLLM',
    source: 'vllm/entrypoints/serve/engine/protocol.py, ModelCard.max_model_len (pinned source on main; absent from the prose docs). Read 2026-09-08. Null on LoRA-adapter rows, which is why the reader below skips non-numbers rather than treating one as zero.',
  },
  {
    path: ['context_length'],
    provider: 'OpenRouter',
    source: 'https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties — `data[].context_length`, "Maximum context length in tokens", integer | null. Read 2026-09-08. Also what SillyTavern reads for OpenRouter (openai.js:5584).',
  },
  {
    path: ['top_provider', 'context_length'],
    provider: 'OpenRouter',
    source: 'Same page: `data[].top_provider.context_length`, "Context length from the top provider". Read 2026-09-08. Second, because it describes one route rather than the model.',
  },
  {
    path: ['max_context_length'],
    provider: 'LM Studio',
    source: 'https://lmstudio.ai/docs/developer/rest/endpoints — `data[].max_context_length` on `/api/v0/models`. Read 2026-09-08. This is the model’s ceiling, not the loaded window, so it can overstate what the serve will accept.',
  },
  {
    path: ['meta', 'n_ctx_train'],
    provider: 'llama.cpp',
    source: 'https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md — `/v1/models` → `data[].meta.n_ctx_train`. Read 2026-09-08. Train-time context; the served window is `/props` → `default_generation_settings.n_ctx`, and the two differ by 128x on a server started with `-c 1024`.',
  },
]

/** One row of the built-in table. */
export interface ModelContextRow {
  /** Matched against the model id, lowercased. */
  match: RegExp
  tokens: number
  /** Where the number came from, and when it was read. */
  source: string
}

/**
 * Model id → context window, first match wins.
 *
 * Two kinds of source, both named per row.
 *
 * **Vendor documentation**, where the vendor publishes a number and its
 * `/models` does not carry one. DeepSeek is the whole of this case today, and
 * it is the case that started this module: `GET https://api.deepseek.com/models`
 * documents exactly three fields per row — `id`, `object`, `owned_by` — so no
 * probe can ever learn a DeepSeek window.
 *
 * **SillyTavern 1.18.0's own tables**, transcribed with their line numbers and
 * *in upstream's order*, because the order is load-bearing: upstream tests
 * `/gpt-3\.5-turbo-1106/` before `/gpt-3/`, and swapping them changes the answer
 * for one real model id. Transcribed rather than re-derived so that a
 * disagreement with upstream is a diff in this file rather than a difference in
 * behaviour nobody can locate.
 *
 * **What is not transcribed**: upstream's fallbacks. `getMaxContextOpenAI`
 * ends `return max_128k` and the DeepSeek branch is a flat `max_1mil` for the
 * whole source; a fallback row here would answer for every model id ever typed,
 * which is the one thing this table must not do. The DeepSeek family row below
 * is a scoped version of upstream's flat answer — it fires for `deepseek-*`
 * only — and there is no row that fires for everything.
 *
 * **Updating it**: change the number, change the source line beside it, and add
 * the date it was read. A row whose source line does not say where and when is
 * a row nobody can check.
 */
export const MODEL_CONTEXT_TABLE: readonly ModelContextRow[] = [
  // ------------------------------------------------------------ DeepSeek
  {
    // `deepseek-v4-flash-vision-exp` is covered by the `flash` prefix, and the
    // pricing table gives it the same 1M.
    match: /^deepseek-v4-(flash|pro)/,
    tokens: 1_000_000,
    source: 'https://api-docs.deepseek.com/quick_start/pricing/ — CONTEXT LENGTH 1M for deepseek-v4-flash, deepseek-v4-pro and deepseek-v4-flash-vision-exp (MAX OUTPUT 384K). Read 2026-09-08. The page writes "1M" and gives no exact integer, so this is 1 000 000 rather than 1 048 576 — the same reading SillyTavern takes (`max_1mil = 1000 * 1000`, openai.js:135).',
  },
  {
    // Every other `deepseek-*` id, including the `deepseek-chat` /
    // `deepseek-reasoner` names that are no longer on the pricing page at all.
    match: /^deepseek-/,
    tokens: 1_000_000,
    source: 'SillyTavern 1.18.0 openai.js:5756 — the DeepSeek source branch is a flat `max_1mil` for every model id, with no per-model table. Read 2026-09-08. Used here because deepseek-chat / deepseek-reasoner have left DeepSeek’s own pricing page, so upstream’s answer is the only documented one left.',
  },
  // ------- OpenAI: openai.js:4972-4988's contextMap (rows at 4973-4987), verbatim and in order
  { match: /^gpt-5\.[45]/, tokens: 1_000_000, source: 'SillyTavern 1.18.0 openai.js:4973 (max_1mil). Read 2026-09-08.' },
  { match: /^gpt-5/, tokens: 400_000, source: 'SillyTavern 1.18.0 openai.js:4974 (max_400k). Read 2026-09-08.' },
  { match: /gpt-4\.1/, tokens: 1_000_000, source: 'SillyTavern 1.18.0 openai.js:4975 (max_1mil). Read 2026-09-08.' },
  { match: /gpt-audio/, tokens: 128_000, source: 'SillyTavern 1.18.0 openai.js:4976 (max_128k). Read 2026-09-08.' },
  { match: /^o1/, tokens: 128_000, source: 'SillyTavern 1.18.0 openai.js:4977 (max_128k). Read 2026-09-08.' },
  { match: /^o[34]/, tokens: 200_000, source: 'SillyTavern 1.18.0 openai.js:4978 (max_200k). Read 2026-09-08.' },
  {
    match: /chatgpt-4o-latest|gpt-4-turbo|gpt-4o|gpt-4-1106|gpt-4-0125|gpt-4-vision/,
    tokens: 128_000,
    source: 'SillyTavern 1.18.0 openai.js:4979 (max_128k). Read 2026-09-08.',
  },
  { match: /gpt-3\.5-turbo-1106/, tokens: 16_383, source: 'SillyTavern 1.18.0 openai.js:4980 (max_16k). Read 2026-09-08.' },
  { match: /^(gpt-4|gpt-4-0314|gpt-4-0613)$/, tokens: 8_191, source: 'SillyTavern 1.18.0 openai.js:4981 (max_8k). Read 2026-09-08.' },
  {
    match: /^(gpt-4-32k|gpt-4-32k-0314|gpt-4-32k-0613)$/,
    tokens: 32_767,
    source: 'SillyTavern 1.18.0 openai.js:4982 (max_32k). Read 2026-09-08.',
  },
  { match: /gpt-realtime/, tokens: 32_767, source: 'SillyTavern 1.18.0 openai.js:4983 (max_32k). Read 2026-09-08.' },
  {
    match: /^(gpt-3\.5-turbo-16k|gpt-3\.5-turbo-16k-0613)$/,
    tokens: 16_383,
    source: 'SillyTavern 1.18.0 openai.js:4984 (max_16k). Read 2026-09-08.',
  },
  { match: /^code-davinci-002$/, tokens: 8_191, source: 'SillyTavern 1.18.0 openai.js:4985 (max_8k). Read 2026-09-08.' },
  {
    match: /^(text-curie-001|text-babbage-001|text-ada-001)$/,
    tokens: 2_047,
    source: 'SillyTavern 1.18.0 openai.js:4986 (max_2k). Read 2026-09-08.',
  },
  { match: /gpt-3/, tokens: 4_095, source: 'SillyTavern 1.18.0 openai.js:4987 (max_4k). Read 2026-09-08.' },
  // ------------------------- Claude: openai.js:5604-5616's inline if/else
  {
    match: /^claude-(sonnet-4-5|sonnet-4-6|opus-4-6|opus-4-7)/,
    tokens: 1_000_000,
    source: 'SillyTavern 1.18.0 openai.js:5607-5608 (max_1mil). Read 2026-09-08.',
  },
  {
    match: /^claude-(3|opus|haiku|sonnet)/,
    tokens: 200_000,
    source: 'SillyTavern 1.18.0 openai.js:5609-5610 (max_200k). Read 2026-09-08.',
  },
]

/**
 * Read a context length off one `/models` row.
 *
 * Walks {@link CONTEXT_LENGTH_FIELDS} in order and takes the first path that
 * lands on a positive, finite number. A path that lands on `null`, a string, or
 * a zero is **skipped rather than accepted**: vLLM emits `max_model_len: null`
 * on its LoRA-adapter rows and OpenRouter documents both its fields as
 * `integer | null`, so a reader that treated a present-but-null field as an
 * answer would report a window of zero for real rows from real serves.
 * @param row - one element of the `/models` list, unvalidated.
 * @returns the tokens the endpoint reported, or `undefined` when it reported none.
 */
export function modelContextFromRow(row: unknown): number | undefined {
  for (const field of CONTEXT_LENGTH_FIELDS) {
    let cursor: unknown = row
    for (const key of field.path) {
      if (typeof cursor !== 'object' || cursor === null) {
        cursor = undefined
        break
      }
      cursor = (cursor as Record<string, unknown>)[key]
    }
    if (typeof cursor === 'number' && Number.isFinite(cursor) && cursor > 0) return Math.floor(cursor)
  }
  return undefined
}

/**
 * Look one model id up in the built-in table.
 *
 * **Case-folded, which upstream is not.** Upstream's regexes run against the
 * exact string a `<select>` put in its settings, so case never varies there. A
 * window typed into this host's settings file by hand, or a profile carrying an
 * id copied out of a vendor's docs, does vary — and `DeepSeek-V4-Flash`
 * answering `undefined` while `deepseek-v4-flash` answers 1M would be a clamp
 * that switches off depending on how the id was capitalised.
 * @param model - the model id.
 * @returns the window and the row's source, or `undefined` when the table has never heard of it.
 */
export function modelContextFromTable(model: string): { tokens: number, row: ModelContextRow } | undefined {
  const id = model.trim().toLowerCase()
  if (id.length === 0) return undefined
  for (const row of MODEL_CONTEXT_TABLE) {
    if (row.match.test(id)) return { tokens: row.tokens, row }
  }
  return undefined
}

/** The window one chat assembles under, and where the figure came from. */
export interface ResolvedWindow {
  /** Tokens. What every budget divides by. */
  context: number
  source: ContextWindowSource
  /** The model the window was judged against, when the settings named one. */
  model?: string
  /** The model's own known window, when anything knew one. */
  modelContext?: number
}

/**
 * Resolve the context window for one chat's settings.
 *
 * The rule, and where each half of it comes from:
 *
 * **The stored value wins over the host default.** Unchanged — this is what
 * `windowOf` has always done, and what upstream's preset semantics require: a
 * preset carries `openai_max_context` and a preset tuned for one window
 * assembled against another trims a different part of the conversation.
 *
 * **A known model window clamps it down.** New, and the mechanism is
 * upstream's: every *named* source branch of `onModelChange`
 * (`openai.js:5346`) ends in `oai_settings.openai_max_context = Math.min(<the
 * model's max>, oai_settings.openai_max_context)`.
 *
 * But **the route this host has is upstream's CUSTOM source, and that branch
 * clamps to nothing** — `openai.js:5704-5710` sets the bound to `unlocked_max`
 * (2 000 000) unconditionally, consulting no model table and not even reading
 * `max_context_unlocked`. Measured on the reported install, whose SillyTavern
 * is configured exactly that way (`chat_completion_source: 'custom'`,
 * `custom_url: https://api.deepseek.com`), upstream would have allowed the same
 * 2 000 000. So this clamp is a deliberate improvement borrowed from
 * upstream's named branches, not parity with what upstream does here — and
 * {@link GenerationSettings.contextUnlocked} is what hands upstream's own
 * answer for this route back. `DEVIATIONS.md` §44 has the measurement.
 *
 * Where this host differs from the named branches is *when*: upstream clamps at
 * settings time and **writes the smaller number back into the setting**, so a
 * user's 2 000 000 is destroyed the moment they change model; this clamps on
 * every read and leaves the stored value alone, so switching back to a 1M model
 * restores what they asked for.
 *
 * **`contextUnlocked` turns the clamp off.** Upstream's `max_context_unlocked`
 * (openai.js:308), which does not remove its bound either — it raises it to
 * `unlocked_max = 2 000 000` and still runs the `Math.min`. Here it removes the
 * clamp outright, because this host has no 2M ceiling of its own to raise to
 * and inventing one would cap a future 4M model at upstream's 2026 number.
 *
 * **An unknown model changes nothing.** `modelContext` absent means the value
 * in force stands exactly as it did before this function existed.
 * @param settings - the chat's merged settings.
 * @param fallback - the host composition's window.
 * @param modelContext - what anything knows about this model's window, if anything does.
 * @returns the window and its provenance.
 */
export function resolveWindow(
  settings: GenerationSettings,
  fallback: number,
  modelContext?: ModelContextLength,
): ResolvedWindow {
  const model = settings.model.trim()
  const named = model.length === 0 ? {} : { model }
  const known = modelContext === undefined ? {} : { modelContext: modelContext.tokens }
  const stored = settings.contextWindow
  if (stored === undefined) return { context: fallback, source: 'host', ...named, ...known }
  if (modelContext === undefined || stored <= modelContext.tokens) {
    return { context: stored, source: 'settings', ...named, ...known }
  }
  if (settings.contextUnlocked === true) {
    return { context: stored, source: 'unlocked', ...named, ...known }
  }
  return { context: modelContext.tokens, source: 'model', ...named, ...known }
}
