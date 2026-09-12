/**
 * The protocol methods, implemented over the domain packages.
 *
 * Nothing here re-implements roleplay: turns come from `@iris/turn`, swipes
 * from `@iris/chat`, assembly from `@iris/pipeline`, state from
 * `@iris/variables` and `@iris/mvu`, storage from `@iris/persistence`. What
 * this module owns is the orchestration those packages deliberately leave to a
 * caller — which chat is generating, what a turn's variable baseline is, and
 * when the browser is told.
 *
 * The one rule that shapes all of it: **generation is not a response**.
 * `chat.send` resolves as soon as the turn is open, and the reply arrives as
 * `stream.*` events. A method that resolved with the finished text could not be
 * streamed and could not be interrupted.
 *
 * @module @iris/app-service/service
 */

import { BlockAssembler, createAssistantMessage, createUserMessage, isHarnessError, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { appendCandidate, selectCandidate, selectedCandidate, SwipeError, type Candidate } from '@iris/chat'
import { assemble, DEFAULT_TRIM_BLOCK_FLOORS, type AssembleResult, type Contribution, type HistoryEntry } from '@iris/pipeline'
import { computeBudget, type LorebookEntry } from '@iris/lorebook'
import { evaluateBatch } from '@iris/compat-prompt-template'
import { GLOBAL_ORDER_ID, LEGACY_ORDER_ID, type ChatCompletionPreset, type PromptItem, type PromptOrder } from '@iris/preset'
import type { BackupSummary, CharacterSummary, ChatBudget, ChatSummary, ChatView, ConnectionKeySource, ConnectionProfile, ContinuePostfix, GenerationSettings, HostDefaultConnection, IrisEvent, ModelContextLength, PluginRevisionRequest, PresetManagerView, PresetPromptView, PresetRegexAnswer, PromptItemization, RpcMethod, RpcRequest, RpcResponse, ScriptView, TavernRegexTier, TurnUsage, ScriptContext } from '@iris/protocol'
import { MAX_CONTEXT_WINDOW, providerPreset } from '@iris/protocol'
import { modelContextFromRow, modelContextFromTable, resolveWindow, type ResolvedWindow } from './model-context.ts'
import type { RegexScript } from '@iris/regex'
import { isHelperMacroName, parseSlashCommands } from '@iris/compat-tavernhelper'
// —— family③: preset ——
import {
  DuplicatePresetPromptError,
  fromTavernHelperPreset,
  restoreOmittedExtensions,
  type TavernHelperPreset,
} from '@iris/compat-tavernhelper'
// —— family③ end ——
import { extractScripts } from '@iris/script'
import { defaultRegistry } from '@iris/macro'
import { createCalibratingCounter, type CalibratingCounter } from '@iris/tokenizer'
import { historyFromSession, slotsOf, squashSystemRuns, TurnDriver, type GenerateEvents, type HistoryProjection, type StreamFn } from '@iris/turn'
import { randomUUID } from 'node:crypto'

// —— family③: preset —— `cardFacingPreset` and the frame ceiling ride the same
// import as the store they read.
import { FRAME_PRESET_LIMIT, PresetStore, cardFacingPreset } from './presets.ts'
import type { BackupStore } from './backups.ts'
import {
  ConnectionStore,
  hostConnectionFromEnv,
  hostDefaultView,
  routeOf,
  routeCredential,
  sameEndpointOrigin,
  type HostConnection,
} from './connections.ts'
import type { ChatStore } from './chats.ts'
import {
  applyCompaction,
  compactionSpec,
  frameSummary,
  historyTokens,
  rawCoverage,
  readCompaction,
  selectCompactableSpan,
  SUMMARY_MAX_TOKENS,
  SummaryNotSmallerError,
  writeCompaction,
} from './compaction.ts'
import { COMPACTION_INSTRUCTION } from './compaction-prompt.ts'
import { classifyVolatility, emptyVolatility, markCachePhase } from './cache-friendly.ts'
import type { ChatEntry, ScriptInjection } from './entry.ts'
import { writeTimedEffects, writeVolatility } from './entry.ts'
import { AppError, invalid, notFound } from './errors.ts'
import { FavoriteStore } from './favorites.ts'
import { applyChatOrder, ChatOrderStore } from './chat-order.ts'
import type { WorldbookBindingStore } from './materialise.ts'
import { ScriptButtonStore } from './script-buttons.ts'
import type { SideSource } from './side-usage.ts'
import { cardWorldbookDigest, cardWorldbookView, charWorldbookNames, WorldbookStore } from './worldbooks.ts'
import { activationSettingsOf } from './worldbook-settings.ts'
import type { CharacterLibrary } from './library.ts'
import { assertStorable, buildCardContext, commitChatMetadata, type ExtensionSettingsStore } from './context.ts'
import { forbiddenSegmentIn } from '@iris/variables'
// —— family①: identity & messages ——
import { toCardCharacter } from './context.ts'
import type { ScriptChatMessage } from '@iris/protocol'
import { chatLines, lineSystemFlags, lineTurns } from './entry.ts'
import { attributeResidualMacros, buildPrompt, DEFAULT_PRESET, residualMacros } from './prompt.ts'
import { CardStorageStore, QuotaExceeded, removalNote } from './card-storage.ts'
import { DiagnosticBuffer, type ReportContext } from './diagnostics.ts'
import { CacheTraceStore, traceOf } from './cache-trace.ts'
import { fingerprintLine, fingerprintRequest } from './fingerprint.ts'
import { PersonaStore, type ActivePersona } from './persona.ts'
import { fetchAllowedRemote, nodeFetch, type FetchLike } from './remote-fetch.ts'
import type { PruneOptions } from './prune.ts'
import { MVU_CAPABILITY } from './plugins/capabilities.ts'
import type { MvuExecution } from './plugins/mvu.ts'
import type { SystemPluginLease, SystemPluginRuntime } from './system-plugins.ts'
import { DEFAULT_PRUNE, pruneDue } from './prune.ts'
import { runScripts } from './regex.ts'
// —— family②: regex ——
import { formatAsTavernRegexed, fromTavernRegex, readPresetRegex, tavernRegexId, toTavernRegex } from './regex.ts'
import { evaluatePrompt, promptHasTemplate } from './templates.ts'
import { applyOps, buildSnapshot } from './template.ts'
import type { ScriptPolicyStore } from './scripts.ts'
import { scriptRowOf, type LibraryScope, type ScriptLibraryStore } from './script-library.ts'
import type { ScriptVariableStore } from './script-variables.ts'
import { CONTINUE_POSTFIX_SEPARATORS, type SettingsStore } from './settings.ts'
import { trimToEndSentence } from './reply-trim.ts'
import { textOf } from './views.ts'

/** Provenance stamped on a partial reply the user stopped. */
const INTERRUPTED_SOURCE = { provider: 'iris', model: 'interrupted' } as const

/**
 * The two utility prompts a generation kind can close its request with, in
 * SillyTavern's own words (`openai.js:104-110`, the shipped defaults of
 * `impersonation_prompt` / `continue_nudge_prompt`).
 *
 * These are the **defaults**, not the values. Both fields ride in the preset
 * file (`settingsToUpdate`, `openai.js:357` and `:362`), and a real preset
 * tunes them: measured on the two presets in the local profile, one carries a
 * 457-character impersonation prompt and a 456-character continue nudge, the
 * other a 210-character impersonation prompt. {@link utilityPromptOf} reads
 * them off the active preset and falls back here.
 *
 * `{{lastChatMessage}}` in the nudge is upstream's own substitution slot
 * (`openai.js:902`), filled with the trimmed text being continued.
 */
const IMPERSONATION_PROMPT =
  '[Write your next reply from the point of view of {{user}}, using the chat history so far as a'
  + ' guideline for the writing style of {{user}}. Don\'t write as {{char}} or system. Don\'t'
  + ' describe actions of {{char}}.]'
const CONTINUE_NUDGE_PROMPT = '[Continue your last message without repeating its original content.]'

/**
 * One utility prompt, as the active preset spells it.
 *
 * Upstream's own read is `oai_settings.<field>`, and a preset switch overwrites
 * that field from the file — so the preset's text *is* the value, and the
 * shipped constant is only what an untouched install happens to hold.
 *
 * **An empty string is a value, not an absence.** Upstream guards
 * `impersonation_prompt` explicitly (`openai.js:1362`,
 * `oai_settings.impersonation_prompt ? substituteParams(...) : ''`) — a preset
 * that blanks the field sends no instruction, and falling back to the default
 * there would put words in the request the user deleted on purpose. Both
 * presets in the local profile set `new_chat_prompt` to exactly that, so the
 * distinction is real rather than theoretical.
 * @param preset - the active preset.
 * @param field - the preset field to read.
 * @param fallback - the shipped default, for a preset that omits the key.
 * @returns the prompt text; `''` when the preset deliberately blanks it.
 */
function utilityPromptOf(
  preset: ChatCompletionPreset,
  field: 'impersonation_prompt' | 'continue_nudge_prompt',
  fallback: string,
): string {
  const value = preset[field]
  return typeof value === 'string' ? value : fallback
}

/**
 * The Iris generation kinds in upstream's vocabulary — the words the preset's
 * `injection_trigger` lists are matched against (`PromptManager.js:1537`).
 */
const GENERATION_TYPE_OF = {
  send: 'normal',
  regenerate: 'regenerate',
  continue: 'continue',
  impersonate: 'impersonate',
} as const

/**
 * Name the layer a failed generation failed at.
 *
 * The user's own signal is checked **first**: a stop pressed while a budget
 * happened to be expiring is still a stop, because that is the outcome the
 * person chose and the one their interface is already showing.
 *
 * `TIMEOUT` is the harness's own code rather than one minted here — it is
 * already in `dsh-llm`'s default retryable set — so this reads a taxonomy
 * instead of inventing a parallel one. Anything else is the provider's, which
 * is what `provider-error` has always meant.
 *
 * **`no-provider` is carried through rather than folded in** (host §61). It is
 * raised by this host *before* the request leaves — no provider is in use, so
 * there is nothing to generate through — and calling that a `provider-error`
 * would name a provider as the author of a refusal it never heard about, and
 * send the reader to the endpoint instead of to the connection card. The
 * browser reads the code and prints its own sentence, so the wire has to keep
 * the distinction the sentence turns on.
 * @param signal - the caller's cancellation, aborted only by a real stop.
 * @param error - what the driver raised.
 * @returns the `stream.error` code for this failure.
 */
function failureCode(
  signal: AbortSignal,
  error: unknown,
): 'aborted' | 'timeout' | 'provider-error' | 'no-provider' {
  if (signal.aborted) return 'aborted'
  if (error instanceof AppError && error.code === 'no-provider') return 'no-provider'
  if (isHarnessError(error) && error.code === 'TIMEOUT') return 'timeout'
  return 'provider-error'
}

/**
 * The text a continue writes on from: the reading under the cursor.
 * @param seed - the newest turn's selected candidate, or absent.
 * @returns its visible text.
 */
function seedTextOf(seed: Candidate | undefined): string {
  return (seed?.message.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * The seed text a continue request assembles with, separator included.
 *
 * Upstream appends `continue_postfix` to the text being continued on every
 * OpenAI route (`script.js:4917-4921`), with one guard: text already ending in
 * a space is left alone, so a space separator cannot stack. Absent setting
 * means `'space'`, upstream's default — the model needs *some* boundary
 * between the floor's last word and the word it writes next, and every
 * OpenAI-compatible route upstream gets one.
 * @param seedText - the reading being continued, verbatim.
 * @param postfix - the stored separator word, or absent for the default.
 * @returns the text the request carries and the reply opens with.
 */
function continuedSeedText(seedText: string, postfix: string): string {
  if (postfix.length === 0 || seedText.endsWith(' ')) return seedText
  return seedText + postfix
}

/**
 * Share of the context window world info may spend.
 *
 * SillyTavern's own default. Worth keeping: an unbudgeted book quietly eats the
 * conversation, and the symptom — the model forgetting the last ten messages —
 * looks nothing like its cause.
 */
const WORLD_INFO_BUDGET_SHARE = 0.25

/** Every method, keyed by name. */
export type Handlers = {
  [M in RpcMethod]: (params: RpcRequest<M>) => Promise<RpcResponse<M>>
}

/**
 * The endpoint a connection profile carries, as the runtime adapter needs it.
 *
 * The key rides in the clear **inside the host process only** — it reaches the
 * LLM adapter's request headers and nothing else: no log line, no broadcast,
 * no RPC response.
 */
export interface ConnectionEndpoint {
  baseURL: string
  /** The profile's own key. Wins over any environment-sourced credential. */
  apiKey?: string
  /** The header the key is sent in. Absent means the OpenAI-compatible `Authorization: Bearer`. */
  apiKeyHeader?: string
}

/** How long a `connection.test` probe waits for an endpoint before saying `timeout`. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000

/**
 * A probe's verdict before the caller says which key produced it.
 *
 * The wire shape minus `keySource`, so the field cannot be forgotten: the
 * response type requires it, this one forbids nothing, and the single place
 * that resolved the credential is the single place that fills it in.
 */
type ProbeVerdict = Omit<RpcResponse<'connection.test'>, 'keySource'>

/**
 * Whether `fetch` would accept this string as a request URL.
 *
 * The WHATWG parser is the judge, because it is the one `fetch` consults: a
 * missing scheme, a full-width `：`, a space inside the host all fail here and
 * would otherwise surface as a `TypeError` one millisecond into the probe.
 * Only `http:`/`https:` count — `file:` parses but no endpoint lives there.
 * @param url - the string the probe is about to send to.
 * @returns whether a request can be built from it.
 */
export function isRequestableUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * The `bad-url` verdict for a base URL, or `undefined` when a request can be
 * built from it.
 *
 * Asked twice on purpose: by the handler **before** it resolves a key, because
 * key adoption compares origins and an address with no origin would otherwise
 * be answered `missing-key` — true, but not the fault in front of the person —
 * and by the probe itself, so the probe stays safe to call from anywhere.
 * @param baseURL - the endpoint as typed.
 * @returns the refusal, or `undefined`.
 */
function badUrlVerdict(baseURL: string): ProbeVerdict | undefined {
  const url = `${baseURL.replace(/\/+$/, '')}/models`
  if (isRequestableUrl(url)) return undefined
  return {
    ok: false,
    latencyMs: 0,
    error: {
      code: 'bad-url',
      message: `"${baseURL}" is not an address a request can be sent to — it needs a scheme such as https:// and only plain ASCII in the host`,
    },
  }
}

/**
 * The first character of a header value that a header cannot carry, if any.
 *
 * Fetch's header values are ByteStrings: every code unit must fit in one byte,
 * and control characters other than tab are refused. Leading and trailing
 * whitespace is *trimmed* by the platform, not refused, so a key pasted with a
 * trailing newline reaches the endpoint and is judged there — that case is not
 * this fault. The answer names the position and the code point and nothing of
 * the value around it, so it can be shown beside a credential's field.
 * @param value - the header value as typed.
 * @returns where the first unusable character is, or `undefined` when the value is carriable.
 */
export function headerValueFault(value: string): { index: number, codePoint: number } | undefined {
  const trimmed = value.trim()
  const offset = value.indexOf(trimmed)
  for (let i = 0; i < trimmed.length; i += 1) {
    const codePoint = trimmed.codePointAt(i) ?? 0
    const control = codePoint < 0x20 && codePoint !== 0x09
    if (codePoint > 0xff || control || codePoint === 0x7f) {
      return { index: offset + i, codePoint }
    }
    if (codePoint > 0xffff) i += 1
  }
  return undefined
}

/**
 * The reason a `fetch` threw, in the words that name the network fault.
 *
 * Undici throws `TypeError: fetch failed` and hangs the real error — `ENOTFOUND`,
 * `ECONNREFUSED`, `CERT_HAS_EXPIRED` — on `.cause`; a message that stops at the
 * outer sentence tells the person nothing they can act on. Read inward until a
 * code or a different message appears.
 * @param cause - whatever `fetch` rejected with.
 * @returns a sentence carrying the innermost code and message.
 */
export function fetchFailureReason(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause)
  const inner = (cause as { cause?: unknown }).cause
  const innermost = inner instanceof Error ? fetchFailureReason(inner) : undefined
  const code = (cause as { code?: unknown }).code
  const own = typeof code === 'string' && code.length > 0 && !cause.message.includes(code)
    ? `${code} ${cause.message}`
    : cause.message
  return innermost === undefined || innermost.length === 0 ? own : `${own} (${innermost})`
}

/**
 * Read the model list out of a `/models` response body.
 *
 * The OpenAI-compatible shape is `{ data: [{ id }] }`; Ollama's native list is
 * `{ models: [{ name }] }` and costs nothing to also accept. An empty list is
 * still an answer — an endpoint that served 200 with nothing advertised has
 * said something, and the form should show it.
 *
 * **Each row is now read twice: for its id, and for a context length.** It used
 * to be reduced to a bare string here, which threw away the one thing several
 * real serves put in the row and nothing else in this host can ever learn —
 * vLLM's `max_model_len`, OpenRouter's `context_length`. See
 * `model-context.ts`'s `CONTEXT_LENGTH_FIELDS` for what is read and where each
 * spelling is documented. A row carrying no such field contributes no entry;
 * the ids are unaffected either way.
 * @param body - the parsed JSON body.
 * @returns the ids and whatever windows the rows carried, or undefined when the body carries no list at all.
 */
function modelListOf(body: unknown): {
  ids: string[]
  contexts: Record<string, ModelContextLength>
} | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  for (const [key, field] of [['data', 'id'], ['models', 'name']] as const) {
    const rows = record[key]
    if (!Array.isArray(rows)) continue
    const ids: string[] = []
    const contexts: Record<string, ModelContextLength> = {}
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue
      const value = (row as Record<string, unknown>)[field]
      if (typeof value !== 'string' || value.length === 0) continue
      ids.push(value)
      const tokens = modelContextFromRow(row)
      // Bounded by the same ceiling the settings store allows a window to be
      // set to, so a serve reporting a wild number cannot put one on the wire
      // that `settings.set` would refuse a user for typing.
      if (tokens !== undefined && tokens <= MAX_CONTEXT_WINDOW) {
        contexts[value] = { tokens, source: 'provider' }
      }
    }
    return { ids, contexts }
  }
  return undefined
}

/**
 * Fill in, from the built-in table, the ids the endpoint said nothing about.
 *
 * The endpoint's own answer always wins: it is current, and it describes the
 * serve rather than the model. The table only reaches the ids the endpoint left
 * unannotated — which for DeepSeek is every one of them, since its documented
 * `/models` row carries `id`, `object` and `owned_by` and nothing else.
 * @param ids - the ids the probe reported.
 * @param reported - what the rows themselves carried.
 * @returns one record covering every id anything knows a window for.
 */
function withTableContexts(
  ids: readonly string[],
  reported: Record<string, ModelContextLength>,
): Record<string, ModelContextLength> {
  const merged: Record<string, ModelContextLength> = { ...reported }
  for (const id of ids) {
    if (merged[id] !== undefined) continue
    const found = modelContextFromTable(id)
    if (found !== undefined) merged[id] = { tokens: found.tokens, source: 'table' }
  }
  return merged
}

/** What the service needs that it does not own. */
export interface AppServiceOptions {
  /** Normally `ctx.llm.stream` bound to the registry. */
  stream: StreamFn
  library: CharacterLibrary
  chats: ChatStore
  settings: SettingsStore
  /** The profile's live system-plugin owner. Absent preserves legacy library behavior. */
  plugins?: SystemPluginRuntime
  /**
   * The user's decisions about card scripts.
   *
   * Optional so that a host with no page attached — a test, a headless run —
   * need not carry one. Absent means every script list is empty and no card
   * holds a document grant, which is the safe reading of "not configured".
   */
  scripts?: ScriptPolicyStore
  /**
   * The user's own scripts, global and per character.
   *
   * Optional for `scripts`' reason, but absent reads **more strongly** here: a
   * host with no library refuses every library method rather than answering an
   * empty list. An empty listing under live controls would let someone type a
   * script, press Save, and be told nothing about where it went.
   */
  scriptLibrary?: ScriptLibraryStore
  /**
   * Per-card `extension_settings`.
   *
   * Optional for the same reason as `scripts`: absent means every card sees an
   * empty partition, which is what "not configured" should look like.
   */
  extensionSettings?: ExtensionSettingsStore
  /**
   * Button tables a script rewrote at runtime.
   *
   * Optional like the other stores: absent means every script shows the buttons
   * its card declared, which is the correct first-run state anyway.
   */
  scriptButtons?: ScriptButtonStore
  /**
   * The key–value store cards use as browser storage, shared per profile.
   *
   * Absent means the arms refuse: a host with nowhere to keep it must not let
   * a card believe a write landed.
   */
  cardStorage?: CardStorageStore
  /**
   * The named world books beside the installation.
   *
   * Optional like the other stores. Absent means the installation has no books,
   * which reads as an empty list rather than an error — a fresh profile has no
   * `worlds` directory and that is a normal state, not a misconfiguration.
   */
  worldbooks?: WorldbookStore
  /**
   * The user's saved connections.
   *
   * Optional like the other stores: absent means an empty list, which is what a
   * host with nowhere to keep them should report.
   */
  connections?: ConnectionStore
  /**
   * Re-points a provider route at the endpoint a profile carries, at runtime.
   *
   * Given by the composition, which owns the LLM registry. Absent — a test
   * host with no registry — leaves activation a settings change only, and a
   * profile that needs its own endpoint reports it rather than pretending.
   * The key passes through here once, into the adapter's config; it never
   * reaches a log line or a response.
   */
  installConnection?: (route: string, endpoint: ConnectionEndpoint) => void
  /**
   * The connection this host process was **started** with.
   *
   * Three things read it, and none of them offers it as a route any more (the
   * user's ruling of 2026-09-10; host §61). A probe run from a form with an
   * empty key field falls back to the credential the process already holds —
   * the whole point of the field being allowed to be empty; an installed route
   * borrows that credential at the same origin (§58's ladder); and
   * {@link IrisAppService.importLaunchConnection} copies the endpoint, the
   * model and the key into a **saved provider** once, at first start, so an
   * environment-configured host arrives in the new world with a provider in its
   * list instead of nothing.
   *
   * Given by the composition where it can be; when it is absent this runtime
   * falls back to reading the same environment variables the composition's own
   * `llm-openai-compat` row reads (see {@link hostConnectionFromEnv}), so the
   * feature works on the shipped composition without a second wiring step. An
   * explicit value always wins, which is what makes this an option rather than
   * a hard-coded environment read.
   */
  hostConnection?: HostConnection
  /**
   * Refuse to generate while **no saved provider is in use**.
   *
   * The user's ruling, 2026-09-10, verbatim: 「宿主环境这个功能废弃了，以后都从在
   * Iris 中自己添加供应商来调用模型」. With this on, a generation whose settings
   * would fall through to the environment's own route is refused by name
   * (`no-provider`) at the one funnel every generation passes, so "which
   * provider is this reply coming from" has exactly one answer: the row marked
   * 当前 in the connection card.
   *
   * **Default `false`, and the product turns it on** (`index.ts` passes
   * `true`). Two reasons for the asymmetry rather than one default: a host
   * composed with no `connections` store has no way to *have* a provider in
   * use, so requiring one would leave it unable to generate with no interface
   * to fix it in; and every generation test in this package is composed that
   * way. The flag is ignored — not honoured with a refusal — when no store is
   * configured, for the same reason.
   * @default false
   */
  requireProvider?: boolean
  /**
   * The environment the host-connection fallback reads. Defaults to
   * `process.env`; injected by tests so nothing depends on the real shell.
   */
  env?: Record<string, string | undefined>
  /**
   * How long `connection.test` waits for an endpoint before saying `timeout`.
   * @default 10000
   */
  probeTimeoutMs?: number
  /**
   * The transport `script.fetch` reaches the network through. Defaults to
   * {@link nodeFetch}.
   *
   * Injectable so the whitelist can be tested without a network, and so a
   * deployment can route these through its own proxy — but it is a *transport*
   * and not a fetcher: one request, no redirect following, the body as a
   * stream. The allowlist, the hop limit and the size cap live above it in
   * `fetchAllowedRemote`, the same executor `ScriptCache` fetches through.
   *
   * This option used to be `(url) => Promise<{ ok, status, text, headers }>`
   * defaulting to a bare `fetch(url)`, and that shape *was* the defect: a fetcher
   * that follows redirects itself hands the host a body from wherever the far
   * side pointed, and the handler above checked only the URL it started with.
   */
  fetchRemote?: FetchLike
  /** Pushes one frame to every attached page. */
  broadcast: (event: IrisEvent) => void
  /**
   * The preset every chat is assembled with, before the user picks one.
   *
   * The *starting* preset rather than a permanent one: once a preset is
   * selected or the prompt manager is edited, the active state lives in the
   * settings store and this value stops being read until the next host start.
   */
  preset?: ChatCompletionPreset
  /**
   * The library name of that preset, when it is one from the store.
   *
   * Given by the caller that resolved a stored selection before constructing
   * the service; absent means the preset came from the composition or is the
   * built-in one, and the first manager mutation then decides it is the state
   * worth persisting.
   */
  presetName?: string
  /**
   * The SillyTavern **profile** directory, when one is configured — the same
   * value the plugin's `sillyTavernDir` carries. Read-only, and used only by
   * `preset.import` to enumerate what the install has to offer.
   */
  sillyTavernDir?: string
  /**
   * The profile's preset library.
   *
   * Optional like the other stores: absent means every `preset.*` method that
   * needs the files refuses, which is the honest answer from a host with no
   * folder to keep them in.
   */
  presets?: PresetStore
  /** Name recorded for the user in new chats. */
  userName?: string
  /** Context window in tokens. */
  contextWindow?: number
  /** Tokens held back for the reply. */
  reserveTokens?: number
  /**
   * Fixed per-request cost of the provider's chat template, in tokens.
   *
   * Folded into the calibrated estimate so the correction factor converges on
   * the text model rather than absorbing a constant.
   */
  templateOverhead?: number
  /**
   * Drop the oldest floors in multiples of this many when the budget overflows
   * — `@iris/pipeline`'s `Budget.trimBlockFloors`.
   *
   * Absent takes the assembler's default. `0` restores upstream's per-floor
   * trim, which moves the oldest sent floor on every turn once a chat is full
   * and costs a prefix miss from that floor on every turn from then on.
   */
  trimBlockFloors?: number
  /**
   * Where the `script` scope persists.
   *
   * Optional like the other stores. It is passed here as well as to the
   * `ChatStore` because deleting a character has to drop its partition, and the
   * chat store is not told about deletions.
   */
  scriptVariables?: ScriptVariableStore
  /**
   * Trimming old turns' variable tables, off unless this is present.
   *
   * Presence is the switch, and the default is off for a stronger reason than
   * the template evaluator's: **this deletes user data and nothing restores
   * it.** A feature that removes a conversation's history has to be opted into
   * by a decision, never by a silence.
   */
  pruneVariables?: PruneOptions
  /**
   * EJS prompt templates, off unless this is present.
   *
   * Presence is the switch rather than a boolean, because there is no useful
   * "configured but disabled" state: evaluating a card author's JavaScript is a
   * decision the deployment makes once. Absent means no child is ever forked and
   * `<%` reaches the model as literal text, which is what SillyTavern without the
   * extension installed does.
   */
  templates?: TemplateOptions
  /**
   * The profile's personas — who `{{user}}` is.
   *
   * Optional like the other stores. Absent means no persona is configured,
   * which is the state every existing profile is in and the one the red line
   * protects: the assembler receives no `persona` argument and behaves exactly
   * as it did before the store existed.
   */
  personas?: PersonaStore
  /**
   * The profile's starred characters.
   *
   * Optional like the other stores, with the same presence-is-the-switch rule:
   * absent means `character.favorite` is refused rather than answered from an
   * imaginary list, and no summary ever carries an invented star.
   */
  favorites?: FavoriteStore
  /**
   * The order the reader put their conversations in.
   *
   * Optional on the same presence-is-the-switch rule: absent means
   * `chat.reorder` is refused by name and `chat.list` omits `ordered`
   * altogether — never `ordered: false`, which would be a host with no
   * arrangement store claiming to hold an empty one.
   */
  chatOrder?: ChatOrderStore
  /**
   * Which named book each card's embedded book was materialised into.
   *
   * Read by `character.duplicate` alone: the copy's binding row is copied from
   * its source's, so the duplicate resolves to the same named book — the
   * semantics a shared `extensions.world` name already has upstream, which a
   * binding-table re-materialisation would otherwise turn into a minted copy
   * of the book that drifts apart from the original.
   */
  worldbookBindings?: WorldbookBindingStore
  /**
   * The profile's conversation snapshots, shared with the chat store.
   *
   * Optional like the other stores. Absent, the dangerous operations still
   * run — a test host with no snapshot directory is not thereby broken — but
   * they run unprotected, and the `backup.*` methods refuse by name, which is
   * the honest answer from a host that keeps no copies.
   */
  backups?: BackupStore
  /**
   * Where the bodies of recent requests are kept, for cache attribution.
   *
   * Optional, and absent is the *quiet* reading: nothing is recorded and
   * `prompt.divergence` answers with no comparison rather than refusing, which
   * is the same answer a conversation with one turn gets. A host that keeps no
   * copies of its prompts is a normal host, not a broken one — and this is the
   * one store that holds whole prompts, so absence must be a first-class state
   * rather than an error to be worked around.
   */
  cacheTrace?: CacheTraceStore
  /** Reports a failure the service survived. */
  onError?: (error: Error) => void
  /**
   * Retention for those reports, so a debug page has something to read.
   *
   * Absent means the reports still reach `onError` and are simply not kept —
   * which is the behaviour every caller had before this existed, and the right
   * one for a host nobody is debugging.
   */
  diagnostics?: DiagnosticBuffer
}

/** Host-side tuning for the template evaluator. */
export interface TemplateOptions {
  /** Wall clock for one prompt's whole batch. The evaluator's default when absent. */
  deadlineMs?: number
}

/** The application half of Iris. */
export class IrisAppService {
  // `scripts` stays optional through the defaulting: it is the one option with
  // no safe default value, only a safe absent behaviour — an empty script list
  // and no grants. Inventing a store here would put a policy file somewhere the
  // caller did not choose.
  readonly #options: Required<Omit<AppServiceOptions, 'onError' | 'plugins' | 'scripts' | 'scriptLibrary' | 'extensionSettings' | 'scriptButtons' | 'cardStorage' | 'worldbooks' | 'connections' | 'templates' | 'scriptVariables' | 'pruneVariables' | 'diagnostics' | 'presets' | 'presetName' | 'sillyTavernDir' | 'installConnection' | 'personas' | 'favorites' | 'chatOrder' | 'worldbookBindings' | 'backups' | 'cacheTrace' | 'hostConnection'>>
    & {
      onError: (error: Error) => void
      hostConnection?: HostConnection
      plugins?: SystemPluginRuntime
      scripts?: ScriptPolicyStore
      scriptLibrary?: ScriptLibraryStore
      extensionSettings?: ExtensionSettingsStore
      scriptButtons?: ScriptButtonStore
      cardStorage?: CardStorageStore
      worldbooks?: WorldbookStore
      connections?: ConnectionStore
      templates?: TemplateOptions
      scriptVariables?: ScriptVariableStore
      pruneVariables?: PruneOptions
      diagnostics?: DiagnosticBuffer
      presets?: PresetStore
      presetName?: string
      sillyTavernDir?: string
      installConnection?: (route: string, endpoint: ConnectionEndpoint) => void
      personas?: PersonaStore
      favorites?: FavoriteStore
      chatOrder?: ChatOrderStore
      worldbookBindings?: WorldbookBindingStore
      backups?: BackupStore
      cacheTrace?: CacheTraceStore
    }
  readonly #counter: CalibratingCounter = createCalibratingCounter()
  /** Upstream stamps an incrementing `_trace_id` into the variable cache; one per batch. */
  #traceId = 0
  /**
   * The preset the assembler reads, live.
   *
   * Swapped by `preset.select` and mutated in place by the manager, then
   * persisted through the settings store — the same two layers upstream keeps
   * between preset files and `oai_settings`.
   */
  #activePreset: ChatCompletionPreset
  /** The active preset's library name, when it has one. */
  #activePresetName: string | undefined
  /*
   * `#hostProbe` stood here: what a bare probe of the host's **own** endpoint
   * reported, held for the life of the process because it was an observation
   * rather than a decision of the user's. Its two readers were the 「宿主环境」
   * row's model chips and the composer capsule's fallback list for a host with
   * no profile in use — both retired on 2026-09-10 (host §61, web §79), because
   * the environment is no longer a connection anything generates through. A
   * profile's own list is still recorded, in the user's file, where a decision
   * of theirs belongs.
   */

  /**
   * Context windows endpoints reported to this process's own probes, by model id.
   *
   * Not persisted, because it is an observation rather than a decision.
   * The scope is narrower than a profile's stored `modelContexts`, which is
   * filed as a record of one endpoint's answer; this map is read by the window
   * resolver, which has only a model name to go on, so a persisted entry could
   * outlive the endpoint that justified it and clamp a chat against a serve it
   * never talks to.
   */
  readonly #probedContexts = new Map<string, ModelContextLength>()

  /**
   * The adapter routes **this process** has installed, by route key.
   *
   * The adapter registry is per process and its contents are not readable from
   * here — `installConnection` writes into it and answers nothing. So a route
   * name persisted in `settings.json` is a claim about a registry this process
   * may never have been asked to fill: measured 2026-09-09 on one profile
   * opened by two hosts, where host A had activated a `deepseek` connection
   * (writing `chats[<id>].provider = "deepseek"`) and host B, started from the
   * same data directory and never asked to install anything, answered that
   * chat's first generation with `no adapter registered for provider
   * "deepseek"`.
   *
   * This is the half of the answer that can be known cheaply: every install
   * that went through {@link #installConnectionFor} is recorded here, so
   * {@link #resolveRoute} can tell "already served" from "must be installed
   * first" without asking the registry. It is deliberately **not** persisted —
   * it describes this process's registry, and a persisted copy would make the
   * next process claim installs it never performed, which is the original
   * defect with an extra file behind it.
   */
  readonly #installedRoutes = new Set<string>()

  /**
   * The route and model this host was **launched** with, read once.
   *
   * A snapshot rather than a reader, and the difference is the whole point.
   * `#hostConnection()` used to answer its `provider` and `model` from the
   * **global settings layer**, which is where every global activation writes
   * (`ConnectionStore.patchOf`) — so after one 使用 the panel's 「宿主环境」 row
   * described the activated profile's route while claiming to describe the
   * launch configuration, and a 「使用」 on that row would have re-applied the
   * profile it was offering to leave. Both halves come from places nothing but
   * a restart can move: the composition's own `hostConnection`, else the
   * settings store's constructed defaults ({@link SettingsStore.configuredRoute}
   * / {@link SettingsStore.configuredModel}, which on the shipped composition
   * are `apps/iris/cordis.yml`'s `app` row and therefore `IRIS_MODEL`).
   *
   * Taken in the constructor, before `settings.load()` can have replaced the
   * layer — though it would not matter if it had, because `#defaults` is not
   * the layer.
   */
  readonly #launch: { provider: string, model: string }

  /**
   * @param options - domain stores, the model stream, and the event sink.
   */
  constructor(options: AppServiceOptions) {
    this.#options = {
      stream: options.stream,
      library: options.library,
      chats: options.chats,
      settings: options.settings,
      broadcast: options.broadcast,
      preset: options.preset ?? DEFAULT_PRESET,
      userName: options.userName ?? 'User',
      contextWindow: options.contextWindow ?? 32_768,
      reserveTokens: options.reserveTokens ?? 1024,
      templateOverhead: options.templateOverhead ?? 0,
      trimBlockFloors: options.trimBlockFloors ?? DEFAULT_TRIM_BLOCK_FLOORS,
      onError: options.onError ?? (() => {}),
      fetchRemote: options.fetchRemote ?? nodeFetch,
      probeTimeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      env: options.env ?? process.env,
      // Off unless a composition says otherwise: see the option's docblock for
      // why the *product* says otherwise and a library caller does not.
      requireProvider: options.requireProvider ?? false,
      ...options.plugins === undefined ? {} : { plugins: options.plugins },
      ...options.hostConnection === undefined ? {} : { hostConnection: options.hostConnection },
      ...options.installConnection === undefined ? {} : { installConnection: options.installConnection },
      ...options.scripts === undefined ? {} : { scripts: options.scripts },
      ...options.scriptLibrary === undefined ? {} : { scriptLibrary: options.scriptLibrary },
      ...options.extensionSettings === undefined ? {} : { extensionSettings: options.extensionSettings },
      ...options.scriptButtons === undefined ? {} : { scriptButtons: options.scriptButtons },
      ...options.worldbooks === undefined ? {} : { worldbooks: options.worldbooks },
      ...options.connections === undefined ? {} : { connections: options.connections },
      ...options.templates === undefined ? {} : { templates: options.templates },
      ...options.scriptVariables === undefined ? {} : { scriptVariables: options.scriptVariables },
      ...options.pruneVariables === undefined ? {} : { pruneVariables: options.pruneVariables },
      ...options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics },
      ...options.cardStorage === undefined ? {} : { cardStorage: options.cardStorage },
      ...options.presets === undefined ? {} : { presets: options.presets },
      ...options.sillyTavernDir === undefined ? {} : { sillyTavernDir: options.sillyTavernDir },
      ...options.personas === undefined ? {} : { personas: options.personas },
      ...options.favorites === undefined ? {} : { favorites: options.favorites },
      ...options.chatOrder === undefined ? {} : { chatOrder: options.chatOrder },
      ...options.worldbookBindings === undefined ? {} : { worldbookBindings: options.worldbookBindings },
      ...options.backups === undefined ? {} : { backups: options.backups },
      ...options.cacheTrace === undefined ? {} : { cacheTrace: options.cacheTrace },
    }
    // The manager's live state starts on whatever the caller assembled: a
    // stored selection is applied by the caller (the plugin) before the
    // handlers are ever registered, so nothing here needs to read files.
    this.#activePreset = this.#options.preset
    this.#activePresetName = options.presetName
    // Read here and never again: see {@link #launch}.
    this.#launch = {
      provider: this.#options.hostConnection?.provider ?? this.#options.settings.configuredRoute(),
      model: this.#options.hostConnection?.model ?? this.#options.settings.configuredModel(),
    }
  }

  /** How well the token estimate currently tracks the provider, for diagnostics. */
  get calibration(): { scale: number, samples: number } {
    return { scale: this.#counter.scale, samples: this.#counter.samples }
  }

  /** The prompt manager's view of the live preset. */
  #managerView(): PresetManagerView {
    return managerViewOf(this.#activePresetName, this.#activePreset)
  }

  // —— family③: preset ——

  /**
   * The running preset as a card sees it, read live.
   *
   * Live rather than captured: the body the manager swapped in is the one a
   * card's next generation assembles with, and a card reading the preset must
   * see the preset that will run.
   * @param forFrame - trim the extension sub-trees a per-frame clone cannot
   *   carry. True for the snapshot, false for the round-trip arm.
   * @returns the card-facing preset.
   */
  #inUsePreset(forFrame: boolean): TavernHelperPreset {
    return cardFacingPreset(this.#activePreset, {
      // The **global** layer, not a chat's. Upstream has one settings space, so
      // `getPreset('in_use')` there reports what every chat runs with; a
      // chat-scoped override is an Iris-only layer and a preset is not the
      // place a card would look for one. `getPreset` answers the same for every
      // frame of the page, which is also what makes one snapshot serve them all.
      live: this.#options.settings.get(),
      forFrame,
    })
  }

  /**
   * The preset half of a card's snapshot, or nothing on a storeless host.
   *
   * @returns the field `buildCardContext` puts on the snapshot.
   */
  async #presetSnapshot(): Promise<ScriptContext['preset']> {
    const store = this.#options.presets
    /*
     * Refused by absence rather than answered with `['in_use']`, the same line
     * every other preset arm draws: a host that keeps no library cannot honour
     * `loadPreset` or `createPreset` either, and an `['in_use']` name list
     * would invite a card to offer a switch that can never land. The frame
     * turns the absence into "this host has no preset library", which is the
     * true sentence.
     */
    if (store === undefined) return undefined
    const names = ['in_use', ...await store.list()]
    const loaded = this.#activePresetName
    const body = this.#inUsePreset(true)
    const text = JSON.stringify(body)
    /*
     * A ceiling, and the reason it exists rather than the number.
     *
     * The body rides a structured clone into every live frame, so its cost is
     * multiplied by `FRAME_COUNT_LIMIT` (18). Measured over the eight real
     * presets in the two local corpora on 2026-09-10, the trimmed body is
     * 1.4 KiB to 720 KiB — 12.7 MiB per reading window at the top of that
     * range. This limit is not tuned to that measurement: it is here so that a
     * preset nobody has measured cannot silently turn one card's read into a
     * hundred megabytes of clone. Above it the frame throws with the size,
     * which is a sentence a person can act on, where a page that simply became
     * unusable is not.
     */
    if (text.length > FRAME_PRESET_LIMIT) {
      const size = `${String(Math.round(text.length / 1024))} KiB`
      this.#report(
        `the preset in use is ${size} as a card sees it, past the ${String(FRAME_PRESET_LIMIT / 1024)} KiB a frame can be handed; `
        + 'getPreset("in_use") will refuse in every card until it is smaller',
        { kind: 'host', grade: 'note' },
      )
      return {
        names,
        ...loaded === undefined ? {} : { loaded },
        refusal: `the preset in use is ${size} as a card sees it, which is past the ${String(FRAME_PRESET_LIMIT / 1024)} KiB this host hands a frame`,
      }
    }
    return { names, ...loaded === undefined ? {} : { loaded }, inUse: text }
  }

  /**
   * Read one preset by the name a card asked for.
   * @param name - `'in_use'` or a library name.
   * @returns the card-facing preset, untrimmed.
   * @throws {AppError} `not-found` when the library has no such preset.
   */
  async #presetByName(name: string): Promise<TavernHelperPreset> {
    if (name === 'in_use') return this.#inUsePreset(false)
    const store = this.#options.presets
    if (store === undefined) throw new AppError('unsupported', 'this host keeps no preset library')
    // `store.read` throws `not-found` with the name in it, which is the shape
    // upstream's own `throw Error("预设 '…' 不存在")` gives a card's catch.
    return cardFacingPreset(await store.read(name))
  }

  // —— family③ end ——

  /**
   * Swap the live preset for another body and persist the choice.
   *
   * One path for both `preset.select` and a connection's bound preset, so the
   * two cannot disagree about what a switch means: the body becomes the
   * assembler's input, the scalar fields it acts on land in the global
   * settings layer, and the state persists for the next host start.
   * @param name - the library name, when it has one.
   * @param body - the preset to run on.
   */
  async #applyPreset(name: string | undefined, body: ChatCompletionPreset): Promise<void> {
    this.#activePreset = body
    this.#activePresetName = name
    await this.#options.settings.setPreset(name, body)
    const patch = presetScalarPatch(body)
    if (Object.keys(patch).length > 0) await this.#options.settings.set(undefined, patch)
    // A preset carries its own regex tier, so a switch changes which rules
    // rewrite the page and the request — and a conversation that is already
    // open is still composing from the tier it opened with. The refresh is
    // after the persist, because the tier is read back out of the settings
    // record this line just wrote (see `activePresetRegexSource`).
    //
    // Unconditional, rather than only when either preset carries rules: the
    // condition would have to compare two `extensions.regex_scripts` fields to
    // decide, and getting that comparison wrong leaves the *old* preset's
    // rules running with nothing to show it.
    await this.#refreshRegex()
  }

  /**
   * Persist the live state after a manager mutation.
   *
   * Clone-on-write: the assembler may be mid-assembly on another turn, and it
   * must never observe a half-edited prompt list.
   * @param body - the mutated preset.
   */
  async #persistActivePreset(body: ChatCompletionPreset): Promise<PresetManagerView> {
    this.#activePreset = body
    await this.#options.settings.setPreset(this.#activePresetName, body)
    return this.#managerView()
  }

  /**
   * Apply a connection profile's bound preset, skipping an absent one.
   * @param name - the preset name stored on the profile.
   */
  async #activateBoundPreset(name: string): Promise<void> {
    const store = this.#options.presets
    if (store === undefined) return
    if (await store.has(name) === false) {
      this.#report(
        `connection names preset "${name}", which the library does not have — activate it from the preset panel after importing`,
        { kind: 'host', grade: 'note' },
      )
      return
    }
    await this.#applyPreset(name, await store.read(name))
  }

  /**
   * Hand a profile's endpoint to the composition's installer, saying so in the
   * report without saying the key.
   *
   * The credential is resolved by {@link routeCredential} — the profile's own
   * key, else the host's at the same origin, else none — so a route generates
   * with exactly the key `connection.test` would have probed with. Measured
   * 2026-09-09: a same-origin profile saved with the key field blank (the form
   * says the host supplies it) probed green and then generated with **no**
   * `Authorization` header at all, which DeepSeek answers
   * `401 Authentication Fails (governor)`. The report names the source, never
   * the key, so a `none` is visible in the log before the endpoint says so.
   * @param route - the provider route to serve the endpoint under.
   * @param profile - the profile whose endpoint is being installed.
   * @returns whether an adapter was installed. False means this host was
   *   composed without an installer, so the route is **not** served — the
   *   caller must not treat a silent return as success.
   */
  #installConnectionFor(
    route: string,
    profile: { baseURL: string, apiKey?: string | undefined, apiKeyHeader?: string | undefined },
  ): boolean {
    const install = this.#options.installConnection
    if (install === undefined) return false
    const credential = routeCredential(profile, this.#hostConnection())
    install(route, {
      baseURL: profile.baseURL,
      ...credential.apiKey === undefined ? {} : { apiKey: credential.apiKey },
      ...credential.apiKeyHeader === undefined ? {} : { apiKeyHeader: credential.apiKeyHeader },
    })
    // Recorded **here** and nowhere else, so every path that installs — an
    // activation, the boot restore, and a generation that had to install the
    // route it was told to use — lands in one set. See {@link #installedRoutes}.
    this.#installedRoutes.add(route)
    this.#report(
      // `note`, not `fault`: the activation was served. What the sentence adds
      // is the word `none`, which is the whole diagnosis of a 401 that follows.
      `connection now generates through route "${route}" at ${new URL(profile.baseURL).origin} — key: ${credential.keySource}`,
      { kind: 'host', grade: 'note' },
    )
    return true
  }

  /**
   * Re-install the adapter for the profile that was last activated.
   *
   * Called by the composition once, after construction and **before any
   * handler is registered**: a route name persisted in `settings.json`
   * (`conn/<id>`, or the profile's provider) is a promise the registry has to
   * be able to keep on the first turn.
   *
   * A method on the service rather than the block the plugin used to run
   * inline, for one reason that is not tidiness: the inline version called the
   * installer directly, so the boot-restored route was invisible to
   * {@link #installedRoutes} — the set would have said "not installed" for the
   * one route the host had just installed, and a generation on it would have
   * re-installed it on the first turn of every restart.
   *
   * A route this process has **already** installed is left alone, which is the
   * same set being read for the same reason one line later in the boot:
   * {@link importLaunchConnection} runs first and installs what it applied, and
   * without this the very next call would install it a second time and report a
   * second "connection now generates through…" line for one connection.
   * @returns the route that was restored, when one was — absent when there was
   *   nothing to restore *or* when it was already served.
   */
  async restoreActiveConnection(): Promise<string | undefined> {
    const store = this.#options.connections
    if (store === undefined) return undefined
    const listed = await store.list()
    if (listed.activeId === undefined) return undefined
    // A profile removed out-of-band is not a failure to boot: the list clears
    // the stale active id on its next write, and a dangling `provider` left in
    // the settings layer is answered by `#resolveRoute` on the first
    // generation rather than by refusing to start.
    const profile = await store.get(listed.activeId).catch(() => undefined)
    if (profile?.baseURL === undefined || profile.baseURL.length === 0) return undefined
    const route = routeOf(profile)
    if (this.#installedRoutes.has(route)) return undefined
    return this.#installConnectionFor(route, { ...profile, baseURL: profile.baseURL }) ? route : undefined
  }

  /**
   * Move the launch environment into the provider list, once, on a host that
   * has no providers at all.
   *
   * **The migration the deprecation needs.** Until 2026-09-10 a host configured
   * from `IRIS_BASE_URL` / `IRIS_MODEL` / `IRIS_API_KEY_ENV` generated through
   * that configuration with no profile saved at all, and the interface said so
   * in a row of its own. The ruling that day retires the row and
   * {@link AppServiceOptions.requireProvider} refuses to generate without a
   * provider — so a user who upgrades with an empty `connections.json` would
   * find a host that answers nothing until they retype what their `.env`
   * already says. This copies it in instead, and **applies** it, so the first
   * turn after the upgrade goes exactly where the last turn before it went.
   *
   * **It is not the old route under a new name.** What arrives is an ordinary
   * saved provider: editable, deletable, replaceable, and the credential is in
   * the profile rather than borrowed from the environment at install time. The
   * environment stops being consulted for *which* provider generates; it is
   * only where these three values were read from, once.
   *
   * Conditions, all of them:
   *
   * - a `connections` store is configured (otherwise there is no list to write
   *   into, and `requireProvider` is ignored for the same reason);
   * - the list is **empty** — not "nothing is active", *empty*. A user who has
   *   ever saved a provider has made this decision themselves, and a second
   *   row appearing at their next start would be this host editing their list
   *   behind them;
   * - the launch configuration names an endpoint **and** a model. Both are
   *   stored fields of a profile and the protocol refuses one with no model, so
   *   a host that never said where it points cannot be copied. `IRIS_BASE_URL`
   *   unset is exactly that case: the composition's
   *   `http://127.0.0.1:11434/v1` default lives in a `!!js` expression this
   *   runtime cannot read, and inventing a copy of it here would be a constant
   *   that drifts (`hostConnectionFromEnv` makes the same choice for the same
   *   reason).
   *
   * **Where each of the three values comes from**, because they do not share a
   * source and a reader will assume they do. The endpoint and the credential
   * are read from the environment (`hostConnectionFromEnv`, or whatever the
   * composition handed in). The **model** is the launch snapshot's, which is
   * the composition's own configured model — `apps/iris/cordis.yml`'s `app`
   * row, `!!js process.env.IRIS_MODEL` — and not a second read of that
   * variable here: the composition is the authority on what this host
   * generates with, and a runtime that re-read the variable could disagree with
   * the settings layer it was constructed from.
   *
   * The key travels **inside the host**, as an adoption always did: the browser
   * is not involved, and the report names its source rather than its value. A
   * host with an endpoint and no key still imports — a local llama.cpp or
   * Ollama serve needs none, and refusing there would leave precisely the
   * simplest configuration unable to generate.
   * @returns the id of the profile it created, or `undefined` when it did
   *   nothing — which is the normal answer on every start after the first.
   */
  async importLaunchConnection(): Promise<string | undefined> {
    const store = this.#options.connections
    if (store === undefined) return undefined
    const listed = await store.list()
    if (listed.profiles.length > 0) return undefined

    const host = this.#hostConnection()
    if (host.baseURL === undefined || host.baseURL.length === 0) return undefined
    if (host.model === undefined || host.model.length === 0) return undefined

    const saved = await store.save({
      // The launch route's own provider name, so `routeOf` derives the same
      // route an ordinary saved provider gets (`conn/<id>` on the shipped
      // composition, whose `app` row is `provider: default`) and the adapter
      // installed below is this profile's, not the composition's registration.
      provider: host.provider,
      model: host.model,
      baseURL: host.baseURL,
      // Stored data, not a dictionary string: a label lives in the user's file
      // and cannot follow the interface's language. It says where the row came
      // from, which is the one thing about it a reader cannot derive.
      label: '启动环境',
      ...host.apiKey === undefined || host.apiKey.length === 0 ? {} : { apiKey: host.apiKey },
      ...host.apiKeyHeader === undefined || host.apiKeyHeader.length === 0
        ? {}
        : { apiKeyHeader: host.apiKeyHeader },
    })
    const profile = saved.profiles[0]
    if (profile === undefined) return undefined

    // Applied, by the same three acts `connection.activate` performs: the
    // adapter for its endpoint, the settings layer naming that route, and the
    // active id. Anything less would leave a provider in the list that nothing
    // generates through, which is the state this method exists to prevent.
    const route = routeOf({ ...profile, baseURL: host.baseURL })
    this.#installConnectionFor(route, {
      baseURL: host.baseURL,
      ...host.apiKey === undefined ? {} : { apiKey: host.apiKey },
      ...host.apiKeyHeader === undefined ? {} : { apiKeyHeader: host.apiKeyHeader },
    })
    await this.#options.settings.set(undefined, { provider: route, model: host.model })
    await store.markActive(profile.id)
    this.#report(
      `the launch environment was imported as connection profile "${profile.id}" and applied: `
      + `${new URL(host.baseURL).origin} with model "${host.model}", route "${route}", `
      + `key: ${host.apiKey === undefined || host.apiKey.length === 0 ? 'none' : 'copied from the environment'}. `
      + 'Providers are now chosen from the connection card; the environment is no longer a route.',
      { kind: 'host', grade: 'note' },
    )
    return profile.id
  }

  /**
   * The route the **composition** registered, which is always served.
   *
   * Read off {@link #launch}, and never off the **global settings layer**: that
   * layer is one of the two places a dangling route name can sit, so a check of
   * "is this the host's own route?" written against it would answer yes *for
   * the dangling name itself* and pass exactly the request it exists to catch.
   * The launch snapshot cannot dangle — it is the `llm-openai-compat` row's own
   * registration.
   *
   * This docblock used to warn "deliberately not `#hostConnection().provider`",
   * because that reader *did* answer from the global layer. Since 2026-09-09
   * (host §60) it reads the same snapshot as this method, so the two agree by
   * construction rather than by which one a caller happened to reach for; the
   * warning survives as the reason the snapshot exists at all.
   * @returns the route key the host generates through with no connection applied.
   */
  #hostRoute(): string {
    return this.#launch.provider
  }

  /**
   * Whether a route still has something behind it after a profile is deleted.
   *
   * Two survivors, both real: the composition's own route (a profile naming
   * `provider: 'default'` with no endpoint of its own routes *there*, and
   * deleting it takes nothing away), and another saved profile that resolves to
   * the same route — which is how two profiles of one provider take turns
   * (host §27).
   *
   * A live install of this process is **not** counted. The adapter would answer
   * this turn and be gone on the next start, so a settings layer left pointing
   * at it would be a reference that works until the user restarts — the failure
   * mode being removed, deferred rather than fixed.
   * @param route - the route the deleted profile was served under.
   * @param remaining - the profiles left after the deletion.
   * @returns true when something other than the deleted profile serves it.
   */
  #routeStillServed(route: string, remaining: readonly ConnectionProfile[]): boolean {
    if (route === this.#hostRoute()) return true
    return remaining.some(profile => routeOf(profile) === route)
  }

  /**
   * Make sure the route a generation is about to use is one that exists — and
   * say so when it is not.
   *
   * The measured failure (2026-09-09) is two-layered, and this is the second
   * net; `connection.delete` is the first. `settings.json` stores `provider` as
   * a reference to a *runtime* route, the registry holding those routes is per
   * process and filled only by an activation or the boot restore, and neither
   * of those has to have happened in *this* process. So a name that was true
   * when it was written reaches `ctx.llm.stream` as `no adapter registered for
   * provider "deepseek"` — a message about the registry, from a request whose
   * settings were never wrong.
   *
   * Four answers, in the order that asks the cheapest question first:
   *
   * 1. **The host's own route** ({@link #hostRoute}) — always served.
   * 2. **A route this process installed** ({@link #installedRoutes}) — served
   *    since the activation or the restore that installed it.
   * 3. **A saved profile resolves to it.** Carrying an endpoint, it is
   *    installed here and now, which is the case that makes a second host on
   *    one data directory work: the profile is on disk, this process simply
   *    never activated it. Carrying no endpoint, it names a route some *other*
   *    plugin registered — not ours to install and not ours to judge, so it is
   *    passed through exactly as before.
   * 4. **Nothing resolves to it.** The reference is dangling: the request goes
   *    out on the host's own route rather than failing, and the layer that
   *    named it is cleared so the next turn does not repeat the fall back.
   *    Both halves are reported — a silent repair of a user's setting is worse
   *    than the error it replaces, because the setting simply changes.
   *
   * The one case that falls back **without** repairing anything is a profile
   * that exists and cannot be installed here, on a composition that was given
   * no installer at all: the reference is not dangling, this host merely cannot
   * honour it, and clearing a good setting because of a missing capability
   * would lose the user's choice to a host that is temporarily less able.
   *
   * **Before any of that**, when the composition asked for it
   * ({@link AppServiceOptions.requireProvider}): a generation with **no saved
   * provider in use** is refused rather than served. The user's ruling of
   * 2026-09-10 retires the environment's own route as something a reply can
   * come from, and this is the one place that decision can be enforced once —
   * the same funnel, the same reason the four callers do not each carry a
   * check of their own. It is deliberately the *first* question asked, because
   * the route the settings name in that state is usually the host's own, which
   * rung 1 would wave straight through.
   * @param provider - the route the effective settings named.
   * @param chatId - the conversation the settings were read for, for the report.
   * @returns the route to actually generate on.
   * @throws {AppError} `no-provider` when nothing is in use and this host
   *   requires a provider.
   */
  async #resolveRoute(provider: string, chatId?: string): Promise<string> {
    const store = this.#options.connections
    // One read for both questions below. The store caches the file after its
    // first load, so this is not a stat per turn.
    const listed = store === undefined ? undefined : await store.list()
    if (this.#options.requireProvider && listed !== undefined && listed.activeId === undefined) {
      throw new AppError(
        'no-provider',
        'no connection provider is in use, so there is nothing to generate through: '
        + 'add a provider in the connection card and press 使用. '
        + 'This host no longer generates through the route it was launched with.',
      )
    }

    const host = this.#hostRoute()
    if (provider === host || this.#installedRoutes.has(provider)) return provider

    const profiles = listed?.profiles ?? []
    const named = profiles.find(profile => routeOf(profile) === provider)
    /**
     * Report the fall back and answer with the host's route.
     * @param reason - why the named route could not be used.
     * @param repair - what was done about the setting, said in the same sentence.
     * @param wrote - whether a stored setting of the user's was changed, which
     *   is what puts this on the pushed channel rather than only in the buffer:
     *   the value that layer held is gone, and nothing else in the interface
     *   will ever say so — the panel reads settings when it is opened, so a
     *   repair made mid-turn is otherwise invisible until something refetches.
     *   A fall back that changed nothing is retained and not pushed.
     * @returns the host's own route.
     */
    const fell = (reason: string, repair: string, wrote: boolean): string => {
      this.#report(
        `${reason}, so this request generates through the host's own route "${host}" instead${repair}`,
        {
          kind: 'host',
          grade: 'fault',
          ...chatId === undefined ? {} : { chatId },
          ...wrote ? { irreversible: true } : {},
        },
      )
      return host
    }

    if (named !== undefined) {
      if (named.baseURL === undefined || named.baseURL.length === 0) return provider
      // The key never crosses the wire, so the list's view does not carry it —
      // the stored profile does, and the adapter is the one place it goes.
      const stored = store === undefined ? undefined : await store.get(named.id).catch(() => undefined)
      const endpoint = stored?.baseURL ?? named.baseURL
      if (this.#installConnectionFor(provider, { ...(stored ?? {}), baseURL: endpoint })) return provider
      return fell(
        `the connection served under route "${provider}" still exists, but this host was composed with no way to `
        + 'install an adapter for it',
        ' — the setting is left alone, because the connection is not the thing that is missing',
        false,
      )
    }

    // Cleared before the report is written, so the sentence can name what it
    // did rather than what it is about to do.
    const cleared = await this.#options.settings.clearProviderRoute(provider)
    // Counted rather than assumed to be this one conversation: one route can be
    // named by several chats' layers (host A activated it on each of them), and
    // the clear takes all of them — a sentence saying "this conversation" would
    // understate what just changed.
    const others = cleared.chats.filter(id => id !== chatId).length
    const layers = [
      ...cleared.chats.includes(chatId ?? '') ? ['this conversation\'s own setting'] : [],
      ...others === 0 ? [] : [`${String(others)} other conversation(s)' own setting`],
      ...cleared.global ? ['the global setting'] : [],
    ]
    return fell(
      `the connection named "${provider}" no longer exists`,
      layers.length === 0
        ? ' (nothing in the settings still names it, so there was nothing to repair)'
        : ` — ${layers.join(' and ')} named it and has been cleared, so the next turn starts from the host's route`,
      cleared.global || cleared.chats.length > 0,
    )
  }

  /**
   * The connection this host was started with, as the composition told it or
   * as the environment still says.
   *
   * The provider and model come from {@link #launch} — the **launch snapshot**,
   * not the global settings layer. Reading the layer (which is what this did
   * until 2026-09-09, host §60) made the answer follow every global activation:
   * `ConnectionStore.patchOf` writes `provider` and `model` there, so one 使用
   * and this method described the profile in force while every caller's
   * docblock said it described the launch configuration. The endpoint and the
   * credential still come from the environment, because those are the two
   * fields the settings layer never held.
   * @returns the host's own connection, credential included (in-process only).
   */
  #hostConnection(): HostConnection {
    const explicit = this.#options.hostConnection
    if (explicit !== undefined) return explicit
    return hostConnectionFromEnv(this.#options.env, this.#launch)
  }

  /**
   * What the browser may know about this host's environment credential.
   *
   * One method rather than three bare `hostDefaultView(…)` call sites, kept for
   * that reason alone now that the projection is three fields wide: the
   * endpoint the process was configured with, whether it holds a key for it,
   * and the variable's name. It is **not** a connection row any more — nothing
   * generates through the environment (host §61) — and its only readers are the
   * two sentences a provider editor says about a key left blank at that origin.
   * @returns the environment's endpoint and key source, never the key.
   */
  #hostDefaultRow(): HostDefaultConnection {
    return hostDefaultView(this.#hostConnection())
  }

  /*
   * `#recordHostModels` stood here: a successful bare probe of the host's own
   * endpoint filed its model list against `#hostProbe`, keyed on the origin so
   * a neighbouring provider's answer could not be attributed to it. Both are
   * gone with the row they filled (host §61). A probe naming a **profile**
   * still records its list — on the profile, in the user's file.
   */

  /**
   * Decide which key a probe sends, and say where it came from.
   *
   * The order is a precedence of *decisions*, newest first: what the user just
   * typed, then the profile they are looking at, then the profile the host is
   * currently generating through, then the credential the process was started
   * with. Each fallback is gated on {@link sameEndpointOrigin} — a key is only
   * ever reused at the origin it belongs to, so an absent `apiKey` cannot be
   * turned into "send my credential to this address of my choosing".
   *
   * The header travels with whichever key won, not with the request: a stored
   * key sent under a header the form happened to hold would authenticate as
   * neither.
   * @param baseURL - where the probe is actually going.
   * @param input - the request, whose `apiKey` may be absent or empty.
   * @param profile - the named profile, when one was named.
   * @returns the key (in-process), its header, and the source to report.
   */
  async #probeCredential(
    baseURL: string,
    input: { apiKey?: string | undefined, apiKeyHeader?: string | undefined },
    profile?: { baseURL?: string, apiKey?: string, apiKeyHeader?: string },
  ): Promise<{ apiKey?: string, apiKeyHeader?: string, keySource: ConnectionKeySource }> {
    const header = (owner: { apiKeyHeader?: string | undefined }): { apiKeyHeader?: string } => {
      const chosen = input.apiKeyHeader ?? owner.apiKeyHeader
      return chosen === undefined || chosen.length === 0 ? {} : { apiKeyHeader: chosen }
    }

    if (input.apiKey !== undefined && input.apiKey.length > 0) {
      return { apiKey: input.apiKey, ...header(input), keySource: 'typed' }
    }

    // The profile the form is editing. Its own endpoint is the origin its key
    // belongs to; a form that has retyped the base URL elsewhere gets nothing.
    if (
      profile?.apiKey !== undefined && profile.apiKey.length > 0
      && sameEndpointOrigin(profile.baseURL, baseURL)
    ) {
      return { apiKey: profile.apiKey, ...header(profile), keySource: 'stored' }
    }

    // The profile the host is generating through right now. This is the case
    // that makes an untouched form testable: open the panel, press Test, and
    // the connection in force answers for itself.
    const store = this.#options.connections
    if (store !== undefined) {
      const listed = await store.list()
      if (listed.activeId !== undefined) {
        const active = await store.get(listed.activeId).catch(() => undefined)
        if (
          active?.apiKey !== undefined && active.apiKey.length > 0
          && sameEndpointOrigin(active.baseURL, baseURL)
        ) {
          return { apiKey: active.apiKey, ...header(active), keySource: 'stored' }
        }
      }
    }

    const host = this.#hostConnection()
    if (
      host.apiKey !== undefined && host.apiKey.length > 0
      && sameEndpointOrigin(host.baseURL, baseURL)
    ) {
      return { apiKey: host.apiKey, ...header(host), keySource: 'host' }
    }

    // Nothing to send, which a local serve is perfectly happy with. The header
    // still rides so a 401 says something about the endpoint rather than about
    // a header this branch dropped.
    return { ...header(input), keySource: 'none' }
  }

  /**
   * Probe an endpoint the way a model list would be fetched.
   *
   * The credential, if any, goes into the request headers and **nowhere
   * else** — not into an error message, not into the report log. A failed
   * probe is a result rather than a thrown error: the caller is a form, and a
   * form renders a verdict, it does not catch one.
   *
   * `keySource` is deliberately **not** part of what this returns: this method
   * knows what key it was handed, not where the key came from, and the caller
   * that resolved it is the only honest author of that field. Stamping it here
   * would mean threading the answer in just to read it back out.
   * @param target - the endpoint and optional credential to probe.
   * @returns the verdict: latency always, models when it worked, a named error when not.
   */
  async #probeEndpoint(target: {
    baseURL: string
    apiKey?: string | undefined
    apiKeyHeader?: string | undefined
  }): Promise<ProbeVerdict> {
    const url = `${target.baseURL.replace(/\/+$/, '')}/models`
    /*
     * Two refusals before the wire, both for inputs `fetch` would reject with a
     * `TypeError` — which the catch below used to file under `network`, so a
     * base URL typed without its scheme, or with a full-width `：` from an IME,
     * came back as 「无法连接到端点。请检查地址与网络。」 in one millisecond, and
     * the person went looking at their network (measured 2026-09-09: the same
     * key and endpoint worked on every other client). The address is checked
     * as the request would see it; the key is checked against what a header
     * can carry, and the message says *where* the bad character is, never
     * what surrounds it.
     */
    const badUrl = badUrlVerdict(target.baseURL)
    if (badUrl !== undefined) return badUrl
    // `Authorization` carries the Bearer scheme; any other header name is a
    // bare value — the same rule the LLM adapter applies, so a probe that
    // passed is a stream that authenticates.
    const headerName = (target.apiKeyHeader ?? 'Authorization').toLowerCase()
    const headers: Record<string, string> = { accept: 'application/json' }
    if (target.apiKey !== undefined && target.apiKey.length > 0) {
      const bad = headerValueFault(target.apiKey)
      if (bad !== undefined) {
        return {
          ok: false,
          latencyMs: 0,
          error: {
            code: 'bad-key',
            message: `the key holds a character an HTTP header cannot carry (at index ${String(bad.index)}, code point ${String(bad.codePoint)}) — re-paste it without that character`,
          },
        }
      }
      headers[headerName] = headerName === 'authorization' ? `Bearer ${target.apiKey}` : target.apiKey
    }

    const started = performance.now()
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(this.#options.probeTimeoutMs),
      })
    } catch (cause: unknown) {
      const latencyMs = Math.round(performance.now() - started)
      if (cause instanceof Error && cause.name === 'TimeoutError') {
        return {
          ok: false,
          latencyMs,
          error: { code: 'timeout', message: `no answer from ${url} within ${String(this.#options.probeTimeoutMs)}ms` },
        }
      }
      return {
        ok: false,
        latencyMs,
        error: { code: 'network', message: `could not reach ${url}: ${fetchFailureReason(cause)}` },
      }
    }
    const latencyMs = Math.round(performance.now() - started)

    if (response.status === 401 || response.status === 403) {
      await response.arrayBuffer()
      return {
        ok: false,
        latencyMs,
        error: { code: 'unauthorized', message: `${url} answered ${String(response.status)} — the key does not open this endpoint` },
      }
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300)
      return {
        ok: false,
        latencyMs,
        error: { code: 'http-error', message: `${url} answered ${String(response.status)}: ${detail}` },
      }
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      return {
        ok: false,
        latencyMs,
        error: { code: 'bad-response', message: `${url} answered 200, but the body is not JSON` },
      }
    }
    const listed = modelListOf(body)
    if (listed === undefined) {
      return {
        ok: false,
        latencyMs,
        error: { code: 'bad-response', message: `${url} answered 200, but the body carries no model list` },
      }
    }
    const modelContexts = withTableContexts(listed.ids, listed.contexts)
    return {
      ok: true,
      latencyMs,
      models: listed.ids,
      // Omitted rather than sent empty, so "nothing knows any of these
      // windows" and "this build predates the field" stay distinguishable on
      // the wire.
      ...Object.keys(modelContexts).length === 0 ? {} : { modelContexts },
    }
  }

  /**
   * The preset names the configured SillyTavern install offers.
   * @returns the names, or undefined when no install is configured.
   */
  async #installPresets(): Promise<string[] | undefined> {
    const dir = this.#options.sillyTavernDir
    if (dir === undefined) return undefined
    const { readdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    try {
      return (await readdir(join(dir, 'OpenAI Settings')))
        .filter(entry => entry.endsWith('.json'))
        .map(entry => entry.slice(0, -'.json'.length))
        .sort((left, right) => left.localeCompare(right))
    } catch {
      // Not a profile directory, or no presets were ever saved there.
      return []
    }
  }

  /**
   * Every protocol method, ready to register on a transport.
   * @returns the handler table.
   */
  handlers(): Handlers {
    const { chats, library, settings, worldbooks } = this.#options
    const scripts = this.#options.scripts
    const scriptLibrary = this.#options.scriptLibrary
    const cardStorage = this.#options.cardStorage
    const plugins = this.#options.plugins

    const requirePlugins = (): SystemPluginRuntime => {
      if (plugins === undefined) {
        throw new AppError('unsupported', 'system plugins are not configured on this host')
      }
      return plugins
    }

    /**
     * The library, or a refusal that names what is missing.
     *
     * Refused rather than answered empty, and the argument is the one
     * `debug.reports` makes: an empty listing under live controls says
     * "configured, and you have written nothing", which on a host with no
     * library is false. The panel would offer Save and swallow it.
     * @returns the store.
     * @throws {AppError} `unsupported` on a host that keeps no library.
     */
    const requireLibrary = (): ScriptLibraryStore => {
      if (scriptLibrary === undefined) {
        throw new AppError('unsupported', 'this host keeps no script library')
      }
      return scriptLibrary
    }

    /**
     * The policy store, or a refusal that names what is missing.
     *
     * The same shape and the same argument as `requireLibrary` above: the
     * preset regex tier's two writes land in the user's policy file, and a host
     * without one has nowhere to record a permission — answering
     * "allowed: false" would be indistinguishable from a decision the user had
     * actually made.
     * @returns the store.
     * @throws {AppError} `unsupported` on a host that keeps no script policy.
     */
    const requirePolicy = (): ScriptPolicyStore => {
      if (scripts === undefined) {
        throw new AppError('unsupported', 'script policy is not configured on this host')
      }
      return scripts
    }

    /**
     * Which preset the regex tier belongs to, and the body it is read from.
     *
     * **The persisted selection, not the field the assembler holds** — and that
     * is deliberate: the chat store composes its preset tier from exactly this
     * pair (the closure in `index.ts`), so a panel reading the live field
     * instead could show a reader a tier their conversations were not running.
     * Every path that changes the active preset — a switch, a save over the
     * active name, a delete of it, and every manager mutation — writes through
     * `settings.setPreset` before it returns, which is what makes one reading
     * serve both.
     *
     * Read as one pair with no `await` between the two accessors, because they
     * are two views of one record and a suspension between them is a
     * suspension in which a switch could land.
     * @returns the name (absent when the active preset has none) and the body.
     */
    const activePresetRegexSource = (): { name: string | undefined, body: unknown } => ({
      name: settings.presetName(),
      body: settings.presetBody(),
    })

    /**
     * The active preset's library name, or a refusal that says why there is none.
     *
     * A decision has to be recorded against something, and upstream's
     * allow-list is keyed by the preset's name. A host still assembling with
     * the file its composition configured has no name to key by — so the
     * refusal names the way out (save it to the library) rather than storing
     * the permission under an invented key that the next switch would orphan.
     * @returns the name.
     * @throws {AppError} `invalid-request` when the active preset has no name.
     */
    const activePresetName = (): string => {
      const name = activePresetRegexSource().name
      if (name === undefined) {
        throw invalid(
          'the active preset has no library name, so its regex tier cannot be allow-listed'
          + ' — save it to the preset library first',
        )
      }
      return name
    }

    /**
     * The active preset's tier as the three preset-regex methods answer it.
     *
     * One projection for all three, so the two writes answer with the same
     * reading the list does — the shape the scoped trio already has.
     * @returns the rows, the gate, and the refused-row count.
     */
    const presetRegexView = async (): Promise<PresetRegexAnswer> => {
      const store = requirePolicy()
      const { name, body } = activePresetRegexSource()
      // No name, no tier: nothing can be allow-listed, so nothing is listed as
      // switchable either. The absent `presetName` is what the panel reads to
      // tell this empty state from a preset that simply ships no rules.
      if (name === undefined) return { scripts: [], allowed: false, malformed: 0 }
      return { presetName: name, ...await store.presetRegexView(name, body) }
    }

    /**
     * Check a library request's scope against the character id beside it.
     *
     * The pair is checked here rather than modelled as a discriminated union in
     * the schema, because the refusal has to *name* the mistake: a schema
     * failure on a two-field request reads as "malformed" and sends whoever hit
     * it to the transport. And the character is **loaded**, not merely required
     * to be present — a repository keyed on an id no card holds is one that the
     * next card taking that id would inherit, which is arbitrary code beginning
     * to run in a stranger's conversations.
     * @param scope - which repository the caller named.
     * @param characterId - the id beside it, if any.
     * @throws {AppError} `invalid-request` when the two disagree.
     * @throws {AppError} `not-found` when a named character does not exist.
     */
    const requireScopeCharacter = async (
      scope: LibraryScope,
      characterId: string | undefined,
    ): Promise<void> => {
      if (scope === 'global') {
        if (characterId !== undefined) {
          throw invalid('the global script repository takes no character id')
        }
        return
      }
      if (characterId === undefined) {
        throw invalid('a character script repository needs a character id')
      }
      await library.load(characterId)
    }

    /**
     * Every script that would run in one character's conversations, in run
     * order: the user's global library, then this card's own scripts, then the
     * user's library for this card.
     *
     * **One reading, one order, used by every caller.** The order is the merge
     * order upstream's runtime uses for its own three repositories
     * (`store/iframe_runtimes/script.ts:26-32`) with the card's tier standing
     * in for the preset one, and it is observable: two scripts writing the same
     * variable settle it by which ran last. The listing and the runner read the
     * same function so the panel cannot show an order the page does not use.
     * @param characterId - whose conversations.
     * @returns the rows, switched-off ones included.
     */
    const listAllScripts = async (characterId: string): Promise<ScriptView[]> => {
      const rows: ScriptView[] = []
      const mine = scriptLibrary === undefined ? [] : await scriptLibrary.views(characterId)
      rows.push(...mine.filter(row => row.scope === 'global').map(scriptRowOf))
      if (scripts !== undefined) {
        const overrides = await this.#options.scriptButtons?.all(characterId) ?? {}
        rows.push(...await scripts.view(characterId, await library.load(characterId), overrides))
      }
      rows.push(...mine.filter(row => row.scope === 'character').map(scriptRowOf))
      return rows
    }

    /*
     * Named rather than returned inline, so an arm can call another arm.
     *
     * Three of the card-facing preset arms do: `script.deletePreset`,
     * `script.renamePreset` and `script.loadPreset` reach `preset.delete` and
     * `preset.select` instead of the store, because those two carry
     * consequences beyond the file — the active preset's name is the key its
     * regex allow-list is addressed by, and a switch has to refresh every open
     * conversation's tier. Reimplementing them at the card face would be a
     * second definition of what a delete and a switch mean, and the second one
     * would be the one that forgets.
     */
    const handlers: Handlers = {
      'plugin.list': async () => requirePlugins().snapshot(),
      'plugin.install': async ({ id }) => await requirePlugins().install(id),
      'plugin.uninstall': async ({ id }) => await requirePlugins().uninstall(id),
      'plugin.enable': async ({ id }) => await requirePlugins().enable(id),
      'plugin.disable': async ({ id }) => await requirePlugins().disable(id),
      'plugin.reload': async ({ id }) => await requirePlugins().reload(id),

      'chat.list': async () => {
        const order = this.#options.chatOrder
        return {
          chats: await this.#chatList(),
          // Absent, not `false`, when this host keeps no arrangement: the
          // protocol's own note on this field says why, and the panel reads a
          // missing field as "there is no such thing here" rather than as
          // "there is one and it is empty".
          ...order === undefined ? {} : { ordered: (await order.list()).length > 0 },
        }
      },

      'chat.create': async ({ characterId }) => {
        const entry = await chats.create(characterId, this.#options.userName)
        await this.#announceChats()
        return { view: this.#viewOf(entry) }
      },

      'chat.open': async ({ chatId }) => {
        // A re-open is the moment SillyTavern would have cleared injections and
        // this host does not. Upstream's `clearChat()` empties the single global
        // `extension_prompts` on every chat open, switch and delete; ours are
        // held per conversation, so switching away and back finds them still
        // there. Whichever behaviour is right, the one thing that must not
        // happen is the difference being silent — a card written against
        // SillyTavern assumes a clean slate here, and stale injected text is
        // indistinguishable from text the card meant to put there.
        const reopened = chats.cached(chatId) !== undefined
        const entry = await chats.open(chatId)
        if (reopened && entry.extensionPrompts.size > 0) {
          this.#report(
            `${String(entry.extensionPrompts.size)} script injection(s) are still live on this chat from an`
            + ' earlier session; SillyTavern would have cleared them when the chat was opened',
            {
              kind: 'script',
              grade: 'note',
              chatId,
              ...entry.meta.characterId === undefined ? {} : { characterId: entry.meta.characterId },
            },
          )
        }
        // **Every open, with no memory of having asked.** Upstream hangs
        // `checkAndCleanupLegacyChat` on the chat load itself, so opening a chat
        // asks again. Gating this behind the report note — which speaks once per
        // loaded entry — turned "we will ask again next time" into "next time the
        // host loads this entry", so dismissing the dialog and reopening the chat
        // was indistinguishable from having declined. The four gates are the only
        // memory needed: once a sweep has run, the first floor no longer holds
        // `stat_data`, and once someone declines, `ignore_cleanup` is on the chat.
        const offer = entry.legacyCleanupOffer(this.#options.pruneVariables ?? DEFAULT_PRUNE)
        if (offer !== undefined) {
          this.#options.broadcast({ type: 'cleanup.offer', chatId, ...offer })
        }
        return { view: this.#viewOf(entry) }
      },

      'chat.delete': async ({ chatId }) => {
        chats.cached(chatId)?.abort()
        await chats.delete(chatId)
        await settings.forget(chatId)
        /*
         * And its place on the shelf, for the reason the star list is forgotten
         * when a card is deleted: chat ids are minted against the files that
         * exist, so this id can be handed to the next conversation of the same
         * name — and a position left behind would seat a stranger exactly where
         * the deleted one used to be.
         */
        await this.#options.chatOrder?.forget(chatId)
        await this.#announceChats()
        return {}
      },

      'chat.answerCleanup': async ({ chatId, answer }) => {
        const entry = await chats.open(chatId)
        const prune = this.#options.pruneVariables ?? DEFAULT_PRUNE

        // Recorded under upstream’s key, because it is the user’s decision and
        // it has to survive a move between the two hosts.
        if (answer === 'never') {
          const recorded = entry.recordCleanupRefusal()
          if (recorded) await chats.save(entry)
          return { cleaned: 0, recorded }
        }

        let backup: string | undefined
        if (answer === 'backup-and-clean') {
          try {
            backup = await chats.backup(chatId)
          } catch (cause: unknown) {
            // **Nothing is swept.** The backup is the whole reason this answer
            // differs from "clean only": a user who asked for one and did not get
            // it has not consented to the sweep that was supposed to follow it.
            this.#report(cause, { kind: 'variables', grade: 'fault', chatId })
            throw cause
          }
        }

        const cleaned = entry.sweepLegacy(prune, message => {
          this.#report(message, { kind: 'variables', grade: 'note', chatId, irreversible: true })
        })
        await chats.save(entry)
        return { cleaned, recorded: false, ...backup === undefined ? {} : { backup } }
      },

      'chat.rename': async ({ chatId, title }) => {
        const entry = await chats.open(chatId)
        entry.touch({ title })
        await chats.save(entry)
        this.#options.broadcast({ type: 'chat.updated', chatId, view: this.#viewOf(entry) })
        return { chats: await this.#chatList() }
      },

      /*
       * Store the order the reader arranged, and answer with the list it makes.
       *
       * **Every id is checked against the profile first, and one bad id refuses
       * the whole request.** A partial write would be the worst outcome
       * available here: the caller sent a sequence it had just laid out, so an
       * id the host does not have means the two disagree about what the profile
       * contains — and silently dropping it would store an arrangement the
       * reader never made and can only discover by noticing a row in the wrong
       * place. Refusing names the id.
       *
       * An empty order clears the arrangement, which is the way back to
       * newest-first and the reason this method needs no second spelling.
       */
      'chat.reorder': async ({ order }) => {
        const store = this.#chatOrder()
        const known = new Set(await chats.ids())
        const missing = order.filter(chatId => !known.has(chatId))
        if (missing.length > 0) {
          throw notFound(`no chat "${missing[0] ?? ''}" — the order was not stored`)
        }
        const stored = await store.set(order)
        await this.#announceChats()
        return { chats: await this.#chatList(), ordered: stored.length > 0 }
      },

      'chat.search': async ({ query, caseSensitive, limit }) => ({
        hits: await chats.search(query, {
          ...caseSensitive === undefined ? {} : { caseSensitive },
          ...limit === undefined ? {} : { limit },
        }),
      }),

      // Beside `chat.search` because it is the same scan, and the reason it is
      // not a `chat.` method at all is that it is not about a chat: it answers
      // across every conversation in the profile, and naming it `chat.usage`
      // would invite a `chatId` parameter that would make it a fourth way to
      // read one conversation's total.
      'usage.summary': async ({ since, until, granularity }) => ({
        summary: await chats.usageSummary({
          ...since === undefined ? {} : { since },
          ...until === undefined ? {} : { until },
          ...granularity === undefined ? {} : { granularity },
        }),
      }),

      'chat.send': async ({ chatId, kind, text }) => {
        // The wire schema has already enforced which kind carries text; this
        // branch is where the request becomes the one start call it means.
        if (kind === 'continue') return { turn: await this.#start(chatId, { kind: 'continue' }) }
        if (kind === 'impersonate') return { turn: await this.#start(chatId, { kind: 'impersonate' }) }
        return { turn: await this.#start(chatId, { kind: 'send', text: text as string }) }
      },

      'chat.regenerate': async ({ chatId }) => ({ turn: await this.#start(chatId, { kind: 'regenerate' }) }),

      'chat.compact': async ({ chatId }) => {
        const entry = await this.#idle(chatId, 'compacted')
        // Retention zero, which is the harness's manual case: everything but
        // the newest floor. A manual `/compact` is a reader saying "this is too
        // long now", and honouring the automatic tail budget would answer a
        // question they did not ask.
        const compacted = await this.#compact(entry, 0)
        // Announced rather than only returned: a compaction changes what every
        // open view of this conversation says about its capacity, and the
        // caller is not necessarily the only one looking.
        return { view: this.#announceChat(entry), compacted }
      },

      'chat.abort': ({ chatId }) => {
        // Deliberately tolerant of an unknown chat: stopping something that is
        // not running is the outcome the caller asked for either way.
        chats.cached(chatId)?.abort()
        return Promise.resolve({})
      },

      'chat.swipe': async ({ chatId, turn, index }) => {
        const entry = await this.#idle(chatId, 'swiped')
        try {
          selectCandidate(entry.session, turn, index)
        } catch (cause: unknown) {
          if (cause instanceof SwipeError) throw invalid(cause.message)
          throw cause
        }
        entry.touch()
        await chats.save(entry)
        return { view: this.#announceChat(entry) }
      },

      'chat.editMessage': async ({ chatId, id, text }) => {
        const entry = await this.#idle(chatId, 'edited')
        return { view: await this.#rewriteLines(entry, [{ messageId: id, message: text }]) }
      },

      'script.setChatMessages': async ({ chatId, messages }) => {
        // Through `#idle` like a user's edit. A card rewriting the floor it just
        // produced runs after `stream.end`, and `entry.finish()` is called before
        // that event goes out — checked, not assumed — so the guard does not
        // stand in the way of the ordinary case while still refusing a rewrite
        // that would race a turn.
        const entry = await this.#idle(chatId, 'rewritten by a script')
        // **The rewrite arm is where a large rollback is decided** — a replay
        // batch handing floors back older text — so the pre-change state is
        // copied here, while the disk still holds it. Deduped: the next arm of
        // the same batch would otherwise copy the same unchanged disk again.
        await this.#snapshotBefore(chatId, entry.meta.characterId, 'rewrite-messages', true)
        // Not persisted here; see `#rewriteLines`. A card commits its batch with
        // `script.saveChat`, which is the one place that decision lives.
        return { view: await this.#rewriteLines(entry, messages, false) }
      },

      'script.evalTemplate': async ({ chatId, content }) => {
        // Refused by name when the feature is off, never answered with an empty
        // string. A card asking for a render and receiving `''` cannot tell that
        // from a template that rendered to nothing, and would go on to inject
        // the emptiness.
        const templates = this.#options.templates
        if (templates === undefined) {
          throw new AppError(
            'unsupported',
            'script.evalTemplate needs the template feature, which this host is running without',
          )
        }

        const entry = await chats.open(chatId)
        const turn = entry.pending?.turn ?? 0
        this.#traceId += 1

        // Evaluated in the forked child, exactly like a prompt slot — same
        // fence, same empty environment, same deadline. There is deliberately
        // no shorter path for a single string: a second evaluator would be a
        // second thing to keep sandboxed, and it is the sandbox that is the
        // whole point of this arm.
        //
        // The origin is labelled apart from `generate/…` so a diagnostic can
        // say which door a template came through. What it cannot say is what
        // the card *put* in the string — a world book entry the card read and
        // handed over arrives here identical to a template the card wrote, so
        // this label distinguishes the call path, not the material.
        const outcome = await evaluateBatch({
          items: [{ id: 'eval', text: content, origin: `script.evalTemplate/${chatId}` }],
          snapshot: buildSnapshot(entry, turn, this.#traceId),
          ...templates.deadlineMs === undefined ? {} : { deadlineMs: templates.deadlineMs },
        })

        const result = outcome.results[0]?.result
        if (result === undefined || !result.ok) {
          const reason = result === undefined
            ? outcome.timedOut ? 'the evaluator timed out' : 'the evaluator returned nothing'
            : result.error
          // Thrown, so the façade can do what upstream does: warn and keep the
          // caller's original text. Swallowing it here would decide that policy
          // for every caller, in the one place that cannot see who is asking.
          throw invalid(`template evaluation failed: ${reason}`)
        }

        // **Writes are applied, and every one of them is reported.**
        //
        // The first version of this refused them, on the reasoning that the `Op`
        // channel was built for world book and preset templates whose text comes
        // from installed files. That reasoning was right about the trust
        // asymmetry and wrong about the consequence. Measured: the corpus's 18
        // books hold 8 entries carrying writes, and the one card that actually
        // calls `evalTemplate` is rendering **world book content** with it —
        // its `renderEntry` can reach 16 entries, one of which
        // (`[EJS]末日世界观`) both templates and writes.
        //
        // So refusing, or discarding, does not close a hole: it makes a write
        // that upstream performs **stop happening**, on a card that works there.
        // That is a divergence dressed as a fix, and the failure it creates is
        // the quiet kind — the card renders, the variable never moves, and
        // nothing connects the two.
        //
        // What the route genuinely lacks is not authority but **visibility**:
        // a card-supplied string reaching the same writer as an installed file
        // should not do so silently. So each op is named on the way through.
        // See `notes/packages/iris-app-service/DEVIATIONS.md` for the three options and why this one.
        if (outcome.ops.length > 0) {
          const before = entry.header.chat_metadata
          for (const performed of outcome.ops) {
            // Named individually rather than counted: "a template wrote" is not
            // actionable, "a card's template set `global` scope `x`" is. The
            // scope is the part that matters — it is what says how far the
            // write reaches beyond the card that made it.
            const scope = 'scope' in performed ? ` ${performed.scope}` : ''
            const key = 'key' in performed ? ` ${performed.key}` : ''

            // `saveMetadata` carries a **clone of the whole of**
            // `chat_metadata` and lands as a wholesale replacement, so its
            // payload is the wrong thing to print — a single floor's variables
            // reach 282 KiB in the corpus and this is the same order. Which
            // top-level keys moved is both readable and the actual semantics of
            // a replace.
            let detail = ''
            if (performed.op === 'saveMetadata') {
              const after = performed.value as Record<string, unknown>
              const keys = new Set([...Object.keys(before), ...Object.keys(after ?? {})])
              const moved = [...keys].filter(name =>
                JSON.stringify(before[name]) !== JSON.stringify(after?.[name])).sort()
              detail = moved.length === 0 ? ' (no top-level key changed)' : ` on ${moved.join(', ')}`
            }

            this.#report(
              `a card's template performed ${performed.op}${scope}${key}${detail}`,
              { kind: 'template', grade: 'note', chatId, ...entry.meta.characterId === undefined ? {} : { characterId: entry.meta.characterId } },
            )
          }
          try {
            applyOps(entry, outcome.ops, turn,
              reason => { this.#report(reason, { kind: 'template', grade: 'fault', chatId }) })
          } catch (error: unknown) {
            this.#report(error, { kind: 'template', grade: 'fault', chatId })
          }
        }

        return { text: result.text }
      },

      'script.replaceScriptButtons': async ({ characterId, scriptId, buttons }) => {
        // Refused rather than answered when there is nowhere to keep it. A
        // script told its rearrangement succeeded, on a host that dropped it,
        // would rebuild the panel from a table that never changed and have
        // nothing to look at.
        const store = this.#options.scriptButtons
        if (store === undefined) {
          throw new AppError(
            'unsupported',
            'script.replaceScriptButtons needs a button store, which this host is running without',
          )
        }

        // The card must declare the script. Writing an override for an id the
        // card does not have would create state nothing can ever read — the
        // snapshot only carries declared ids — and would look like it worked.
        const card = await library.load(characterId)
        const declared = extractScripts(card).scripts.find(script => script.id === scriptId)
        if (declared === undefined) {
          throw notFound(`character "${characterId}" declares no script "${scriptId}"`)
        }

        await store.set(characterId, scriptId, buttons)
        return { buttons: await store.get(characterId, scriptId) ?? [] }
      },

      'script.getPreset': async ({ name }) => {
        /*
         * **Any name, not just `'in_use'`.** This arm used to refuse every
         * other name with "this host only carries the one in use", which was
         * true of the host that had no preset library and stopped being true
         * when one landed: `store.read` answers a name and `preset.select`
         * switches to it, so a card asking for `'预设A'` is asking for
         * something this host has. The refusal that remains is the honest one —
         * a name the library does not carry, thrown with the name in it, which
         * is the shape upstream's own `throw Error("预设 '…' 不存在")` gives a
         * card's `catch`.
         *
         * Whole and untrimmed, unlike the copy on the snapshot: this is one
         * round trip on demand, so the extension sub-trees the per-frame clone
         * cannot afford are a cost only the caller who asked for it pays. Which
         * matters beyond reading — every write member upstream is a
         * read-modify-write over the whole `Preset`, and a partial read here
         * would have a card save back a preset with its settings replaced by
         * nothing.
         */
        return { preset: await this.#presetByName(name) as unknown as Record<string, unknown> }
      },

      'script.createChatMessages': async ({ chatId, messages, insertAt }) => {
        const entry = await this.#idle(chatId, 'appended to by a script')
        const lines = entry.toFile().messages

        // Clamped and handed to `splice` still signed, exactly as upstream does
        // (`_.clamp(insert_before, -chat.length, chat.length)` then
        // `chat.splice(insert_before, …)`). `splice` reads a negative index from
        // the end, so converting it here would be a second interpretation of the
        // same number.
        const requested = insertAt ?? lines.length
        const clamped = Math.min(Math.max(requested, -lines.length), lines.length)
        const at = clamped < 0 ? lines.length + clamped : clamped

        const created = messages.map(message => ({
          name: message.name,
          is_user: message.is_user,
          mes: message.mes,
          ...message.is_system === undefined ? {} : { is_system: message.is_system },
          ...message.extra === undefined ? {} : { extra: message.extra },
          // Upstream stores the floor's layer at `variables[0]`. `variables` is
          // not a modelled key, so it rides through `iris/st-meta` and comes
          // back on export unchanged.
          ...message.variables === undefined ? {} : { variables: [message.variables] },
        }))
        lines.splice(at, 0, ...created)

        // Lines before the insertion keep their identity; lines after it shift
        // by however many arrived; the new ones have no source, so they mint
        // fresh keys and carry no inherited variables.
        entry.rebuild(lines, index =>
          index < at ? index : index >= at + created.length ? index - created.length : undefined)
        // The same reattachment a reload performs. Without it a message created
        // with `variables` reads back as the *inherited* table while the process
        // lives, and as its own table after a restart — the same call answering
        // differently depending on when it is asked. `rebuild` carries variables
        // by position, and a newly created line has no position to carry from,
        // so the table has to be put back explicitly exactly as `hydrateVariables`
        // does on open. Reused rather than reimplemented: a second copy of this
        // walk is a second thing that can disagree with a reload.
        if (created.some(line => line.variables !== undefined)) {
          // Reported through the same channel as a fold rejection: a table
          // dropped for want of a candidate is the one way this call can
          // half-succeed, and the card would otherwise read its own write back
          // as an inherited value with nothing anywhere saying why.
          entry.hydrateVariables(lines, message => { this.#report(message, { kind: 'variables', grade: 'fault', chatId }) })
        }
        entry.touch()

        // Deliberately not saved. A card's replay batch is heterogeneous, so a
        // per-arm flag would put "who writes the file" wherever the last
        // operation happened to land; `script.saveChat` is one decision in one
        // place and is what a card calls upstream anyway.
        return { view: this.#announceChat(entry) }
      },

      'script.deleteChatMessages': async ({ chatId, messageIds }) => {
        const entry = await this.#idle(chatId, 'deleted from by a script')
        const lines = entry.toFile().messages

        // Sorted and de-duplicated, then resolved **all against this one
        // snapshot** — upstream's `_.pullAt`. Applying them one at a time would
        // read each later index against an already-shortened list, which is a
        // different operation that also succeeds; see the contract for why both
        // exist.
        const ids = [...new Set(messageIds)].sort((left, right) => left - right)
        for (const id of ids) {
          if (lines[id] === undefined) throw notFound(`this chat has no message ${String(id)}`)
        }

        // **Validated first, copied second**: a batch naming a floor that is
        // not there is refused whole, and only a batch that will actually run
        // costs a copy. Taken while the disk still holds every floor the batch
        // is about to remove; deduped like the rewrite arm beside it.
        await this.#snapshotBefore(chatId, entry.meta.characterId, 'delete-messages', true)

        const removed = new Set(ids)
        const sources = lines.map((_line, index) => index).filter(index => !removed.has(index))
        const kept = lines.filter((_line, index) => !removed.has(index))
        entry.rebuild(kept, index => sources[index])
        entry.touch()
        return { view: this.#announceChat(entry) }
      },

      'chat.deleteMessage': async ({ chatId, id }) => {
        const entry = await this.#idle(chatId, 'edited')
        const { messages } = entry.toFile()
        if (messages[id] === undefined) throw notFound(`this chat has no message ${String(id)}`)

        // **A deletion is one of the operations a snapshot exists for.** Taken
        // before the save, the copy holds exactly what the floor was about to
        // leave. A snapshot that cannot be written also stops the deletion —
        // the same rule the cleanup sweep keeps: losing the safety net silently
        // would be worse than being told the disk said no.
        await this.#snapshotBefore(chatId, entry.meta.characterId, 'delete-message', false)

        messages.splice(id, 1)
        // Everything after the hole shifts down by one; everything before keeps
        // its place. The mapping is what lets each reply keep its own variables.
        entry.rebuild(messages, index => index < id ? index : index + 1)
        entry.touch()
        await chats.save(entry)
        const view = this.#announceChat(entry)
        await this.#announceChats()
        return { view }
      },

      'chat.branch': async ({ chatId, id, swipeId }) => {
        // Idle only: branching reads the chat-file projection and rewrites the
        // parent's `extra.branches`, and a turn landing mid-way would put the
        // branch point somewhere the user did not choose.
        await this.#idle(chatId, 'branched')
        const child = await chats.branch(chatId, id, swipeId)
        const view = this.#viewOf(child)
        this.#options.broadcast({ type: 'chat.updated', chatId, view: this.#viewOf(await chats.open(chatId)) })
        return { view, chats: await this.#chatList() }
      },

      'chat.import': async ({ filename, content, characterId }) => {
        const chat = await chats.importFile(filename, content, characterId)
        // The list is pushed, not only returned: the new conversations belong
        // in the sidebar the moment they exist, on every open page.
        await this.#announceChats()
        return { chat }
      },

      'chat.export': ({ chatId }) => chats.exportFile(chatId),

      'prompt.itemize': async ({ chatId, turn }) => {
        const entry = await chats.open(chatId)
        // A record when there is one, a preview otherwise — including for a turn
        // whose record went when the chat last closed. `preview` says which.
        const recorded = turn === undefined ? undefined : entry.itemizations.get(turn)
        return { itemization: recorded ?? await this.#previewItemization(entry) }
      },

      'prompt.divergence': async ({ chatId, seq }) => {
        // **The chat is not opened.** Unlike `prompt.itemize`, which assembles a
        // preview and therefore needs the live entry, this reads two files the
        // profile already holds — so it answers for a conversation nobody has
        // opened, and it cannot be the call that loads a 244 KB chat into
        // memory. The id is still checked, by the store, through the same
        // `fileFor` guard a chat file's name goes through.
        const store = this.#options.cacheTrace
        if (store === undefined) return {}
        const divergence = await store.divergence(chatId, seq)
        // Absent rather than refused: "this conversation has fewer than two
        // recorded requests" is the ordinary state of a chat that has just
        // started, and of every chat if the record is switched off. A refusal
        // would put a failure in front of a user who has done nothing wrong.
        return { ...divergence === undefined ? {} : { divergence } }
      },

      'script.getVariables': async ({ chatId, scope, messageId, scriptId }) => {
        const entry = await chats.open(chatId)
        return {
          variables: entry.variables.getVariables(
            variableOptionFor(scope, turnForMessage(entry, messageId), scriptId)),
        }
      },

      'script.setVariables': async ({ chatId, scope, messageId, scriptId, op, variables, path }) => {
        const entry = await chats.open(chatId)
        const option = variableOptionFor(scope, turnForMessage(entry, messageId), scriptId)

        if (op === 'delete') {
          if (path === undefined) throw invalid('a delete needs the path to remove')
          // `_.has('a.constructor.b')` walks the prototype chain, so an
          // unfiltered delete answers `delete_occurred` for a path that was
          // never in the table. Refused with this face's own vocabulary.
          const blocked = forbiddenSegmentIn(path)
          if (blocked !== undefined) {
            throw invalid(`the path "${path}" walks through "${blocked}", which cannot be used as a variable key`)
          }
          entry.variables.deleteVariable(path, option)
        } else {
          if (variables === undefined) throw invalid(`"${op}" needs a variables object`)
          // Through the host's own guard, like every other write a card makes.
          assertStorable(variables, 'variables')
          // The merge rules stay here, where they are already tested: incoming
          // wins for insertOrAssign (arrays replaced whole, not merged),
          // existing wins for insert.
          if (op === 'replace') entry.variables.replaceVariables(variables, option)
          else if (op === 'insertOrAssign') entry.variables.insertOrAssignVariables(variables, option)
          else entry.variables.insertVariables(variables, option)
        }

        entry.touch()
        await chats.save(entry)
        this.#options.broadcast({ type: 'chat.updated', chatId, view: this.#viewOf(entry) })
        return { variables: entry.variables.getVariables(option) }
      },

      'script.swipeTo': async ({ chatId, messageId, swipeIndex }) => {
        const entry = await this.#idle(chatId, 'swiped')
        // A card addresses a message by its index; swiping addresses a turn.
        const turn = lineTurns(entry.session)[messageId]
        if (turn === undefined) throw notFound(`this chat has no message ${String(messageId)}`)

        try {
          selectCandidate(entry.session, turn, swipeIndex)
        } catch (cause: unknown) {
          if (cause instanceof SwipeError) throw invalid(cause.message)
          throw cause
        }
        entry.touch()
        await chats.save(entry)
        return { view: this.#announceChat(entry) }
      },

      'script.slash': async ({ chatId, command }) => {
        // Parsed here, once. The browser forwards the string verbatim because
        // the escape rule must have exactly one implementation.
        const commands = parseSlashCommands(command)
        const names = commands.map(entry => entry.name)

        // A lone `/trigger` is upstream's "make the model answer the chat now"
        // (`/trigger`, script.js: "Clicks the send button"): reply to whatever
        // the newest line is. Measured call site: a card that has just landed
        // its own user line — `createChatMessages` appends without generating,
        // by design — then asks for the reply with this command. A reroll of
        // the newest turn is the one Iris word for that: a turn whose newest
        // line is a user message has no candidate yet, so `regenerate` writes
        // its first; a turn that already has one gets the next swipe, which is
        // what pressing send on an AI-last chat does upstream too.
        if (names.length === 1 && names[0] === 'trigger') {
          await this.#start(chatId, { kind: 'regenerate' })
          return { result: '' }
        }

        // The corpus's other pattern, and the only one with a meaning Iris can
        // honour exactly. A lone `/send` means "insert without generating", and
        // treating it as this pair would start a generation the card explicitly
        // did not ask for — spending the user's tokens. Doing more silently is
        // worse than doing less.
        if (names.length !== 2 || names[0] !== 'send' || names[1] !== 'trigger') {
          throw new AppError(
            'unsupported',
            `only "/trigger" and "/send <text>|/trigger" are supported; got "${names.map(name => `/${name}`).join('|')}". `
            + 'A lone /send would need a method that inserts without generating, which does not exist yet.',
          )
        }

        const first = commands[0]
        if (first?.name !== 'send') throw invalid('the pipeline lost its /send')
        await this.#start(chatId, { kind: 'send', text: first.text })
        // Upstream resolves with the pipeline's result; this pair produces none.
        return { result: '' }
      },

      'connection.list': async () => ({
        ...await this.#connections().list(),
        host: this.#hostDefaultRow(),
      }),

      'connection.save': async (input) => {
        // `adoptHostKey` used to be read here, copying the process's own
        // environment credential into the profile being saved — the 存为供应商
        // button's whole implementation. The button and the flag are gone
        // (host §61); the copy lives in `importLaunchConnection()`, which does
        // it once at first start rather than on a press.
        const saved = await this.#connections().save({
          provider: input.provider,
          model: input.model,
          ...input.id === undefined ? {} : { id: input.id },
          ...input.label === undefined ? {} : { label: input.label },
          ...input.preset === undefined ? {} : { preset: input.preset },
          ...input.sampling === undefined ? {} : { sampling: input.sampling },
          ...input.baseURL === undefined ? {} : { baseURL: input.baseURL },
          // Passed through untouched: the merge-or-clear decision belongs to the
          // store, which is the only place that can still see the stored key.
          ...input.apiKey === undefined ? {} : { apiKey: input.apiKey },
          ...input.apiKeyHeader === undefined ? {} : { apiKeyHeader: input.apiKeyHeader },
          ...input.models === undefined ? {} : { models: input.models },
          ...input.modelContexts === undefined ? {} : { modelContexts: input.modelContexts },
        })
        return { ...saved, host: this.#hostDefaultRow() }
      },

      'connection.delete': async ({ id }) => {
        const store = this.#connections()
        // Read **before** the deletion: the route a profile is served under is
        // derived from its own values (`routeOf`), and after the splice there is
        // nothing left to derive it from.
        const route = routeOf(await store.get(id))
        const listed = await store.delete(id)
        // The settings layers store `provider` as a reference to that route, and
        // nothing used to clean them: the reference outlived the profile, so the
        // next generation on that layer reached the adapter registry and failed
        // there — a message about a registry, from a conversation whose settings
        // the user had never touched since (measured 2026-09-09; host §59).
        //
        // Only when the route has genuinely lost its last owner: the
        // composition's own route and a sibling profile of the same provider are
        // both still served, and clearing a layer that names one of those would
        // undo a choice the deletion did not touch.
        const cleared = this.#routeStillServed(route, listed.profiles)
          ? { global: false, chats: [] }
          : await this.#options.settings.clearProviderRoute(route)
        if (cleared.global || cleared.chats.length > 0) {
          const where = [
            ...cleared.global ? ['the global route returns to the host\'s own'] : [],
            ...cleared.chats.length === 0
              ? []
              : [`${String(cleared.chats.length)} conversation(s) lose their route override`],
          ]
          // A note rather than a fault: this is the deletion doing its job. The
          // line exists because the *model* and sampling those layers were given
          // by the same activation deliberately stay — so a reader who sees a
          // conversation's model unchanged and its route changed can find out
          // why without reading this file.
          this.#report(
            `deleting the connection served under route "${route}" cleared the settings layers naming it: `
            + `${where.join(', ')} (the model and sampling it applied are values, not references, and stay)`,
            { kind: 'host', grade: 'note' },
          )
        }
        return { ...listed, host: this.#hostDefaultRow(), cleared }
      },

      'connection.activate': async ({ id, chatId }) => {
        const store = this.#connections()
        const profile = await store.get(id)
        // A profile carrying its own endpoint is served by an adapter installed
        // for it **now** — no host restart, and two profiles of one provider
        // take turns by replacing the registration. The route it installs under
        // is what the settings patch then names, so generation reaches the
        // adapter that can actually see this profile's endpoint and key.
        const route = routeOf(profile)
        if (profile.baseURL !== undefined && profile.baseURL.length > 0) {
          this.#installConnectionFor(route, { ...profile, baseURL: profile.baseURL })
        }
        // Applied through `settings.set`, so a profile cannot install a value
        // that setting it by hand would have been refused.
        const applied = await settings.set(chatId, ConnectionStore.patchOf(profile, route))
        // The profile's bound preset comes with it — upstream's
        // `bind_preset_to_connection`, which defaults to true there: switching
        // a connection is switching the preset it was assembled with, and a
        // profile whose summary names a preset while activation ignores it
        // would advertise something it does not do. Only on the **global**
        // layer, matching `patchOf` above; a chat-scoped switch keeps its own
        // mind. A named preset the library does not have is skipped with a
        // report rather than failing the activation: the connection still
        // works, and one absent file must not take it down.
        if (profile.preset !== undefined && chatId === undefined) {
          await this.#activateBoundPreset(profile.preset)
        }
        await store.markActive(id)
        return { settings: applied, activeId: id }
      },

      /*
       * `connection.deactivate` stood here for one day (host §60): clear
       * `activeId` and put the global layer back on the launch route and model,
       * so 「宿主环境」 could be chosen back. The user's ruling of 2026-09-10
       * retires the environment as a connection a person selects, so there is
       * nothing to go back *to* — a generation with no provider in use is
       * refused by name in `#resolveRoute` instead. The last profile stays in
       * use until another one is used or that one is deleted, which is the only
       * remaining way `activeId` becomes absent.
       */

      'connection.test': async (input) => {
        /*
         * One probe; three places the key it sends can come from.
         *
         * The measured problem: nearly every provider shows an API key exactly
         * once, so a form that requires the key to be re-typed before every
         * probe is a form that can be used once and then never again. An absent
         * `apiKey` is therefore a request — "probe with what you already
         * hold" — served from the named profile's store, or from the
         * credential the host process was started with.
         *
         * **The guard that makes that safe is the origin check.** Without it,
         * `{ baseURL: 'https://attacker.example/v1' }` with no key would be an
         * instruction to post the user's stored credential to an endpoint the
         * page chose — the page cannot read the key, but it could still spend
         * it. A key is reused only at the origin it belongs to; pointed
         * anywhere else the probe goes out bare and says `keySource: 'none'`,
         * which the form renders as the missing-key sentence it already has.
         */
        let baseURL: string
        let presetId: string | undefined
        const profile = input.profileId === undefined
          ? undefined
          : await this.#connections().get(input.profileId)
        // The form's own endpoint wins when it sent one: a user editing a saved
        // profile's base URL is testing what they have typed, not what is filed.
        if (input.baseURL !== undefined && input.baseURL.length > 0) {
          baseURL = input.baseURL
          presetId = input.preset ?? profile?.provider
        } else if (profile !== undefined) {
          if (profile.baseURL === undefined || profile.baseURL.length === 0) {
            return {
              ok: false,
              latencyMs: 0,
              keySource: 'none',
              error: {
                code: 'no-endpoint',
                message: 'this profile rides the host\'s configured endpoint and carries none of its own; set a base URL to test it',
              },
            }
          }
          baseURL = profile.baseURL
          // A profile saved from the form names its preset in `provider`.
          presetId = profile.provider
        } else {
          throw invalid('name a saved profile (profileId) or give the endpoint to probe (baseURL)')
        }

        // The address before the key: adoption of a stored or host key compares
        // origins, and an address with no origin would come back `missing-key`
        // — true, but the person's fault is in the address field.
        const badUrl = badUrlVerdict(baseURL)
        if (badUrl !== undefined) return { ...badUrl, keySource: 'none' }

        const resolved = await this.#probeCredential(baseURL, input, profile)
        const preset = presetId === undefined ? undefined : providerPreset(presetId)
        const needsKey = preset?.requiresKey === true
        if (needsKey && (resolved.apiKey === undefined || resolved.apiKey.length === 0)) {
          return {
            ok: false,
            latencyMs: 0,
            keySource: 'none',
            error: {
              code: 'missing-key',
              message: preset === undefined
                ? 'this endpoint needs an API key, and none was given'
                : `a ${preset.id} endpoint needs an API key, and none was given`,
            },
          }
        }
        const verdict = await this.#probeEndpoint({
          baseURL,
          apiKey: resolved.apiKey,
          apiKeyHeader: resolved.apiKeyHeader,
        })
        // A successful probe of a *saved* profile is filed on that profile, so
        // a picker somewhere else has a list without opening this form. Only
        // on success and only with a profile named: recording an empty list
        // after a 401 would say "this endpoint offers nothing".
        if (verdict.ok && verdict.models !== undefined && input.profileId !== undefined) {
          await this.#connections().recordModels(input.profileId, verdict.models, verdict.modelContexts)
        }
        // What the endpoint said about its models' windows is also remembered
        // for the life of this process, keyed by model id, because that is what
        // the *window resolver* reads and it has no profile in hand — a chat
        // carries a model name, not the connection it came from. Only the
        // endpoint's own numbers: a `'table'` entry would be this host telling
        // itself something it can look up again for free, and caching a lookup
        // is how a stale copy of a constant gets born.
        if (verdict.ok && verdict.modelContexts !== undefined) {
          for (const [model, known] of Object.entries(verdict.modelContexts)) {
            // Keyed folded, because the *table* lookup folds and these two are
            // read one after the other by `#modelContext`. An endpoint that
            // lists `DeepSeek-V4-Flash` against settings that say
            // `deepseek-v4-flash` would otherwise miss the probe and fall
            // through to the table, inverting "the endpoint's own answer wins"
            // on nothing but a capital letter.
            if (known.source === 'provider') this.#probedContexts.set(model.trim().toLowerCase(), known)
          }
        }
        // A probe of the host's **own** endpoint used to be filed in memory too,
        // for the 「宿主环境」 row and the capsule's fallback list. Neither exists
        // (host §61), so a bare probe now answers its caller and records
        // nothing: the only list anything reads is a profile's own, above.
        return { ...verdict, keySource: resolved.keySource }
      },

      'preset.list': async () => {
        const store = this.#options.presets
        if (store === undefined) throw new AppError('unsupported', 'this host keeps no preset library')
        // Awaited, not passed: an unawaited promise is truthy, so the response
        // would always claim an install and carry something that serializes to
        // an empty list — the picker would offer nothing with no word as to why.
        const install = await this.#installPresets()
        return {
          presets: (await store.list()).map(name => ({ name })),
          ...this.#activePresetName === undefined ? {} : { active: this.#activePresetName },
          ...install === undefined ? {} : { install },
        }
      },

      'preset.select': async ({ name }) => {
        const store = this.#options.presets
        if (store === undefined) throw new AppError('unsupported', 'this host keeps no preset library')
        const body = await store.read(name)
        await this.#applyPreset(name, body)
        return {
          presets: (await store.list()).map(preset => ({ name: preset })),
          active: name,
          manager: this.#managerView(),
        }
      },

      'preset.view': async () => ({ manager: this.#managerView() }),

      'preset.setEnabled': async ({ id, enabled }) => {
        const item = this.#activePreset.prompts.find(prompt => prompt.identifier === id)
        if (item === undefined) throw notFound(`the active preset has no prompt "${id}"`)
        // Refused, not ignored, for the markers upstream gives no toggle: a
        // silent no-op would read as "the toggle is broken", and the user would
        // be right — the control would appear to do nothing.
        if (!toggleAllowed(item)) throw invalid(`"${item.name ?? id}" is a marker the prompt manager does not allow toggling`)
        const seeded = withSeededOrder(this.#activePreset)
        const group = chosenOrder(seeded)
        if (group === undefined) throw new AppError('unsupported', 'the preset carries no ordering to toggle in')
        const orders = seeded.prompt_order ?? []
        const next = {
          ...seeded,
          prompt_order: orders.map(entry => entry === group
            ? {
                ...group,
                order: group.order.some(candidate => candidate.identifier === id)
                  ? group.order.map(candidate =>
                      candidate.identifier === id ? { ...candidate, enabled } : candidate)
                  // A prompt the ordering omits is off; toggling it on adds it
                  // to the end, which is where the view showed it.
                  : [...group.order, { identifier: id, enabled }],
              }
            : entry),
        }
        return { manager: await this.#persistActivePreset(next) }
      },

      'preset.move': async ({ id, index }) => {
        const seeded = withSeededOrder(this.#activePreset)
        const group = chosenOrder(seeded)
        if (group === undefined) throw new AppError('unsupported', 'the preset carries no ordering to move in')
        // The prompt must exist in the preset; membership in the ordering is
        // repaired rather than required, so a prompt the file's ordering
        // omitted can still be dragged into place (it lands disabled, as the
        // view showed it).
        if (seeded.prompts.some(prompt => prompt.identifier === id) === false) {
          throw notFound(`the active preset has no prompt "${id}"`)
        }
        const rest = group.order.filter(candidate => candidate.identifier !== id)
        const entry = group.order.find(candidate => candidate.identifier === id)
          ?? { identifier: id, enabled: false }
        const clamped = Math.min(Math.max(index, 0), rest.length)
        const moved = [...rest.slice(0, clamped), entry, ...rest.slice(clamped)]
        const orders = seeded.prompt_order ?? []
        const next = {
          ...seeded,
          prompt_order: orders.map(candidate => candidate === group ? { ...group, order: moved } : candidate),
        }
        return { manager: await this.#persistActivePreset(next) }
      },

      'preset.upsertPrompt': async ({ prompt }) => {
        // `main` and `chatHistory` are slots, not text: upstream's edit form
        // allows editing main's content but the marker slots carry no editable
        // body, and letting a write replace `chatHistory`'s (absent) content
        // would produce a prompt item the assembler reads as literal text in
        // the conversation's slot. Refused by name.
        const existing = this.#activePreset.prompts.find(candidate => candidate.identifier === prompt.identifier)
        const identifier = prompt.identifier ?? randomUUID()
        if (existing === undefined && BUILTIN_MARKERS.has(identifier)) {
          throw invalid(`"${identifier}" is a built-in slot; edit the preset file to change it`)
        }
        const item: PromptItem = {
          identifier,
          ...prompt.name === undefined ? {} : { name: prompt.name },
          ...prompt.role === undefined ? {} : { role: prompt.role },
          ...prompt.content === undefined ? {} : { content: prompt.content },
          ...prompt.marker === undefined ? {} : { marker: prompt.marker },
          ...prompt.system_prompt === undefined ? {} : { system_prompt: prompt.system_prompt },
          ...prompt.forbid_overrides === undefined ? {} : { forbid_overrides: prompt.forbid_overrides },
          ...prompt.injection_position === undefined ? {} : { injection_position: prompt.injection_position },
          ...prompt.injection_depth === undefined ? {} : { injection_depth: prompt.injection_depth },
          ...prompt.injection_order === undefined ? {} : { injection_order: prompt.injection_order },
        }
        const prompts = existing === undefined
          ? [...this.#activePreset.prompts, item]
          : this.#activePreset.prompts.map(candidate => candidate === existing ? { ...candidate, ...item } : candidate)
        let next: ChatCompletionPreset = { ...this.#activePreset, prompts }
        // A new prompt joins the end of the ordering, enabled: an addition that
        // does nothing would be the bad kind of surprise. (Upstream appends
        // disabled and relies on its render to reconcile; the visible outcome
        // there is the same row, on, at the end.)
        if (existing === undefined) {
          next = withSeededOrder(next)
          const group = chosenOrder(next)
          const orders = next.prompt_order ?? []
          next = {
            ...next,
            prompt_order: orders.map(entry => entry === group
              ? { ...group, order: [...group.order, { identifier, enabled: true }] }
              : entry),
          }
        }
        return { manager: await this.#persistActivePreset(next) }
      },

      'preset.removePrompt': async ({ id }) => {
        const item = this.#activePreset.prompts.find(prompt => prompt.identifier === id)
        if (item === undefined) throw notFound(`the active preset has no prompt "${id}"`)
        // Upstream's rule: system prompts cannot be deleted (`isPromptDeletionAllowed`).
        if (item.system_prompt === true) {
          throw invalid(`"${item.name ?? id}" is a system prompt and cannot be removed`)
        }
        const next: ChatCompletionPreset = {
          ...this.#activePreset,
          prompts: this.#activePreset.prompts.filter(prompt => prompt !== item),
          // An order-less preset stays order-less: `undefined` here would type
          // as "the key present with no value", which is a different file shape
          // than the one the preset came in with.
          ...this.#activePreset.prompt_order === undefined ? {} : {
            prompt_order: this.#activePreset.prompt_order.map(entry => ({
              ...entry,
              order: entry.order.filter(candidate => candidate.identifier !== id),
            })),
          },
        }
        return { manager: await this.#persistActivePreset(next) }
      },

      'preset.save': async ({ name }) => {
        const store = this.#options.presets
        if (store === undefined) throw new AppError('unsupported', 'this host keeps no preset library')
        // The active body, exactly as it stands — that is what "save" means:
        // the manager's state becomes a library preset.
        await store.save(name, this.#activePreset)
        // Saved over the active name? The state is now *that* preset.
        if (this.#activePresetName === undefined || this.#activePresetName === name) {
          this.#activePresetName = name
          await this.#options.settings.setPreset(name, this.#activePreset)
          // The name is what the preset regex allow-list is keyed by, so this
          // write can change whether the active body's tier is even
          // addressable — an unnamed body has no entry it could be permitted
          // under, and saving one under a name the user had already allowed
          // makes its rules live. Open conversations have to be told.
          await this.#refreshRegex()
        }
        return {
          presets: (await store.list()).map(preset => ({ name: preset })),
          active: this.#activePresetName,
        }
      },

      'preset.delete': async ({ name }) => {
        const store = this.#options.presets
        if (store === undefined) throw new AppError('unsupported', 'this host keeps no preset library')
        await store.delete(name)
        // Deleting the active preset leaves the state live — the body is in
        // memory and persisted in the settings file — but unnamed, which is
        // honest: it is no longer a library preset.
        if (this.#activePresetName === name) {
          this.#activePresetName = undefined
          await this.#options.settings.setPreset(undefined, this.#activePreset)
          // And its regex tier stops: the allow-list is keyed by the name that
          // has just gone, so the permission no longer addresses anything. An
          // open conversation would otherwise keep running the deleted
          // preset's rules until it was reopened.
          await this.#refreshRegex()
        }
        const presets = (await store.list()).map(preset => ({ name: preset }))
        return { presets, ...this.#activePresetName === undefined ? {} : { active: this.#activePresetName } }
      },

      'preset.read': async ({ name }) => {
        const store = this.#options.presets
        if (store === undefined) throw new AppError('unsupported', 'this host keeps no preset library')
        const body = await store.read(name)
        return { name, preset: body as Record<string, unknown> }
      },

      'preset.import': async ({ names }) => {
        const store = this.#options.presets
        if (store === undefined) throw new AppError('unsupported', 'this host keeps no preset library')
        const installDir = this.#options.sillyTavernDir
        const outcomes = await store.importFrom(installDir, names)
        const imported = outcomes.filter(outcome => outcome.imported).map(outcome => outcome.name)
        const skipped = outcomes
          .filter((outcome): outcome is Exclude<typeof outcome, { imported: true }> => !outcome.imported)
          .map(outcome => ({
            name: outcome.name,
            reason: outcome.why === 'not-configured' ? 'no SillyTavern install is configured'
              : outcome.why === 'absent' ? 'the install has no preset with this name'
              : outcome.why === 'not-a-preset' ? 'the file is not a Chat Completion preset'
              : 'the file could not be read this time',
          }))
        for (const skip of skipped) {
          this.#report(`preset import skipped "${skip.name}": ${skip.reason}`, { kind: 'host', grade: 'note' })
        }
        return {
          imported,
          skipped,
          presets: (await store.list()).map(preset => ({ name: preset })),
        }
      },

      'preset.importFile': async ({ filename, content }) => {
        const store = this.#options.presets
        if (store === undefined) throw new AppError('unsupported', 'this host keeps no preset library')
        // The bytes are decoded and parsed here rather than in the client, so
        // every refusal is the store's own named reason and no caller can get
        // a different sentence for the same file.
        const text = Buffer.from(content, 'base64').toString('utf8')
        const outcome = await store.importOne(filename, text)
        if (!outcome.imported) {
          this.#report(`preset file import refused "${outcome.name}": ${outcome.reason}`, { kind: 'host', grade: 'note' })
        }
        return {
          outcome,
          presets: (await store.list()).map(preset => ({ name: preset })),
        }
      },

      /**
       * The user's personas. The whole group refuses by name on a host with no
       * persona store — the same line the preset library and card storage draw —
       * because an empty list from a storeless host would read as "configured,
       * none yet" and a settings page would then offer a switch that cannot land.
       */
      'persona.list': async () => this.#personas().list(),

      'persona.get': async ({ id }) => {
        const persona = await this.#personas().get(id)
        return persona === undefined ? {} : { persona }
      },

      'persona.set': async ({ id, name, description, position, depth, role, active }) =>
        this.#personas().upsert({
          ...id === undefined ? {} : { id },
          name,
          ...description === undefined ? {} : { description },
          ...position === undefined ? {} : { position },
          ...depth === undefined ? {} : { depth },
          ...role === undefined ? {} : { role },
          ...active === undefined ? {} : { active },
        }),

      'persona.delete': async ({ id }) => this.#personas().remove(id),

      /**
       * The global regex tier.
       *
       * Every chat runs these before any card's own — upstream's
       * `SCRIPT_TYPES.GLOBAL` — which is why they answer to the profile rather
       * than to a character: the user wrote them once, against every
       * conversation they will ever have.
       */
      'regex.list': async () => {
        const extensionSettings = this.#options.extensionSettings
        if (extensionSettings === undefined) throw new AppError('unsupported', 'this host keeps no global regex store')
        return { scripts: await extensionSettings.globalRegex() }
      },

      'regex.set': async ({ scripts }) => {
        const extensionSettings = this.#options.extensionSettings
        if (extensionSettings === undefined) throw new AppError('unsupported', 'this host keeps no global regex store')
        // A script without an id gets one, the way upstream's importer mints a
        // fresh UUID for every import; one that arrived with an id keeps it, so
        // a toggle or a reorder rewrites the same script rather than replacing
        // it with a stranger that happens to look like it.
        const stored = scripts.map(script =>
          ({ ...script, ...(script.id === undefined ? { id: randomUUID() } : {}) }))
        await extensionSettings.setGlobalRegex(stored)
        await this.#refreshRegex()
        return { scripts: await extensionSettings.globalRegex() }
      },

      'character.list': async () => {
        const characters = await library.list()
        const favorites = this.#options.favorites
        if (favorites === undefined) return { characters }
        // One read, not one per row: the list is the only caller that fans out.
        const starred = new Set(await favorites.list())
        return {
          characters: characters.map(character =>
            starred.has(character.characterId) ? { ...character, favorite: true } : character),
        }
      },

      'character.import': async ({ filename, content }) => ({
        character: await this.#withFavorite(await library.import(filename, content)),
      }),

      'character.delete': async ({ characterId }) => {
        await library.delete(characterId)
        // Every per-character store, not just the ones that happened to have a
        // `forget`. Ids are minted from the card's name against the cards that
        // exist, so deleting one frees its id and the next card imported under
        // that name inherits whatever was left behind. For the script policy
        // that includes `documentGranted` — a grant the user gave to one card
        // would silently apply to another. The favorites are the same shape of
        // leftover: a star keyed by id would light up for a stranger.
        await this.#options.extensionSettings?.forget(characterId)
        await this.#options.scriptButtons?.forget(characterId)
        await this.#options.scriptVariables?.forget(characterId)
        await this.#options.favorites?.forget(characterId)
        await scripts?.forget(characterId)
        // The user's own scripts for this card, and the strongest case in the
        // list: what a reused id would inherit here is arbitrary code, which
        // would then start running in a stranger's conversations.
        await scriptLibrary?.forget(characterId)
        // **`cardStorage` is deliberately not in this list, and it is the one
        // store where forgetting would be wrong.** The others are partitioned
        // *by* character, so a leftover partition is a stale answer waiting for
        // whichever card next takes that id. Card storage is shared across the
        // whole profile — upstream's one `localStorage` per origin — so a key
        // this card wrote may be the key another card reads. Dropping it here
        // would delete a living card's data because a different card was
        // removed. `lastWriter` records who wrote a key last; that is
        // attribution for a report, **not ownership**, and it is not a basis
        // for deletion.
        return {}
      },

      'character.duplicate': async ({ characterId }) => {
        const character = await library.duplicate(characterId)
        // The binding row travels with the copy, so both characters resolve to
        // the same named book — what sharing one `extensions.world` name means
        // upstream. Without this the duplicate's first open would re-materialise
        // its embedded book under a minted name (`… (2)`), and two cards that
        // upstream keeps on one book would quietly grow two that drift.
        const bindings = this.#options.worldbookBindings
        const binding = await bindings?.get(characterId)
        if (bindings !== undefined && binding !== undefined) {
          await bindings.set(character.characterId, binding)
        }
        return { character: await this.#withFavorite(character) }
      },

      'character.rename': async ({ characterId, name }) => ({
        character: await this.#withFavorite(await library.rename(characterId, name)),
      }),

      'character.export': async ({ characterId, format }) =>
        library.exportCard(characterId, format),

      'character.setTags': async ({ characterId, tags }) => ({
        character: await this.#withFavorite(await library.setTags(characterId, tags)),
      }),

      'character.favorite': async ({ characterId, favorite }) => {
        // Refused rather than answered when there is nowhere to remember it: a
        // star that lights up and then vanishes on the next list is worse than
        // an honest refusal, because the first list after a reload disagrees
        // with the toggle the user can still see.
        await this.#favorites().set(characterId, favorite)
        return { characterId, favorite }
      },

      // `overrides` rides along **only when a chat was named**, because the
      // contract makes presence mean scope: `{}` says "this chat overrides
      // nothing" and absent says "you asked the bottom layer, which has nothing
      // to override". Spread rather than a ternary field so an absent value is
      // an absent key, which is what `exactOptionalPropertyTypes` asks for and
      // what a JSON reader testing presence needs.
      'settings.get': ({ chatId }) => Promise.resolve({
        settings: settings.get(chatId),
        ...chatId === undefined ? {} : { overrides: settings.overrides(chatId) },
      }),

      'settings.set': async ({ chatId, settings: patch }) => {
        const applied = await settings.set(chatId, patch)
        return {
          settings: applied,
          ...chatId === undefined ? {} : { overrides: settings.overrides(chatId) },
        }
      },

      // World books that live in their own files rather than inside a card.
      // Reads only: the write half of this family is a ruling item, because
      // replacing a book is a whole-file replacement and the decision about
      // whether Iris performs one at a card's request has not been made.
      // `withCounts` is the panel's call and nothing else's: it opens every
      // book to count it, which is the cost this method's contract exists to
      // keep off the bare listing. The provenance beside each count is read off
      // the materialisation table — one small JSON file — and never by decoding
      // cards, which on this corpus costs two seconds for nineteen of them.
      'worldbook.names': async ({ withCounts }) => {
        const names = await worldbooks?.names() ?? []
        if (withCounts !== true || worldbooks === undefined) return { names }
        const owners = new Map<string, string>()
        for (const [characterId, binding] of Object.entries(await this.#options.worldbookBindings?.all() ?? {})) {
          // First writer wins. Two cards cannot legitimately hold the same
          // materialised name — minting exists to prevent it — so a collision
          // here is a table this host did not write, and picking arbitrarily
          // would make the answer depend on key order.
          if (!owners.has(binding.name)) owners.set(binding.name, characterId)
        }
        return {
          names,
          books: (await worldbooks.summaries()).map(row => ({
            ...row,
            ...owners.has(row.name) ? { fromCharacterId: owners.get(row.name)! } : {},
          })),
        }
      },
      'worldbook.load': async ({ name }) => {
        // Upstream's first line is `if (!name) return;` — an absent answer, not
        // an error and not a null. Mirrored, because MVU's caller reads the two
        // empties differently.
        if (name === '') return {}
        // A host with no store cannot distinguish "no such book" from "no world
        // info at all", and the second is not this call's answer to give. `null`
        // is upstream's "asked and did not get it", which is exactly this case.
        if (worldbooks === undefined) return { book: null }
        const book = await worldbooks.readRaw(name)
        // Upstream returns `null` for a response that was not ok, so a name
        // that resolves to nothing is `null` here rather than an absent key —
        // the absent key is reserved for "you asked for nothing".
        return { book: book ?? null }
      },

      'worldbook.get': async ({ name }) => {
        // A host with no store refuses by name rather than answering with an
        // empty book. An empty book is a real state a book can be in, and
        // reporting "not configured" as "this book has no entries" would let a
        // card conclude the user deleted their world info.
        if (worldbooks === undefined) throw notFound(`world book "${name}"`)
        return { entries: await worldbooks.get(name) }
      },
      'worldbook.globalSelect': async () => ({ names: settings.globalSelect() }),
      'worldbook.setGlobalSelect': async ({ names }) => {
        // Chats already open keep the selection they resolved with. Re-resolving
        // them here would change what a conversation in progress is built from,
        // mid-conversation, which is a bigger surprise than waiting for the next
        // open — and `ChatStore` reads the selection fresh every time.
        await settings.setGlobalSelect(names)
        return { names: settings.globalSelect() }
      },
      'worldbook.replace': async ({ name, entries }) => {
        // Refused rather than answered when there is nowhere to write. A write
        // that reports success without a store is the worst of the three
        // outcomes: the card believes its book was saved and stops keeping the
        // only copy.
        if (worldbooks === undefined) throw notFound(`world book "${name}"`)
        return { entries: await worldbooks.replace(name, entries) }
      },
      // Upstream's `createWorldbook` answers existence with `false` rather than
      // an error — get-or-create is the pattern cards write, and a race between
      // two scripts is a normal outcome, not a failure. A host with no store has
      // no books, so no name can be created: refused, not answered false, on the
      // same line every other write here is drawn.
      'worldbook.create': async ({ name, entries }) => {
        if (worldbooks === undefined) throw notFound(`world book "${name}"`)
        if ((await worldbooks.names()).includes(name)) return { created: false }
        await worldbooks.create(name, entries ?? [])
        return { created: true }
      },
      // Upstream's `setChatLorebook`. The name must resolve before it is bound:
      // a binding with no file behind it makes every later scan silently skip
      // the chat book, which reads as a book that activates nothing. Clearing is
      // expressed as `null`, upstream's own `else` branch.
      'worldbook.bindChat': async ({ chatId, name }) => {
        if (name !== null) {
          if (worldbooks === undefined) throw notFound(`world book "${name}"`)
          if (!(await worldbooks.names()).includes(name)) throw notFound(`world book "${name}"`)
        }
        const entry = await chats.open(chatId)
        if (name === null) delete entry.header.chat_metadata['world_info']
        else entry.header.chat_metadata['world_info'] = name
        entry.touch()
        await chats.save(entry)
        this.#options.broadcast({ type: 'chat.updated', chatId, view: this.#viewOf(entry) })
        const bound = entry.header.chat_metadata['world_info']
        return { name: typeof bound === 'string' ? bound : null }
      },
      'worldbook.settings': async () => ({ settings: this.#options.settings.worldbookSettings() }),
      'worldbook.setSettings': async ({ pluginRevision: _pluginRevision, ...patch }) => ({
        settings: await this.#options.settings.setWorldbookSettings(patch),
      }),
      'worldbook.charNames': async ({ characterId, withCard }) => {
        const card = await library.load(characterId)
        const names = charWorldbookNames(card, settings.charBooks(characterId))
        // `card` is added, never substituted: `primary` stays a fact about the
        // card file, which is what a card script asking this reads it as. The
        // panel's question — which book actually plays here, and how big is it —
        // is a fact about this installation, and the two differ exactly when a
        // materialisation had to mint a name.
        //
        // Asked for, because it costs a book read and a binding-table read that
        // upstream's names-only member has no business charging. Omitted on a
        // host with no store even when asked: "which book plays" has no answer
        // there, and answering `none` would be a claim about the disk rather
        // than an admission that there is no disk to look at.
        if (withCard !== true || worldbooks === undefined) return names
        const binding = await this.#options.worldbookBindings?.get(characterId)
        return {
          ...names,
          card: await cardWorldbookView(card, worldbooks, binding?.name),
        }
      },

      /*
       * The character page's one world-book call, and one per page open is the
       * budget it was designed to.
       *
       * Refused on a host with no book store rather than answered `{books: []}`:
       * the empty list is already this method's answer for a card that carries no
       * world info, and a store-less host giving it would report a fact about a
       * card it never looked at. That is the line every read in this family
       * draws.
       *
       * The extra bindings come from `settings.charBooks`, the same reader
       * `worldbook.charNames` above uses, so the two cannot disagree about which
       * books the user bound to this character.
       */
      'worldbook.charDigest': async ({ characterId }) => {
        if (worldbooks === undefined) {
          throw notFound(`world books for "${characterId}"`)
        }
        const card = await library.load(characterId)
        const binding = await this.#options.worldbookBindings?.get(characterId)
        return {
          books: await cardWorldbookDigest(
            card,
            worldbooks,
            binding?.name,
            settings.charBooks(characterId),
          ),
        }
      },

      // The character's additional bindings, upstream's `world_info.charLore`.
      // The character must exist — a binding for a card that is not there is a
      // caller mistake and should read as one — and each bound name must
      // resolve, for the same reason `bindChat` requires it: a binding with no
      // file behind it is silently skipped by every later scan, which reads as
      // a book that activates nothing rather than as the broken binding it is.
      // An empty list is the unbind-all path and is checked against nothing.
      'worldbook.setCharBooks': async ({ characterId, names }) => {
        const card = await library.load(characterId)
        if (names.length > 0) {
          if (worldbooks === undefined) throw notFound(`world book "${names[0]}"`)
          const known = new Set(await worldbooks.names())
          const missing = names.find(name => !known.has(name))
          if (missing !== undefined) throw notFound(`world book "${missing}"`)
        }
        await settings.setCharBooks(characterId, names)
        return charWorldbookNames(card, settings.charBooks(characterId))
      },

      'script.list': async ({ characterId }) => {
        // A host with no policy store cannot remember an answer, so it must not
        // claim one was given: `scriptsAllowed` stays absent rather than `false`.
        // Absent is "not asked", and a host that cannot store the answer is
        // exactly a host that has never asked.
        //
        // **The library is still listed on such a host.** The two stores answer
        // different questions — the policy store holds the user's decisions
        // about the *card's* code, the library holds the user's own — and
        // folding them together would hide a user's own scripts on a host that
        // merely has no policy file. The character must exist either way, so a
        // list for a card that is not there reads as the caller mistake it is.
        await library.load(characterId)
        const listed = await listAllScripts(characterId)
        if (scripts === undefined) return { scripts: listed, documentGranted: false }
        const allowed = await scripts.scriptsAllowed(characterId)
        return {
          scripts: listed,
          documentGranted: await scripts.documentGranted(characterId),
          // Omitted rather than sent as `undefined`, because the key's absence
          // is the third state and `exactOptionalPropertyTypes` makes the
          // difference a type error rather than a convention.
          ...allowed === undefined ? {} : { scriptsAllowed: allowed },
        }
      },

      /**
       * One card's own regex tier, and whether the user lets it run.
       *
       * Listed **whether or not** it is allowed, which is upstream's own
       * behaviour: `getRegexScripts` defaults to `allowedOnly: false` and only
       * the engine passes `true` (`engine.js:35,346`). A refused tier that
       * answered with an empty list would read as a card carrying no rules, and
       * the control that lets the user change their mind would have nothing to
       * sit beside.
       */
      'regex.scopedList': async ({ characterId }) => {
        if (scripts === undefined) {
          throw new AppError('unsupported', 'script policy is not configured on this host')
        }
        return scripts.scopedRegexView(characterId, await library.load(characterId))
      },

      'regex.setScopedAllowed': async ({ characterId, allowed }) => {
        if (scripts === undefined) {
          throw new AppError('unsupported', 'script policy is not configured on this host')
        }
        // Loaded first, so a decision cannot be stored against an id no card
        // holds: it would be waiting for whatever card next takes that id, the
        // inheritance the policy store's `forget` exists to prevent.
        const card = await library.load(characterId)
        await scripts.setScopedRegexAllowed(characterId, allowed)
        await this.#refreshRegex()
        return scripts.scopedRegexView(characterId, card)
      },

      'regex.setScopedEnabled': async ({ characterId, scriptId, enabled }) => {
        if (scripts === undefined) {
          throw new AppError('unsupported', 'script policy is not configured on this host')
        }
        const card = await library.load(characterId)
        // Refused for a rule the card does not carry, the same gate
        // `script.setEnabled` applies: a policy file accumulating ids from typos
        // and stale cards is a policy file nobody can audit.
        const known = await scripts.scopedRegexView(characterId, card)
        if (!known.scripts.some(row => row.script.id === scriptId)) {
          throw notFound(`${characterId} has no regex script "${scriptId}"`)
        }
        await scripts.setScopedRegexEnabled(characterId, scriptId, enabled)
        await this.#refreshRegex()
        return scripts.scopedRegexView(characterId, card)
      },

      /**
       * The active preset's own regex tier, and whether the user lets it run.
       *
       * Listed whether or not it is allowed, for `regex.scopedList`'s reason —
       * and here the refused state is the *common* one, because this tier
       * arrives off (§53). A panel that showed nothing until it was allowed
       * would leave a reader no way to find out that the preset they just
       * imported carries 18 live rewrite rules.
       */
      'regex.presetList': async () => presetRegexView(),

      'regex.setPresetAllowed': async ({ allowed }) => {
        const store = requirePolicy()
        // The name is what the allow-list is keyed by, so a preset without one
        // cannot be allow-listed at all — refused rather than stored under a
        // manufactured key, which is the same rule the scoped writes keep about
        // ids no card carries.
        const presetName = activePresetName()
        await store.setPresetRegexAllowed(presetName, allowed)
        await this.#refreshRegex()
        return presetRegexView()
      },

      'regex.setPresetEnabled': async ({ scriptId, enabled }) => {
        const store = requirePolicy()
        const presetName = activePresetName()
        // Refused for a rule the preset does not carry, the same gate
        // `regex.setScopedEnabled` applies — and it also refuses one of the
        // rows the reader dropped, which is correct: a switch over a rule that
        // cannot run is a decision with no effect to record.
        const known = await presetRegexView()
        if (!known.scripts.some(row => row.script.id === scriptId)) {
          throw notFound(`preset "${presetName}" has no regex script "${scriptId}"`)
        }
        await store.setPresetRegexEnabled(presetName, scriptId, enabled)
        await this.#refreshRegex()
        return presetRegexView()
      },

      /**
       * The user's own library.
       *
       * With a `characterId`, that card's repository beside the global one; with
       * it absent, the global one alone — what the settings drawer asks for
       * before any conversation is open.
       */
      'scriptLibrary.list': async ({ characterId }) => {
        const store = requireLibrary()
        // The character must exist when one is named, for the reason every
        // per-character read here does: an answer about a card that is not there
        // is a fact about nothing, and the caller wants to know it asked wrongly.
        if (characterId !== undefined) await library.load(characterId)
        return { scripts: await store.views(characterId) }
      },

      'scriptLibrary.read': async ({ scope, characterId, id }) => {
        const store = requireLibrary()
        await requireScopeCharacter(scope, characterId)
        return { script: await store.read(scope, characterId, id) }
      },

      'scriptLibrary.save': async ({ scope, characterId, script }) => {
        const store = requireLibrary()
        await requireScopeCharacter(scope, characterId)
        const id = await store.save(scope, characterId, script)
        return { scripts: await store.views(characterId), id }
      },

      'scriptLibrary.delete': async ({ scope, characterId, id }) => {
        const store = requireLibrary()
        await requireScopeCharacter(scope, characterId)
        await store.delete(scope, characterId, id)
        return { scripts: await store.views(characterId) }
      },

      'scriptLibrary.setEnabled': async ({ scope, characterId, id, enabled }) => {
        const store = requireLibrary()
        await requireScopeCharacter(scope, characterId)
        await store.setEnabled(scope, characterId, id, enabled)
        return { scripts: await store.views(characterId) }
      },

      'script.setScriptsAllowed': async ({ characterId, allowed }) => {
        if (scripts === undefined) throw new AppError('unsupported', 'script policy is not configured on this host')
        // The card must exist. A decision recorded against an id no card holds
        // would be waiting for whatever card next takes that id — the same
        // inheritance this table's `forget` exists to prevent.
        await library.load(characterId)
        return { scriptsAllowed: await scripts.setScriptsAllowed(characterId, allowed) }
      },

      'debug.reports': async ({ since, limit }) => {
        const diagnostics = this.#options.diagnostics
        // Refused rather than answered empty, and this is the one decision in
        // this arm worth arguing. An empty page that still declares its kinds
        // says "collected, and nothing happened" — on a host with no buffer
        // that is false: the reports were produced and thrown away. The page
        // would render "all clear" for a host retaining nothing, which is
        // exactly the failure DEBUG-SURFACE §3.6 exists to prevent, and it is
        // worst here, because this page is what someone opens when they
        // suspect something else is lying.
        if (diagnostics === undefined) {
          throw new AppError('unsupported', 'this host retains no diagnostic reports')
        }
        return diagnostics.read(since, limit)
      },

      /**
       * The user's switch for one script — a card's, or one of their own.
       *
       * Routed by `source`, and the write lands in a different store for each:
       * a card script's switch is the user's *opinion* of someone else's code
       * and belongs in the policy file, while a library script's `enabled` is a
       * field of the script itself. Absent means `'card'`, which is what every
       * caller meant before the library existed.
       */
      'script.setEnabled': async ({ characterId, scriptId, enabled, source }) => {
        // The card is loaded whichever store the write lands in: the answer is
        // the whole list for this character, and a list for a card that is not
        // there is a fact about nothing.
        const card = await library.load(characterId)
        if (source !== undefined && source !== 'card') {
          const store = requireLibrary()
          await store.setEnabled(source, source === 'global' ? undefined : characterId, scriptId, enabled)
          return { scripts: await listAllScripts(characterId) }
        }
        if (scripts === undefined) throw new AppError('unsupported', 'script policy is not configured on this host')
        // Refused for a script the card does not have, rather than stored: a
        // policy file that accumulates ids from typos and stale cards is a
        // policy file nobody can audit.
        const known = await scripts.view(characterId, card, await this.#options.scriptButtons?.all(characterId) ?? {})
        if (!known.some(row => row.id === scriptId)) {
          throw notFound(`${characterId} has no script "${scriptId}"`)
        }
        await scripts.setEnabled(characterId, scriptId, enabled)
        return { scripts: await listAllScripts(characterId) }
      },

      'script.body': async ({ characterId, scriptId, source }) => {
        const card = await library.load(characterId)
        if (source !== undefined && source !== 'card') {
          const store = requireLibrary()
          const mine = await store.find(source, characterId, scriptId)
          if (mine === undefined) throw notFound(`${source} script "${scriptId}"`)
          // The switch is honoured here as it is for a card script below, and
          // for the same reason: a runner that could fetch a switched-off body
          // would make the switch advisory. There is only one switch to check —
          // the user wrote this, so there is no author to disagree with.
          if (!mine.enabled) {
            throw new AppError('unsupported', `"${mine.name}" is switched off`)
          }
          return { content: mine.content }
        }
        const script = extractScripts(card).scripts.find(row => row.id === scriptId)
        if (script === undefined) throw notFound(`${characterId} has no script "${scriptId}"`)
        // The card's own switch and the user's are both honoured here, not only
        // in the list: a runner that could fetch a disabled script's body would
        // make the switches advisory.
        if (scripts !== undefined) {
          const view = (await scripts.view(characterId, card, await this.#options.scriptButtons?.all(characterId) ?? {})).find(row => row.id === scriptId)
          if (view !== undefined && !view.enabled) {
            throw new AppError('unsupported', `"${script.name}" is switched off`)
          }
        } else if (!script.enabled) {
          throw new AppError('unsupported', `"${script.name}" is switched off by the card`)
        }
        return { content: script.content }
      },

      'script.setDocumentGrant': async ({ characterId, granted }) => {
        if (scripts === undefined) throw new AppError('unsupported', 'script policy is not configured on this host')
        // Loaded first so a grant cannot be stored against a card that is not
        // there — a grant outliving its card is a permission with no subject.
        await library.load(characterId)
        return { documentGranted: await scripts.setDocumentGrant(characterId, granted) }
      },

      // The bridge surface. The wire shape is frozen so the browser runner and
      // the host provider can be built against it at once; these throw until
      // the host-side context provider is wired, and throwing is deliberate —
      // a stub that answered plausibly could ship unnoticed, and a card reading
      // an empty context misbehaves silently instead of failing loudly.
      'script.context': async ({ chatId, characterId, messageId }) => {
        const entry = await chats.open(chatId)
        return {
          context: buildCardContext(entry, {
            // The asking card's partition, never the whole store: one card
            // reading another's settings would defeat the per-card grant.
            extensionSettings: await this.#options.extensionSettings?.get(characterId) ?? {},
            // Overrides for this card only, for the same reason: a per-card
            // partition read whole would hand one card another's panel state.
            scriptButtons: await this.#options.scriptButtons?.all(characterId) ?? {},
            globalSelect: settings.globalSelect(),
            // The same source `worldbook.names` answers from, so a book the host
            // seeded from a card's embedded copy is a name here too — the one
            // fact an existence assertion in a card hangs on. The name list backs
            // the synchronous `getWorldbookNames()` and the existence guard on
            // `getChatWorldbookName()`; the stored scan knobs back
            // `getLorebookSettings()`, which must answer what the engine actually
            // runs rather than what a fresh install would run.
            worldbookNames: await worldbooks?.names() ?? [],
            // The chat character's host-stored extra bindings, keyed by the
            // chat's own card — the snapshot describes this chat even when the
            // asking script names another character.
            charBooks: entry.meta.characterId === undefined
              ? []
              : settings.charBooks(entry.meta.characterId),
            worldbookSettings: settings.worldbookSettings(),
            ...cardStorage === undefined ? {} : { storage: await cardStorage.snapshot() },
            characters: await library.list(),
            // —— family①: identity & messages ——
            // The whole persona list, because upstream's four list members ask
            // for exactly that; the key is omitted rather than defaulted when
            // no store is configured, so "no store" and "no personas" stay
            // different answers all the way to the card.
            ...this.#options.personas === undefined
              ? {}
              : { personas: await this.#options.personas.list() },
            // Names and author notes for `getScriptName` / `getScriptInfo`, out
            // of the one listing the panel and the runner already share.
            ...characterId === undefined
              ? {}
              : {
                  scripts: Object.fromEntries(
                    (await listAllScripts(characterId)).map(row => [
                      row.id,
                      { name: row.name, ...row.info === undefined ? {} : { info: row.info } },
                    ]),
                  ),
                },
            ...messageId === undefined ? {} : { messageId },
            onReport: message => { this.#report(message, { kind: 'script', grade: 'note', chatId, characterId }) },
            // —— family②: regex ——
            // The **chat's** card, not the asking one, because that is what
            // upstream's `isCharacterTavernRegexesEnabled()` tests
            // (`characters[this_chid].avatar`) — the same reading `charBooks`
            // above takes. Absent when this host keeps no policy store, which
            // reads as allowed, exactly as `scopedRegex` does.
            ...scripts === undefined || entry.meta.characterId === undefined
              ? {}
              : { characterRegexAllowed: (await scripts.scopedRegex(entry.meta.characterId)).allowed },
            // —— family③: preset ——
            // The three synchronous preset members' source. Read here rather
            // than fetched by the frame because all three return values
            // upstream; a preset switch reaches a live frame through this same
            // field, because `#applyPreset` re-announces every open chat and
            // the shell answers that by refetching this snapshot.
            preset: await this.#presetSnapshot(),
            // —— family③ end ——
          }),
        }
      },

      'script.saveMetadata': async ({ chatId, metadata }) => {
        const entry = await chats.open(chatId)
        commitChatMetadata(entry, metadata)
        entry.touch()
        await chats.save(entry)
        // Echoed back as stored, so a card can see what survived rather than
        // assuming its object round-tripped intact.
        return { metadata: entry.header.chat_metadata }
      },

      'storage.set': async ({ characterId, scriptId, key, value }) => {
        if (cardStorage === undefined) {
          throw new AppError('unsupported', 'card storage is not configured on this host')
        }
        try {
          await cardStorage.set(key, value, {
            characterId,
            ...scriptId === undefined ? {} : { scriptId },
          })
        } catch (error: unknown) {
          if (!(error instanceof QuotaExceeded)) throw error
          // Reported as well as refused. A browser's quota failure tells a card
          // it is full and tells the user nothing about why; the distribution
          // is what turns "storage is full" into something anyone can act on.
          const shares = Object.entries(error.byWriter)
            .sort(([, a], [, b]) => b - a)
            .map(([who, bytes]) => `${who} ${String(Math.round(bytes / 1024))} KiB`)
            .join(', ')
          this.#report(
            `card storage is full (${String(Math.round(error.size / 1024))} KiB); by writer: ${shares}`,
            { kind: 'storage', grade: 'fault', characterId, ...scriptId === undefined ? {} : { scriptId } },
          )
          throw new AppError('quota-exceeded', error.message)
        }
        return { value }
      },

      'storage.remove': async ({ characterId, scriptId, key }) => {
        if (cardStorage === undefined) {
          throw new AppError('unsupported', 'card storage is not configured on this host')
        }
        const removed = await cardStorage.remove(key, { characterId })
        if (removed !== undefined) {
          const note = removalNote(removed, 'remove')
          if (note !== undefined) {
            this.#report(note, {
              kind: 'storage',
              grade: 'note',
              characterId,
              ...scriptId === undefined ? {} : { scriptId },
            })
          }
        }
        return { removed: removed !== undefined }
      },

      'storage.clear': async ({ characterId, scriptId }) => {
        if (cardStorage === undefined) {
          throw new AppError('unsupported', 'card storage is not configured on this host')
        }
        // Upstream's `clear()` empties the whole origin, taking every other
        // card's keys with it. Reproduced — but each key another card wrote is
        // named, because upstream's version of this loss is unattributable.
        const removed = await cardStorage.clear({ characterId })
        for (const report of removed) {
          const note = removalNote(report, 'clear')
          if (note !== undefined) {
            this.#report(note, {
              kind: 'storage',
              grade: 'note',
              characterId,
              ...scriptId === undefined ? {} : { scriptId },
            })
          }
        }
        return { removed: removed.length, foreign: removed.filter(one => one.foreign).length }
      },

      'backup.list': async ({ chatId }) => ({ backups: await this.#backups().list(chatId) }),

      'backup.preview': async ({ backupId, floors }) => ({
        preview: await this.#backups().preview(backupId, floors),
      }),

      'backup.restore': async ({ backupId, confirm }) => {
        const backups = this.#backups()
        const intent = await backups.read(backupId)

        // **The named confirmation, enforced here.** The interface shows the
        // name and the reader types it; a host that accepted a bare call would
        // let anything that can reach the wire overwrite a conversation by
        // trying. Compared against the snapshot's own header, because that is
        // the conversation a restore writes back — not whatever sits at that
        // id now.
        const expected = intent.title.length > 0 ? intent.title : intent.chatId
        if (confirm.trim() !== expected) {
          throw invalid(`restore refused: type the conversation's title ("${expected}") to confirm overwriting it`)
        }

        // The current version is snapshotted first — the task of the restore
        // is to undo a mistake, and a restore that went wrong must itself be
        // restorable. Absent when there is no live file: restoring into the
        // hole a deletion left protects nothing because nothing survives.
        let previous: BackupSummary | undefined
        if (backups.hasChatFile(intent.chatId)) {
          previous = await backups.snapshot(intent.chatId, 'pre-restore', intent.characterId)
        }

        await chats.restoreFile(intent.chatId, intent.text)
        // An open page sees the conversation come back: pushed, not left for
        // the next open to discover.
        const entry = await chats.open(intent.chatId)
        this.#options.broadcast({ type: 'chat.updated', chatId: intent.chatId, view: this.#viewOf(entry) })
        await this.#announceChats()
        return {
          chat: entry.toSummary(),
          ...previous === undefined ? {} : { previous },
        }
      },

      'backup.delete': async ({ backupId }) => {
        await this.#backups().remove(backupId)
        return {}
      },

      'script.setExtensionSettings': async ({ characterId, settings }) => {
        const store = this.#options.extensionSettings
        if (store === undefined) throw new AppError('unsupported', 'extension settings are not configured on this host')
        // The card must exist. A partition written for a card that is not there
        // is storage nobody can find to clear.
        await library.load(characterId)
        assertStorable(settings, 'extensionSettings')
        await store.set(characterId, settings)
        return { settings: await store.get(characterId) }
      },

      'script.saveChat': async ({ chatId }) => {
        const entry = await chats.open(chatId)
        // Deliberately no snapshot here. This arm persists; it decides nothing.
        // The arms that *change* floors — deletion and rewrite — snapshot where
        // the change is decided, while the disk still holds the pre-change
        // state, and a save of an unchanged conversation is not a new restore
        // point. Snapshotting here would copy once more per turn for MVU cards
        // and churn the retention window without protecting anything new.
        entry.touch()
        await chats.save(entry)
        return {}
      },

      'script.setExtensionPrompt': async ({ chatId, key, value, position, depth, role, scan, runId }) => {
        const entry = await chats.open(chatId)
        entry.setExtensionPrompt(key, {
          value,
          position,
          depth,
          ...role === undefined ? {} : { role },
          ...scan === undefined ? {} : { scan },
          ...runId === undefined ? {} : { runId },
        })
        return {}
      },

      'script.runEnded': async ({ chatId, runId }) => {
        const entry = await chats.open(chatId)
        const known = entry.hasScriptRun(runId)
        const cleared = entry.endScriptRun(runId)

        // **Every run end says something, including the quiet ones.** The first
        // version spoke only when it cleared, and two whole cycles of correctly
        // paired ends then produced no line at all — which reads exactly like a
        // mechanism that has stopped working. A zero is the positive evidence
        // that it still runs, and it cannot only appear the first time.
        if (!known) {
          // Deliberately says both possibilities. A run the host was never told
          // about is indistinguishable from a mismatched `(chatId, runId)` pair,
          // because nothing announces a run's start — only its injections do.
          // Naming one of them would be a guess presented as a diagnosis.
          this.#report(
            `run ${runId} ended, but no injection on this chat ever named it: either that run`
            + ' injected nothing, or this chat and run do not belong together',
            { kind: 'script', grade: 'note', chatId },
          )
        } else if (cleared > 0) {
          this.#report(
            `cleared ${String(cleared)} injection(s) left by run ${runId}, as SillyTavern clears`
            + ' its own when a chat is closed',
            { kind: 'script', grade: 'note', chatId },
          )
        } else {
          this.#report(
            `run ${runId} ended with nothing left to clear`,
            { kind: 'script', grade: 'note', chatId },
          )
        }
        return { cleared }
      },

      'script.generate': async ({ chatId, userInput, systemPrompt, maxHistory }) => {
        const entry = await chats.open(chatId)
        return {
          text: await this.#sideGenerate(entry, userInput, systemPrompt, maxHistory),
        }
      },

      'script.generateRaw': async ({ chatId, prompt, systemPrompt }) => {
        const entry = await chats.open(chatId)
        return { text: await this.#generateRaw(entry, prompt, systemPrompt) }
      },

      /**
       * Fetch one allow-listed URL on a card's behalf.
       *
       * **The fetching is `fetchAllowedRemote`'s, not this handler's**, and that
       * is the whole of the 2026-09-11 change (host §69). This handler used to
       * run `checkScriptFetch` on the first hop and then call a fetcher that
       * followed redirects itself, so an allow-listed host answering `302
       * Location: https://evil.example/x.js` lent its allowance to
       * `evil.example` and the foreign body came back as text a card turns into
       * a `blob:` and runs. `ScriptCache` had the same rule written out properly
       * a file away; two executions of an allowlist are worth the weaker one.
       *
       * Nothing here is cached. The disk cache belongs to the bundle route,
       * which stores JavaScript under a seven-day TTL and rewrites it on the way
       * out; this answers whatever a card asked for with the far side's own
       * content type, and measured across both corpora no card fetches an
       * allow-listed URL through this path at all — so there is not one repeat
       * to share, and a shared store would mean a data fetch answered from a
       * week-old copy.
       *
       * The two codes split on *whose* refusal it is: `unsupported` is this
       * host declining — the source is not on the list, the redirect chain is
       * longer than this host follows, the body is bigger than this host will
       * hand a card — and `provider-error` is the far side failing. Neither
       * carries any part of a refused body.
       */
      'script.fetch': async ({ url }) => {
        const result = await fetchAllowedRemote(url, { fetch: this.#options.fetchRemote })
        if (!result.ok) {
          const code = result.kind === 'unreachable' || result.kind === 'bad-status'
            ? 'provider-error'
            : 'unsupported'
          throw new AppError(code, result.reason)
        }
        return {
          content: result.bytes.toString('utf8'),
          ...result.contentType === null ? {} : { contentType: result.contentType },
        }
      },

      // —— family②: regex ——
      /**
       * One tier of regex rules, in the vocabulary a card reads.
       *
       * Upstream's `getTavernRegexes`. Which document each tier lives in is the
       * whole of it, and the three answers are the three storages the composer
       * already reads (`scriptsOf`) — so a card asking what rules exist and a
       * conversation running them cannot be looking at different lists.
       *
       * Never gated. Upstream's reader takes no `allowedOnly`
       * (`get_tavern_regexes_without_clone`), and `regex.scopedList` above
       * answers the same way for the same reason: a refused tier reported as an
       * empty list reads as a document that carries no rules.
       */
      'regex.tavernList': async ({ chatId, tier }) => {
        const entry = await chats.open(chatId)
        return { regexes: (await this.#tavernTier(entry, tier)).map(script => toTavernRegex(script)) }
      },

      /**
       * Replace one tier wholesale, where that tier lives.
       *
       * `'preset'` is refused rather than written: this host's preset library is
       * read-only for a card, and a write reported as done that changed nothing
       * would leave the card believing its rules had been stored. Upstream
       * writes both the in-use `oai_settings` and a named preset file
       * (`src/function/tavern_regex.ts:298-311`).
       */
      'regex.tavernReplace': async ({ chatId, tier, regexes }) => {
        const entry = await chats.open(chatId)
        if (tier === 'preset') {
          throw new AppError(
            'unsupported',
            'a card cannot write the preset regex tier on this host: the preset library is read-only,'
            + ' and the tier is edited from the preset panel',
          )
        }

        // Upstream's own rename, before anything is stored: a rule with no name
        // is unaddressable in every panel that lists one.
        // (`src/function/tavern_regex.ts:261-265`.)
        const named = regexes.map(regex => regex.script_name === ''
          ? { ...regex, script_name: `未命名-${regex.id}` }
          : regex)
        // The stored tier, by id, so every field this vocabulary has no word
        // for survives a card's reorder or toggle — see `fromTavernRegex`.
        const previous = new Map(
          (await this.#tavernTier(entry, tier)).map(script => [tavernRegexId(script), script]),
        )
        const stored = named.map(regex => fromTavernRegex(regex, previous.get(regex.id)))

        if (tier === 'global') {
          const extensionSettings = this.#options.extensionSettings
          if (extensionSettings === undefined) {
            throw new AppError('unsupported', 'this host keeps no global regex store')
          }
          await extensionSettings.setGlobalRegex(stored)
        } else {
          const characterId = this.#tavernCharacter(entry)
          await library.setScopedRegex(characterId, stored)
          // The card *file* changed, and every open conversation on it is
          // holding a decoded copy from before the write. Without this the
          // refresh below recomposes from the old rules — the card would be
          // told its rule was stored and no page would change until the
          // conversation was reopened.
          await chats.refreshCard(characterId)
        }
        // The same refresh every other regex write performs: the composed list
        // each open chat holds is otherwise a fact about the past, and a rule a
        // card just wrote would not reach a page until the chat was reopened.
        await this.#refreshRegex()
        return { regexes: (await this.#tavernTier(entry, tier)).map(script => toTavernRegex(script)) }
      },

      /**
       * Run this chat's regex chain over one string.
       *
       * `entry.scripts` is the chain, which is what makes the answer worth
       * trusting: the same composition, in the same order, with the same gates
       * that produced the text on the reader's page and the text in the last
       * request.
       */
      'regex.tavernFormat': async ({ chatId, text, source, destination, depth, characterName }) => {
        const entry = await chats.open(chatId)
        return {
          text: formatAsTavernRegexed(text, source, destination, entry.scripts, {
            ...depth === undefined ? {} : { depth },
            ...characterName === undefined ? {} : { characterName },
            substitute: entry.substitute,
          }),
        }
      },
      // —— family④: lorebook / worldbook ——
      /*
       * Delete a named book, and say what the deletion left behind.
       *
       * Refused rather than answered `false` on a host with no store, on the
       * line `worldbook.create` draws for the same reason: such a host has no
       * books at all, so `false` — which here means "no book had that name" —
       * would be indistinguishable from the same answer on a host that does
       * keep books. The two lead to different repairs.
       *
       * The global selection is the one binding rewritten, because upstream's
       * own delete splices `selected_world_info` and saves
       * (`world-info.js:4253`). Everything else is left dangling and *named*
       * instead: the report is pushed as irreversible, which is what puts it in
       * front of a reader without their having to ask, and it is the only
       * record that will exist once the file is gone.
       */
      'worldbook.delete': async ({ name }) => {
        if (worldbooks === undefined) throw notFound(`world book "${name}"`)

        // Read before the unlink: after it, "was this selected" is a question
        // about a file nobody can look at.
        const selected = settings.globalSelect()
        const clearedGlobalSelect = selected.includes(name)
        const characters = settings.charactersBindingBook(name)
        const materialisedFor = Object.entries(await this.#options.worldbookBindings?.all() ?? {})
          .filter(([, row]) => row.name === name)
          .map(([characterId]) => characterId)

        const deleted = await worldbooks.remove(name)
        // Nothing was there. No settings write, no report: a delete that
        // removed nothing has nothing to be irreversible about, and reporting
        // it would train the reader to skim the ones that mattered.
        if (!deleted) {
          return { deleted: false, clearedGlobalSelect: false, dangling: { characters: [], materialisedFor: [] } }
        }

        if (clearedGlobalSelect) await settings.setGlobalSelect(selected.filter(row => row !== name))

        const left = [
          ...clearedGlobalSelect ? ['dropped from the global selection'] : [],
          ...characters.length === 0
            ? []
            : [`still bound as an additional book by ${characters.join(', ')}`],
          ...materialisedFor.length === 0
            ? []
            // Named because the consequence is not obvious: such a card falls
            // back to the copy inside the card file
            // (`resolveCardWorldbook`'s rule 2), so it keeps its world info
            // and the user's edits to the deleted book are the thing that is
            // gone.
            : [`was the materialised copy of the embedded book of ${materialisedFor.join(', ')},`
              + ' which now plays from the copy inside the card'],
        ]
        this.#report(
          `world book "${name}" was deleted`
          + (left.length === 0 ? '' : `: ${left.join('; ')}`),
          { kind: 'host', grade: 'note', irreversible: true },
        )

        return { deleted, clearedGlobalSelect, dangling: { characters, materialisedFor } }
      },
      // —— family①: identity & messages ——
      /*
       * One card, projected as Tavern Helper's `getCharacter` projects it.
       *
       * The name is resolved **against this conversation's character and
       * nothing else**. Upstream searches the whole library
       * (`RawCharacter.findIndex`, lower-casing both the name and the avatar
       * id); the same three spellings are accepted here — `'current'`, the
       * card's name, its id — and a fourth that names a real neighbouring card
       * is refused rather than served, because a card script's consent is
       * per card and this member hands over regexes and script bodies.
       */
      'script.getCharacter': async ({ chatId, name }) => {
        const entry = await chats.open(chatId)
        const characterId = entry.meta.characterId
        const card = entry.card
        if (characterId === undefined || card === undefined) {
          throw notFound('this conversation is not played with a character')
        }
        // Folded, as `RawCharacter.findIndex` folds both sides — and because
        // this host's ids are filename-shaped, so two spellings of one id
        // differ only in case on a case-folding filesystem.
        const asked = name.toLowerCase()
        const matches = asked === 'current'
          || asked === characterId.toLowerCase()
          || asked === card.data.name.toLowerCase()
          || asked === entry.header.character_name.toLowerCase()
        if (!matches) {
          throw new AppError(
            'unsupported',
            `getCharacter only answers about this conversation's own character here, not "${name}":`
              + ' a card script is consented to per card, and this member carries the card\'s regexes'
              + ' and script bodies',
          )
        }
        return {
          character: toCardCharacter(
            card,
            characterId,
            charWorldbookNames(card, settings.charBooks(characterId)).primary,
          ),
        }
      },

      /*
       * This character's conversations, newest activity first — the sidebar's
       * own order, which is also the order upstream sorts its brief list into
       * (`getSortedChatList` sorts by file name and reverses; ST names files by
       * creation time, so both read as newest-first).
       */
      'script.chatHistoryBrief': async ({ chatId }) => {
        const entry = await chats.open(chatId)
        const characterId = entry.meta.characterId
        if (characterId === undefined) throw notFound('this conversation is not played with a character')
        const rows = (await chats.list()).filter(row => row.characterId === characterId)
        return {
          chats: rows.map(row => ({
            file_name: `${row.chatId}.jsonl`,
            chat_items: row.messageCount,
            ch_name: entry.header.character_name,
            avatar_url: characterId,
            chatId: row.chatId,
            title: row.title,
            updatedAt: row.updatedAt,
          })),
        }
      },

      /*
       * The named conversations' floors.
       *
       * The allowed set is built first, from this character's own chats, and a
       * file outside it is dropped — the same silence upstream keeps for a file
       * the server will not serve, and the reason it is dropped rather than
       * refused is that a card handing back the rows it was given must not be
       * able to turn one wrong string into a failed call for all fifty.
       */
      'script.chatHistoryDetail': async ({ chatId, files }) => {
        const entry = await chats.open(chatId)
        const characterId = entry.meta.characterId
        if (characterId === undefined) throw notFound('this conversation is not played with a character')
        const mine = new Map(
          (await chats.list())
            .filter(row => row.characterId === characterId)
            .map(row => [`${row.chatId}.jsonl`, row.chatId]),
        )
        const answer: Record<string, ScriptChatMessage[]> = {}
        for (const file of files) {
          // Both spellings, because upstream's own rows carry the extension and
          // its reader strips it again (`file_name.replace('.jsonl','')`), so a
          // card that has done either is asking the same question.
          const id = mine.get(file) ?? mine.get(`${file}.jsonl`)
          if (id === undefined) continue
          const floors = await chats.floorsOf(id)
          if (floors === undefined) continue
          // Without the per-floor variable tables: another conversation's
          // state, the bulk of a chat file, and nothing upstream's consumers
          // of this member read.
          answer[file] = floors.map(({ variables: _variables, ...rest }) => rest as ScriptChatMessage)
        }
        return { chats: answer }
      },

      /*
       * Upstream's floor rotation, spliced on the host's own file.
       *
       * The index arithmetic is upstream's, line for line
       * (`function/chat_message.ts:468-488`): both ends clamped into
       * `[0, length]`, `middle` clamped into `[begin, end]`, then
       * `splice(middle, end - middle)` and `splice(begin, 0, …)`. A span that
       * collapses is upstream's no-op rather than an error.
       *
       * `rebuild`'s index map is the parallel splice of the *source* indices,
       * so every line's per-swipe variable table travels with the line. That is
       * the whole reason this is a host arm: the frame could only have moved the
       * text.
       */
      'script.rotateChatMessages': async ({ chatId, begin, middle, end }) => {
        const entry = await this.#idle(chatId, 'rotated by a script')
        const lines = entry.toFile().messages
        const at = (index: number): number =>
          Math.min(Math.max(index < 0 ? lines.length + index : index, 0), lines.length)
        const first = at(begin)
        const last = at(end)
        const pivot = Math.min(Math.max(at(middle), first), last)
        if (pivot === first || pivot === last) return { view: this.#viewOf(entry) }

        await this.#snapshotBefore(chatId, entry.meta.characterId, 'rewrite-messages', true)

        const sources = lines.map((_line, index) => index)
        const movedSources = sources.splice(pivot, last - pivot)
        sources.splice(first, 0, ...movedSources)
        const moved = lines.splice(pivot, last - pivot)
        lines.splice(first, 0, ...moved)

        entry.rebuild(lines, index => sources[index])
        entry.touch()
        return { view: this.#announceChat(entry) }
      },
      // —— family③: preset ——

      'script.createOrReplacePreset': async ({ name, preset, ifAbsent }) => {
        const store = this.#options.presets
        if (store === undefined) throw new AppError('unsupported', 'this host keeps no preset library')

        /*
         * `createPreset`'s guard, decided here rather than at the card face.
         *
         * Upstream writes nothing when the name is taken, and the *only* place
         * that decision cannot race is beside the file. `'in_use'` is never
         * free: upstream's `createPreset` signature excludes the name and its
         * own `getPresetNames()` includes it, so the answer there is `false`.
         */
        if (ifAbsent === true && (name === 'in_use' || await store.has(name))) {
          return { created: false, restored: [] }
        }

        /*
         * The trimmed sub-trees go back on first, before anything is written.
         *
         * Upstream's own documented round trip is `const p =
         * getPreset('in_use'); p.settings.should_stream = true; await
         * replacePreset('in_use', p)`, and the `p` a card holds came from the
         * frame's copy, which leaves out `extensions.tavern_helper` and
         * `extensions.regex_scripts` because they are 5 MiB in one real preset
         * and the copy is cloned once per live frame. Writing that body
         * verbatim would delete a preset's script library as a side effect of
         * turning streaming on, and the preset would still load.
         */
        const incoming = preset as unknown as TavernHelperPreset
        const stored = await (async (): Promise<TavernHelperPreset | undefined> => {
          try {
            return await this.#presetByName(name)
          } catch {
            // A name nothing has yet: there is nothing to restore from, which
            // is the ordinary create path rather than a failure.
            return undefined
          }
        })()
        const { preset: merged, restored } = restoreOmittedExtensions(incoming, stored)
        if (restored.length > 0) {
          this.#report(
            `a card wrote preset "${name}" from the copy a frame is handed, so ${restored.join(' and ')} `
            + 'was kept from the stored preset rather than being replaced with nothing',
            { kind: 'script', grade: 'note' },
          )
        }

        let body: ChatCompletionPreset
        try {
          body = fromTavernHelperPreset(merged) as unknown as ChatCompletionPreset
        } catch (error: unknown) {
          /*
           * Upstream throws a bare `Error` for a repeated system or placeholder
           * id (`preset.ts:481`) and lets it out of the member, so a card's
           * `catch` sees it. Answered `invalid-request` with upstream's own
           * sentence: the card's message matches either way, and the wire code
           * says whose fault it was.
           */
          if (error instanceof DuplicatePresetPromptError) throw invalid(error.message)
          throw error
        }

        const created = name === 'in_use' ? false : await store.has(name) === false
        if (name === 'in_use') {
          /*
           * `#applyPreset`, the same path `preset.select` and a connection's
           * bound preset take, so a card's write and the panel's switch cannot
           * mean different things — and specifically so the write refreshes
           * every open conversation's regex tier. A preset carries its own
           * regex rules; a body swapped in without that refresh leaves the
           * *previous* preset's rules rewriting the page with nothing to show
           * it (host §53).
           *
           * The library name is kept: writing to `'in_use'` edits the running
           * body, which is what upstream's `'in_use'` means, and does not save
           * it back to the file it was loaded from — upstream is explicit that
           * those are two acts (`preset.d.ts:152-160`).
           */
          await this.#applyPreset(this.#activePresetName, body)
        } else {
          await store.save(name, body)
          // Saving over the name the running body was loaded from does **not**
          // reload it, for the same reason: upstream's `'in_use'` and its
          // source file are separate, and a card editing the file has not asked
          // for a switch.
        }
        return { created, restored }
      },

      'script.deletePreset': async ({ name }) => {
        const store = this.#options.presets
        if (store === undefined) throw new AppError('unsupported', 'this host keeps no preset library')
        /*
         * `'in_use'` is answered `false`, not obeyed. Upstream's signature
         * excludes it and its `preset_manager.deletePreset` has no entry to
         * remove for it, so a host that deleted the running body here would
         * destroy state on a call upstream answers `false` to.
         */
        if (name === 'in_use') return { deleted: false }
        if (await store.has(name) === false) return { deleted: false }
        /*
         * Through the panel's own arm, not `store.delete`, because deleting the
         * *active* preset has consequences beyond the file: the name goes, and
         * with it the key the preset-regex allow-list is addressed by, so an
         * open conversation would otherwise keep running the deleted preset's
         * rules. One path, one set of consequences.
         */
        await handlers['preset.delete']({ name })
        return { deleted: true }
      },

      'script.renamePreset': async ({ name, newName }) => {
        const store = this.#options.presets
        if (store === undefined) throw new AppError('unsupported', 'this host keeps no preset library')
        if (name === 'in_use') return { renamed: false, reason: 'no-such-preset' as const }
        if (await store.has(name) === false) return { renamed: false, reason: 'no-such-preset' as const }
        /*
         * Refused rather than obeyed, and this is a deliberate divergence.
         *
         * Upstream's `renamePreset` calls `createPreset` — which answers
         * `false` and writes nothing when the target name is taken — and then
         * deletes the source **unconditionally** (`preset.ts:696-703`), so a
         * rename onto an existing name destroys the source and returns `true`.
         * Copying that would make a data loss part of the compatibility floor.
         * Recorded in host §65.
         */
        if (newName === 'in_use' || await store.has(newName)) {
          this.#report(
            `a card asked to rename preset "${name}" to "${newName}", which the library already has — `
            + 'refused, and both presets are still there (upstream would have deleted the first)',
            { kind: 'script', grade: 'note' },
          )
          return { renamed: false, reason: 'name-taken' as const }
        }
        const body = await store.read(name)
        // Written before the removal, so a failure leaves the source standing
        // rather than neither.
        await store.save(newName, body)
        // The panel's arm again: renaming the active preset is a delete of the
        // name the regex allow-list is keyed by.
        await handlers['preset.delete']({ name })
        /*
         * The running body follows its name. `preset.delete` of the active
         * preset leaves the body live and nameless on purpose — honest for a
         * delete, wrong for a rename, where the same preset is still there
         * under a new name. Re-selecting it is what makes
         * `getLoadedPresetName()` answer the new name, which is what upstream's
         * rename leaves behind.
         */
        if (this.#activePresetName === undefined) await handlers['preset.select']({ name: newName })
        return { renamed: true }
      },

      'script.loadPreset': async ({ name }) => {
        const store = this.#options.presets
        if (store === undefined) throw new AppError('unsupported', 'this host keeps no preset library')
        /*
         * `'in_use'` answers `false`: upstream's `findPreset('in_use')` finds
         * nothing (the name is a word its manager understands, not a stored
         * preset), so `loadPreset('in_use')` is `false` there too — and its
         * signature excludes the name.
         */
        if (name === 'in_use') return { loaded: false }
        if (await store.has(name) === false) return { loaded: false }
        // The panel's arm, so a card's switch and a person's switch are one
        // act: `#applyPreset` persists the choice, copies the scalar fields
        // into the global settings layer and refreshes every open
        // conversation's regex tier.
        await handlers['preset.select']({ name })
        return { loaded: true }
      },

      // —— family③ end ——
    }

    type PluginOwnedHandler = (params: PluginRevisionRequest) => Promise<unknown>
    const guardTavernHelper = (method: RpcMethod, onlyWhenFenced = false): void => {
      const original = handlers[method] as PluginOwnedHandler
      ;(handlers as unknown as Record<RpcMethod, PluginOwnedHandler>)[method] = async params => {
        if (plugins === undefined || (onlyWhenFenced && params.pluginRevision === undefined)) {
          return await original(params)
        }
        const lease = plugins.lease('tavern-helper', params.pluginRevision)
        try {
          return await original(params)
        } finally {
          lease.release()
        }
      }
    }

    // These arms exist only for a card-script runtime. The consent-management
    // methods (script.list/setEnabled/setDocumentGrant/setScriptsAllowed) stay
    // outside this list so the user can inspect and change policy while the
    // runtime itself is disabled. runEnded is cleanup and must remain callable
    // after invalidation.
    for (const method of [
      'storage.set', 'storage.remove', 'storage.clear',
      'script.getVariables', 'script.setVariables', 'script.swipeTo', 'script.slash',
      'script.fetch', 'script.context', 'script.saveMetadata', 'script.createChatMessages',
      'script.deleteChatMessages', 'script.getPreset', 'script.evalTemplate',
      'script.replaceScriptButtons', 'script.saveChat', 'script.setExtensionPrompt',
      'script.body', 'script.setExtensionSettings', 'script.generateRaw',
      'script.setChatMessages', 'script.generate', 'script.getCharacter',
      'script.chatHistoryBrief', 'script.chatHistoryDetail', 'script.rotateChatMessages',
      'script.createOrReplacePreset', 'script.deletePreset', 'script.renamePreset',
      'script.loadPreset', 'regex.tavernList', 'regex.tavernReplace', 'regex.tavernFormat',
    ] satisfies readonly RpcMethod[]) guardTavernHelper(method)

    // These storage arms are shared with native panels. A frame carries the
    // fence; a native caller does not, so disabling Tavern Helper removes its
    // facade without disabling the settings and world-book editors.
    for (const method of [
      'worldbook.load', 'worldbook.get', 'worldbook.replace', 'worldbook.create',
      'worldbook.bindChat', 'worldbook.setGlobalSelect', 'worldbook.delete',
      'worldbook.setCharBooks', 'worldbook.setSettings',
    ] satisfies readonly RpcMethod[]) guardTavernHelper(method, true)

    return handlers
  }

  // —— family②: regex ——
  /**
   * The card a chat's `'character'` tier belongs to.
   *
   * Upstream resolves `option.name ?? 'current'` through
   * `RawCharacter.findIndex`, so a card there can name any installed character.
   * Here there is no name to resolve: the tier is the chat's own card, which is
   * what makes "a card cannot edit another card's rules" structural rather than
   * a check that could be forgotten. See the host ledger §64.
   * @param entry - the open conversation.
   * @returns the character id.
   * @throws {AppError} `not-found` when the conversation has no card.
   */
  #tavernCharacter(entry: ChatEntry): string {
    const characterId = entry.meta.characterId
    if (characterId === undefined) {
      throw notFound('this conversation has no character card, so it has no card regex tier')
    }
    return characterId
  }

  /**
   * One tier's stored rules, in the tier's own order.
   *
   * The **stored** rules, not the composed chain: this is what a list answers
   * and what a write is diffed against, so it must be the document's own list
   * with the user's per-rule overrides left out of it (they live in the policy
   * file and are not part of any document).
   * @param entry - the open conversation.
   * @param tier - which document to read.
   * @returns the rules as stored.
   */
  async #tavernTier(entry: ChatEntry, tier: TavernRegexTier): Promise<readonly RegexScript[]> {
    if (tier === 'global') {
      const extensionSettings = this.#options.extensionSettings
      if (extensionSettings === undefined) return []
      return await extensionSettings.globalRegex()
    }
    if (tier === 'preset') {
      // Read through the same reader the composer uses, so the malformed rows
      // it refuses (an empty `findRegex` matches at every position) are absent
      // here too. A card offered a rule the engine will never run would be
      // offered a switch with nothing behind it.
      return readPresetRegex(this.#options.settings.presetBody()).scripts
    }
    const card = await this.#options.library.load(this.#tavernCharacter(entry))
    const scoped = card.data.extensions.regex_scripts
    return Array.isArray(scoped) ? (scoped as RegexScript[]) : []
  }

  /** The snapshot store, or a refusal naming why there is none. */
  #backups(): BackupStore {
    const store = this.#options.backups
    if (store === undefined) {
      throw new AppError('unsupported', 'this host keeps no snapshot store')
    }
    return store
  }

  /**
   * Take a pre-change snapshot, when this host keeps a store at all.
   *
   * The copy is of the **file on disk** — the state that predates whatever the
   * caller is about to make permanent. `dedup` is for the high-frequency arms:
   * when the newest snapshot already holds these exact bytes, the write is
   * skipped and the existing snapshot is named instead, so a card that saves
   * every turn does not churn the retention window with copies of the same
   * conversation.
   * @param chatId - the conversation about to change.
   * @param characterId - the card it is played with, when known.
   * @param reason - what the caller is about to do.
   * @param dedup - skip the write when the newest snapshot already matches.
   */
  async #snapshotBefore(
    chatId: string,
    characterId: string | undefined,
    reason: 'delete-message' | 'delete-messages' | 'rewrite-messages',
    dedup: boolean,
  ): Promise<void> {
    const store = this.#options.backups
    if (store === undefined) return
    await store.snapshot(chatId, reason, characterId, { dedup })
  }

  /** The connection store, or a refusal naming why there is none. */
  #connections(): ConnectionStore {
    const store = this.#options.connections
    if (store === undefined) {
      throw new AppError('unsupported', 'connection profiles are not configured on this host')
    }
    return store
  }

  /** The persona store, or a refusal naming why there is none. */
  #personas(): PersonaStore {
    const store = this.#options.personas
    if (store === undefined) {
      throw new AppError('unsupported', 'personas are not configured on this host')
    }
    return store
  }

  /** The profile's star list, refused-by-name when the host keeps none. */
  #favorites(): FavoriteStore {
    const store = this.#options.favorites
    if (store === undefined) {
      throw new AppError('unsupported', 'favorites are not configured on this host')
    }
    return store
  }

  /**
   * A summary with the profile's star state attached.
   *
   * Absent stays absent rather than becoming `false`: the summary is what the
   * library saw on disk, and a field meaning "this host keeps favorites and
   * says no" is the caller's to compute, not the summary's to imply.
   * @param character - the summary from the library.
   * @returns the same summary, starred when the profile says so.
   */
  async #withFavorite(character: CharacterSummary): Promise<CharacterSummary> {
    const favorites = this.#options.favorites
    if (favorites === undefined) return character
    return await favorites.has(character.characterId)
      ? { ...character, favorite: true }
      : character
  }

  /**
   * The active persona for the next assembly, or undefined when there is none.
   *
   * Read per assembly, like the world-info settings: the user can switch or
   * edit a persona while the host runs, and a chat opened before the change
   * must still play as *this* user, not as whoever was active when the chat
   * was opened.
   */
  async #activePersona(): Promise<ActivePersona | undefined> {
    const store = this.#options.personas
    if (store === undefined) return undefined
    return await store.active()
  }

  /**
   * Open a chat and refuse if a turn is in flight.
   * @param chatId - the conversation.
   * @param verb - what the caller was trying to do, for the message.
   * @returns the idle entry.
   * @throws {AppError} `busy` while the chat is generating.
   */
  async #idle(chatId: string, verb: string): Promise<ChatEntry> {
    const entry = await this.#options.chats.open(chatId)
    if (entry.generating) throw new AppError('busy', `that chat cannot be ${verb} while it is generating`)
    return entry
  }

  /**
   * What one conversation's next request may spend.
   *
   * The same resolution the assembler runs — {@link resolveWindow}: the
   * preset's own window when it has one, clamped to the model's known window
   * unless `contextUnlocked`, the composition's value otherwise — and the
   * host's reply reserve. Resolved per call rather than stored on the entry, so
   * a preset switch, a per-chat override, or a probe that has just learned this
   * model's window is in force on the next view without anyone having to
   * remember to refresh a copy.
   * @param chatId - the conversation.
   * @returns the figures the capacity meter divides by, and where the window came from.
   */
  #chatBudget(chatId: string): ChatBudget {
    const settings: GenerationSettings = this.#options.settings.get(chatId)
    const resolved = this.#resolveWindow(settings)
    return {
      context: resolved.context,
      reserve: this.#reserveFor(settings),
      source: resolved.source,
      ...resolved.model === undefined ? {} : { model: resolved.model },
      ...resolved.modelContext === undefined ? {} : { modelContext: resolved.modelContext },
    }
  }

  /**
   * What one conversation holds back out of its window for the reply.
   *
   * **`settings.maxTokens` when the chat configures one**, because that is what
   * the request will actually send as `max_tokens` — and upstream's own
   * arithmetic is exactly this identity, not a coincidence to be reproduced:
   * `openai.js:1558` calls `setTokenBudget(openai_max_context,
   * openai_max_tokens)`, `openai.js:3887` is `this.tokenBudget = context -
   * response`, and `openai.js:2750` puts the same `openai_max_tokens` on the
   * wire. One figure, both jobs. `PromptManager.js:1677` computes its own
   * "chat history is getting thin" warning off `openai_max_context -
   * openai_max_tokens` as well, so even upstream's *advisory* denominator is
   * this number.
   *
   * The defect this closes, measured on this machine: `reserveTokens` defaults
   * to 1 024 and the stored `maxTokens` is 65 535, so an assembly against a
   * 1 000 000 window was allowed 998 976 prompt tokens while telling the
   * provider it might write 65 535 more — 1 064 511 against a 1 000 000 window.
   * That overflow is a provider error at send time, not a trim, which is the
   * one failure mode the budget exists to prevent. `#contributions` already
   * resolved the pair this way for the `{{maxResponse}}` macro
   * (`settings.maxTokens ?? reserveTokens`), so one site already knew.
   *
   * The host's `reserveTokens` stays as the fallback for a chat that configures
   * no `maxTokens`: nothing to subtract is not the same as subtracting nothing,
   * and a window with no reply allowance held back is the one shape that cannot
   * be sent at all.
   *
   * **Downstream, deliberately:** a larger reserve makes `context - reserve`
   * smaller, so the block trimmer starts dropping floors earlier and
   * `compactionSpec`'s 80% threshold sits lower. Both follow upstream, which
   * divides by the same difference, and both are the point — a threshold above
   * the level at which the trimmer silently drops a floor is a threshold that
   * never fires in time. `notes/packages/iris-app-service/DEVIATIONS.md` §56
   * carries the measured before-and-after.
   * @param settings - the conversation's generation settings.
   * @returns the reply allowance, in tokens.
   */
  #reserveFor(settings: GenerationSettings): number {
    return settings.maxTokens ?? this.#options.reserveTokens
  }

  /**
   * What is known about one model's context window.
   *
   * Two sources, in this order: what an endpoint reported to a probe **in this
   * process**, then the built-in table. The probe half is deliberately not
   * persisted and deliberately not read back off the saved profiles — a chat's
   * settings name a model, never the connection the model came from, so
   * "profile X said this id is 128k" cannot be attributed to a chat that may be
   * generating through a different endpoint entirely. The process-local map is
   * the honest scope for that: it holds what *this* run observed.
   *
   * A fresh start therefore answers from the table until something probes,
   * which is the right way round — the table is a constant and cannot be stale
   * about a model it names, while a persisted observation can be stale about an
   * endpoint that has since been reconfigured.
   * @param model - the model id from the chat's settings.
   * @returns the window and who said so, or undefined when nothing knows.
   */
  #modelContext(model: string): ModelContextLength | undefined {
    const probed = this.#probedContexts.get(model.trim().toLowerCase())
    if (probed !== undefined) return probed
    const found = modelContextFromTable(model)
    return found === undefined ? undefined : { tokens: found.tokens, source: 'table' }
  }

  /**
   * The window for one settings object, with its provenance.
   *
   * The single place the clamp is applied, so the capacity readout and the
   * assembly cannot come to divide by different numbers — which is the whole
   * failure this replaces, one layer up: the meter and the trimmer agreeing
   * perfectly on a window neither of them had any business using.
   * @param settings - the chat's merged settings.
   * @returns the window, its source, and the model it was judged against.
   */
  #resolveWindow(settings: GenerationSettings): ResolvedWindow {
    return resolveWindow(settings, this.#options.contextWindow, this.#modelContext(settings.model))
  }

  /**
   * One conversation's view, with the budget attached.
   *
   * Every view this service hands out goes through here rather than calling
   * `entry.toView()` directly, which is what makes the capacity figure
   * unconditional: a client that received one view with a budget and the next
   * without would have a meter that blinks out whenever an unrelated write
   * broadcast a fresh view.
   * @param entry - the conversation.
   * @returns the view to send.
   */
  #viewOf(entry: ChatEntry): ReturnType<ChatEntry['toView']> {
    return entry.toView(this.#chatBudget(entry.chatId))
  }

  /** Push a chat's settled view and return it. */
  #announceChat(entry: ChatEntry): ReturnType<ChatEntry['toView']> {
    const view = this.#viewOf(entry)
    this.#options.broadcast({ type: 'chat.updated', chatId: entry.chatId, view })
    return view
  }

  /**
   * Re-compose every live conversation's regex, and re-announce it.
   *
   * Called after **any** regex edit — the global list, a card's allow switch, or
   * one of a card's rules — because all three feed one composed list per open
   * chat (`ChatEntry.scripts`), and a chat left open across the edit is still
   * running on the snapshot it took. Upstream's answer to the same problem is
   * `reloadCurrentChat()` after every write in its panel; this is the host's,
   * and the re-announce is what makes an open page re-render under the new
   * rules rather than showing text the old ones produced.
   *
   * One method rather than a call per write site: the shared thing is not the
   * two lines, it is the *obligation*. Three writes each remembering to refresh
   * is three chances for the fourth to forget, and a forgotten refresh looks
   * exactly like a rule that does not work.
   */
  async #refreshRegex(): Promise<void> {
    for (const chatId of await this.#options.chats.refreshRegex()) {
      this.#announceChat(await this.#options.chats.open(chatId))
    }
  }

  /** Push the conversation list. */
  async #announceChats(): Promise<void> {
    this.#options.broadcast({ type: 'chats.updated', chats: await this.#chatList() })
  }

  /**
   * The sidebar list, in the order the reader arranged.
   *
   * **The one place the list is read.** `chat.list` answers from here, every
   * `chats.updated` broadcast goes through `#announceChats` above, and
   * `chat.rename` and `chat.reorder` return this — so there is no path by which
   * a caller gets the arrangement and another gets newest-first. The chat store
   * itself stays sorted by `updatedAt`, which is the honest thing for it to
   * report: it knows about files, not about shelves.
   * @returns the summaries in display order.
   */
  async #chatList(): Promise<ChatSummary[]> {
    // The listing's own report channel. A chat file that cannot be summarised
    // is still left out of the answer — the shape of `chat.list` does not
    // change — but it is no longer left out *silently*: a conversation damaged
    // by a truncated save used to vanish from the sidebar with nothing said
    // anywhere, which reads as a deletion nobody performed.
    const rows = await this.#options.chats.list(
      message => { this.#report(message, { kind: 'host', grade: 'fault' }) })
    const store = this.#options.chatOrder
    if (store === undefined) return rows
    return applyChatOrder(rows, await store.list())
  }

  /** The arrangement store, refused-by-name when the host keeps none. */
  #chatOrder(): ChatOrderStore {
    const store = this.#options.chatOrder
    if (store === undefined) {
      throw new AppError('unsupported', 'a manual chat order is not configured on this host')
    }
    return store
  }

  /**
   * Open a turn and start generating into the event stream.
   *
   * Returns the turn number rather than the reply: the driver's first
   * statements are synchronous, so by the time this resolves the turn is on the
   * log and the client can start correlating `stream.*` frames to it.
   * @param chatId - the conversation.
   * @param request - a new user message, a reroll of the last turn, a continue
   *   of it, or an impersonation of the user.
   * @returns the turn now generating.
   * @throws {AppError} `busy` when one already is, `invalid-request` when there
   *   is no turn to reroll or nothing on it to continue.
   */
  async #start(
    chatId: string,
    request:
      | { kind: 'send', text: string }
      | { kind: 'regenerate' }
      | { kind: 'continue' }
      | { kind: 'impersonate' },
  ): Promise<number> {
    const entry = await this.#options.chats.open(chatId)
    const generationType = GENERATION_TYPE_OF[request.kind]
    const turn = request.kind === 'send' || request.kind === 'impersonate'
      ? entry.lastTurn + 1
      : entry.lastTurn
    if (turn < 0) throw invalid('this chat has no turn to regenerate')

    // A continue needs a reply under it: the newest floor's selected reading is
    // what the generation writes on from, and what it rejoins. A chat whose
    // newest line is a user line (an exchange that never got its reply) has
    // nothing to continue — refused by name rather than answered with a reply
    // shaped like a continuation, which is what a bare reroll would produce.
    const seed = request.kind === 'continue'
      ? selectedCandidate(entry.session, turn)
      : undefined
    if (request.kind === 'continue' && seed === undefined) {
      throw invalid('this chat has no reply to continue; its newest line is not a reply')
    }

    // **Before the turn opens, and awaited**: the harness compacts at its
    // `agent/pre-step` boundary, which is the same moment — the request has not
    // been assembled yet, so the summary this produces is in the record the
    // assembly will read. Sitting after the validation above so a refused
    // request (a continue with nothing to continue) does not spend a
    // summarization call on its way to being refused, and before
    // `entry.begin(turn)` so the compaction's own save is not competing with a
    // generation the entry already believes is running.
    await this.#autoCompact(entry)

    const signal = entry.begin(turn)
    // A continue's buffer opens on the text being continued, because the deltas
    // that follow are only the new words: painting them over the row without
    // the seed would collapse the floor to its tail while streaming. The
    // separator the request carries is part of what shows, so it rides here and
    // in the event below — otherwise the floor's tail loses a character the
    // model was actually given until the reply settles.
    const continuePostfix = request.kind === 'continue'
      ? CONTINUE_POSTFIX_SEPARATORS[this.#options.settings.get(chatId).continuePostfix ?? 'space']
      : undefined
    if (seed !== undefined && entry.pending !== undefined) {
      entry.pending.text = continuedSeedText(seedTextOf(seed), continuePostfix ?? '')
    }
    const driver = this.#driver(entry, generationType, request.kind)
    const events: GenerateEvents = {
      onText: (delta) => {
        if (entry.pending !== undefined) entry.pending.text += delta
        this.#options.broadcast({ type: 'stream.text', chatId, turn, delta })
      },
      onReasoning: (delta) => {
        if (entry.pending !== undefined) entry.pending.reasoning += delta
        this.#options.broadcast({ type: 'stream.reasoning', chatId, turn, delta })
      },
      signal,
    }

    // The two utility prompts that close a continue / impersonation request,
    // read off the active preset and expanded against this chat before the
    // driver is asked for anything. The macro pass runs first, then the
    // explicit slots, so text inserted into `{{lastChatMessage}}` is never
    // re-scanned for braces.
    //
    // **`continue_prefill` suppresses the nudge entirely.** Upstream's guard is
    // `if (type === 'continue' && cyclePrompt && !oai_settings.continue_prefill)`
    // (`openai.js:898`): with prefill on, the reply being continued is displaced
    // to the end of the request and handed back to the model as its own opening
    // words, and no instruction is added — the position *is* the instruction.
    // Sending a nudge as well is not a smaller divergence than sending the wrong
    // nudge: it puts a system line into a request upstream leaves clean, and it
    // is the default on the one real preset here that sets the field
    // (`continue_prefill: true`).
    const nudgeText = request.kind === 'continue' && this.#activePreset['continue_prefill'] !== true
      ? utilityPromptOf(this.#activePreset, 'continue_nudge_prompt', CONTINUE_NUDGE_PROMPT)
      : ''
    const nudge = nudgeText === ''
      ? undefined
      : entry.substitute(nudgeText).replace('{{lastChatMessage}}', seedTextOf(seed).trim())
    const instructionText = request.kind === 'impersonate'
      ? utilityPromptOf(this.#activePreset, 'impersonation_prompt', IMPERSONATION_PROMPT)
      : ''
    const instruction = instructionText === '' ? undefined : entry.substitute(instructionText)

    const impersonating = request.kind === 'impersonate'
    const pluginLeases: SystemPluginLease[] = []
    const plugins = this.#options.plugins
    if (plugins?.isEnabled('tavern-helper') === true) {
      pluginLeases.push(plugins.lease('tavern-helper'))
    }
    // Three states are intentional: an app service composed without a plugin
    // runtime keeps the legacy always-on MVU behavior (`undefined`); a runtime
    // with MVU disabled pins this turn off (`null`); an enabled runtime captures
    // the admitted incarnation through settlement.
    let mvuExecution: MvuExecution | null | undefined = plugins === undefined ? undefined : null
    if (!impersonating && plugins?.isEnabled('mvu') === true) {
      const lease = plugins.lease('mvu')
      const capability = plugins.capability<MvuExecution['capability']>('mvu', MVU_CAPABILITY)
      if (capability === undefined) {
        lease.release()
        for (const held of pluginLeases) held.release()
        throw new AppError('internal', 'MVU is enabled without its runtime capability')
      }
      pluginLeases.push(lease)
      mvuExecution = { capability, isCurrent: lease.isCurrent }
    }
    let leasesReleased = false
    const releasePluginLeases = (): void => {
      if (leasesReleased) return
      leasesReleased = true
      for (const lease of pluginLeases.reverse()) lease.release()
    }

    let running: Promise<Candidate | string>
    try {
      running = request.kind === 'send'
        // The storage direction runs on what the user typed, before it enters the
        // log — the one point where a message is written for the first time.
        ? driver.send(
          entry.session,
          runScripts(request.text, 'user', entry.scripts, { substitute: entry.substitute }),
          events,
        )
        : request.kind === 'regenerate'
          ? driver.regenerate(entry.session, events)
          : request.kind === 'continue'
            ? driver.continueTurn(entry.session, events, nudge, continuePostfix)
            : driver.impersonate(entry.session, events, instruction)
    } catch (error: unknown) {
      releasePluginLeases()
      throw error
    }

    // Announced after the call, not before: `send` appends the user's line
    // synchronously at the top of the driver, and until it has, the spare key
    // slot belongs to that line rather than to the reply. Nothing can have been
    // emitted yet — the first delta waits on the network — and the ordering is
    // pinned by test rather than argued.
    this.#options.broadcast({
      type: 'stream.start',
      chatId,
      turn,
      key: entry.streamingKeyFor(turn),
      ...seed === undefined ? {} : { seed: continuedSeedText(seedTextOf(seed), continuePostfix ?? '') },
      ...impersonating ? { role: 'user' as const, name: entry.names.user } : {},
    })

    void running.then(
      async result => {
        try {
          await this.#settle(
            entry,
            turn,
            // An impersonation resolves with its text rather than a candidate:
            // the driver has already landed that text as the turn's user line.
            typeof result === 'string' ? result : textOf(result.message),
            'completed',
            {
              recordVariables: !impersonating,
              ...mvuExecution === undefined ? {} : { mvu: mvuExecution },
            },
          )
        } finally {
          releasePluginLeases()
        }
      },
      async error => {
        try {
          await this.#fail(entry, turn, signal, error, request.kind, mvuExecution)
        } finally {
          releasePluginLeases()
        }
      },
    )

    return turn
  }

  /**
   * Record a finished generation and tell every page.
   *
   * **A settle that cannot store its reply is a terminal event of its own.**
   * Everything below the generation — the variable records, the rewrite, the
   * save — runs inside one `try`, and its `catch` used to do nothing but
   * release the chat and file a report: on a full disk or a permission error
   * the reply existed in memory,
   * the report panel knew, and the page stayed in the generating state until
   * somebody reloaded it, while every other terminal path (`#fail`'s three)
   * broadcasts. Upstream cannot reach this state — its save is a request the
   * browser makes *after* the generation has ended, and `saveChat`'s own catch
   * toasts `Chat could not be saved` / `Check the server connection and reload
   * the page to prevent data loss.` (`public/script.js:7417-7423`) while
   * `chat[]` keeps the reply and the next successful save writes it
   * (`saveChatConditional`, `9352-9378`, logs the failure and swallows it). So
   * the failure is told twice here, in upstream's order: `chat.updated` carries
   * the view the reply is *in*, then `stream.error` with `storage-error` ends
   * the turn and puts the sentence in front of the reader.
   * @param entry - the conversation.
   * @param turn - the turn that settled.
   * @param text - the generation's visible text.
   * @param reason - whether it ran to completion or was stopped.
   * @param options - what this kind of generation records.
   */
  async #settle(
    entry: ChatEntry,
    turn: number,
    text: string,
    reason: 'completed' | 'aborted',
    options: { recordVariables?: boolean, mvu?: MvuExecution | null } = {},
  ): Promise<void> {
    // Whether this turn has already had its terminal event. Set **before** the
    // `stream.end` broadcast rather than after it: once the frame is handed to
    // the carrier every subscriber may have seen it, and a failure in what
    // follows — `#announceChats` is a directory read, and it is inside this
    // `try` — must then be reported rather than answered with a second terminal
    // frame contradicting the first.
    let terminal = false
    try {
      // The reply-shaping settings run first, before variables and storage
      // read the text: upstream applies `cleanUpMessage` before the message is
      // stored, so the trim is part of what everything downstream sees. Only a
      // completed reply is cut — a stop keeps whatever the user decided was
      // good enough, and an impersonation is a user line, never trimmed.
      const generated = text
      let settledText = text
      if (reason === 'completed' && options.recordVariables !== false) {
        const settings = this.#options.settings.get(entry.chatId)
        if (settings.trimSentences === true) settledText = trimToEndSentence(text)
      }

      // Variables first: a permanent script may be there precisely to strip the
      // command block, and the commands have to be read before it does.
      // Reported, not swallowed: a reply whose update block nothing understood
      // is indistinguishable from a model that never wrote one, and telling
      // those apart is the difference between "the card is broken" and "we are".
      //
      // **An impersonation records nothing.** Its text became a user line, and
      // a user line carries no variable consequences — the same rule a typed
      // message lives under. Recording would also hang a table on a turn that
      // has no candidate for it, and the next real turn's baseline walk would
      // then stop one turn early.
      if (options.recordVariables !== false) {
        entry.recordVariables(
          turn,
          settledText,
          message => {
            this.#report(message, {
              kind: 'mvu',
              grade: 'fault',
              chatId: entry.chatId,
              ...entry.meta.characterId === undefined ? {} : { characterId: entry.meta.characterId },
            })
          },
          options.mvu,
        )
      }
      // Before `#storeRewritten`, which may rebuild the log: `rebuild` carries
      // per-candidate records across by position, so a record that exists
      // survives it — while a record appended afterwards would be attached to
      // the pre-rebuild candidate seqs and lost. The same ordering
      // `recordVariables` above depends on.
      //
      // Unconditional, `recordVariables`' own gate included: an impersonation
      // records no variables because a user line has no variable consequences,
      // but it does cost tokens. It has no candidate to hang them on either
      // (see `recordUsage`), so nothing is written — but the reason is the
      // shape of the log, not this switch.
      entry.recordUsage(turn)
      // Beside the cost, under the same ordering rule (before
      // `#storeRewritten`, which may rebuild the log), and a separate call for
      // the reason `recordTiming` gives: the two records are independently
      // absent, and an endpoint that reports no usage still took a measurable
      // amount of time — which is most of them. An **aborted** turn reaches
      // here through `#fail`'s partial path and records what it has: the wait
      // up to the stop is what the person actually waited, and a partial reply
      // the user chose to keep is a reply whose speed is a fact about it.
      entry.recordTiming(turn)
      this.#storeRewritten(entry, entry.scripts, generated, settledText)
      entry.touch()
      entry.finish()
      // After the turn is complete, so a prune can never race the assembly that
      // is still reading these tables. Reported rather than silent: this removes
      // state that cannot be recovered, and a user learning about it from a
      // shrinking file would learn too late.
      const prune = this.#options.pruneVariables
      // Gated on the chat's length, because upstream gates on `chat.length % 5`
      // rather than running every turn. The cadence is not cosmetic: the
      // interval rule marks the layers it keeps, and marks persist, so a
      // cleanup running at a different rhythm pins a different set of them.
      // Said whether or not this turn is a cleanup turn, because it is about the
      // chat’s state rather than about this run.
      if (prune !== undefined) {
        const note = entry.legacyCleanupNote(prune)
        if (note !== undefined) {
          // The note only, once per loaded entry. **The dialog is raised on
          // `chat.open` instead**, because that is when upstream asks and because a
          // question asked once per host lifetime is not a question. This line is
          // for the report view, which wants the fact recorded rather than repeated.
          this.#report(note, { kind: 'variables', grade: 'note', chatId: entry.chatId })
        }
      }
      if (prune !== undefined && pruneDue(chatLines(entry.session).length)) {
        entry.prune(prune, message => {
          this.#report(message, { kind: 'variables', grade: 'note', chatId: entry.chatId, irreversible: true })
        })
      }
      await this.#options.chats.save(entry, message => {
        this.#report(message, { kind: 'variables', grade: 'fault', chatId: entry.chatId })
      })
      terminal = true
      this.#options.broadcast({
        type: 'stream.end', chatId: entry.chatId, turn, view: this.#viewOf(entry), reason,
      })
      await this.#announceChats()
    } catch (cause: unknown) {
      entry.finish()
      this.#report(cause, { kind: 'host', grade: 'fault', chatId: entry.chatId })
      if (terminal) return
      // The reply itself is not lost: it is a candidate on `entry.session`, and
      // the entry stays in `ChatStore`'s map for as long as this host runs, so
      // the next save that succeeds — the next turn's — writes the whole log
      // including this turn. That is the half of the truth a page cannot see,
      // and from its side an unsaved reply and a lost one look identical, which
      // is why the view goes out first and the sentence says so.
      try {
        this.#options.broadcast({
          type: 'chat.updated', chatId: entry.chatId, view: this.#viewOf(entry),
        })
      } catch {
        // A view this host cannot project is not a reason to withhold the
        // failure itself. The frame below is the one that must go out.
      }
      this.#options.broadcast({
        type: 'stream.error',
        chatId: entry.chatId,
        turn,
        code: 'storage-error',
        message: `the reply was generated but could not be saved: `
          + `${cause instanceof Error ? cause.message : String(cause)}`
          + `; it is held in this host's memory and the next save that succeeds writes it`,
      })
    }
  }

  /**
   * Report a generation that did not finish.
   *
   * A stop is not a failure: SillyTavern keeps whatever the model produced
   * before the user pressed stop, and throwing away half a reply the user
   * decided was good enough is worse than the abort itself. So a stopped turn
   * with text becomes a real candidate and settles normally.
   *
   * An impersonation keeps its partial as a **user line** instead — that is the
   * only kind of line it was ever going to produce — and a provider failure
   * keeps nothing at all, because a half-written user line nobody asked for is
   * not a reply the user can retry; it is text in their mouth.
   * @param entry - the conversation.
   * @param turn - the turn that failed.
   * @param signal - the abort signal the generation ran under.
   * @param error - what the driver raised.
   * @param kind - which generation this was.
   */
  async #fail(
    entry: ChatEntry,
    turn: number,
    signal: AbortSignal,
    error: unknown,
    kind: 'send' | 'regenerate' | 'continue' | 'impersonate',
    mvu: MvuExecution | null | undefined,
  ): Promise<void> {
    const partial = entry.pending?.text ?? ''
    // Three outcomes, not two. A budget expiring in the adapter aborts a
    // controller the *adapter* owns, so `signal` — the user's — is not
    // aborted, and the two-way test above would have called a silent endpoint
    // a `provider-error`. The provider did not error; it stopped speaking, and
    // those ask a reader for different things (retry versus look at the
    // endpoint). The adapter's message names which phase and how long.
    const code = failureCode(signal, error)

    if (kind === 'impersonate') {
      if (signal.aborted && partial.length > 0) {
        try {
          this.#driver(entry, GENERATION_TYPE_OF.impersonate).recordImpersonation(entry.session, partial)
          await this.#settle(entry, turn, partial, 'aborted', { recordVariables: false })
          return
        } catch (cause: unknown) {
          this.#report(cause, { kind: 'host', grade: 'fault', chatId: entry.chatId })
        }
      }
      entry.finish()
      try {
        await this.#options.chats.save(entry)
      } catch (cause: unknown) {
        this.#report(cause, { kind: 'host', grade: 'fault', chatId: entry.chatId })
      }
      this.#options.broadcast({
        type: 'stream.error',
        chatId: entry.chatId,
        turn,
        code,
        message: error instanceof Error ? error.message : String(error),
      })
      return
    }

    if (signal.aborted && partial.length > 0) {
      try {
        appendCandidate(entry.session, {
          turn,
          step: 0,
          message: createAssistantMessage({
            content: [{ type: 'text', text: partial }],
            source: INTERRUPTED_SOURCE,
          }),
        })
        // The interrupted path. Both paths converge here, which is why the
        // reason has to travel with the call: by the time the event is built,
        // nothing in the entry says whether the text arrived or was cut off.
        await this.#settle(
          entry,
          turn,
          partial,
          'aborted',
          mvu === undefined ? {} : { mvu },
        )
        return
      } catch (cause: unknown) {
        this.#report(cause, { kind: 'host', grade: 'fault', chatId: entry.chatId })
      }
    }

    entry.finish()
    try {
      // The user's message stays on the log, so retrying is meaningful.
      await this.#options.chats.save(entry)
    } catch (cause: unknown) {
      this.#report(cause, { kind: 'host', grade: 'fault', chatId: entry.chatId })
    }

    this.#options.broadcast({
      type: 'stream.error',
      chatId: entry.chatId,
      turn,
      code,
      message: error instanceof Error ? error.message : String(error),
    })
  }

  /**
   * Build the driver for one chat, with its current settings.
   * @param entry - the conversation.
   * @param generationType - upstream's word for what is being generated, which
   *   the preset's `injection_trigger` lists are matched against.
   * @param traceKind - what to call this generation in the cache trace: Iris's
   *   own word rather than upstream's, because the trace is read by a person
   *   asking why *this* turn missed, and `send` answers that where `normal`
   *   does not. Defaults to the generation type, so a caller with no request
   *   kind in hand still labels its traces with something true.
   * @returns the driver.
   */
  #driver(entry: ChatEntry, generationType = 'normal', traceKind = generationType): TurnDriver {
    const settings: GenerationSettings = this.#options.settings.get(entry.chatId)
    const count = (text: string): number => this.#counter.count(text)
    const names = entry.names

    return new TurnDriver({
      stream: options => this.#stream(options, entry, { chatId: entry.chatId, kind: traceKind }),
      provider: settings.provider,
      model: settings.model,
      // The generation type travels with the driver so the assembly it drives
      // is the one this turn asked for: triggers and the continue rule read it.
      contributions: session => this.#contributions(entry, session, count, true, generationType),
      history: (session, projection) => this.#history(entry, session, projection),
      // The same builder every other assembly in this host uses, so the trim
      // block cannot be in force on one path and absent on another — fed the
      // window `resolveWindow` decided and the reserve `#reserveFor` decided,
      // which are the one place each of those is decided.
      //
      // **The reserve and the `maxTokens` below are the same number** whenever
      // the chat sets one: what the prompt gives up has to be what the reply is
      // allowed to take, or the two together overflow the window. `#reserveFor`
      // has upstream's line numbers.
      budget: this.#budget(count, this.#resolveWindow(settings).context, this.#reserveFor(settings)),
      ...settings.temperature === undefined ? {} : { temperature: settings.temperature },
      ...settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens },
      ...settings.stop === undefined ? {} : { stop: settings.stop },
      ...settings.squashSystemMessages === undefined ? {} : { squashSystemMessages: settings.squashSystemMessages },
      // Resolved here, once, rather than inside the assembly: the driver's
      // `assemble` and the itemization recorded beside it have to agree, and
      // two reads of an environment variable and a settings file are two
      // chances to disagree.
      cacheFriendly: cacheFriendlyOf(settings),
      sampling: samplingOf(settings),
    })
  }

  /**
   * One generation's prompt policy, plus whatever a card script has injected.
   * @param entry - the conversation.
   * @param session - the log to assemble from.
   * @param count - the token counter the budget uses.
   * @param record - whether this is a real turn whose state advances.
   * @param generationType - what is being generated, for the preset filters.
   * @returns the contributions for this generation.
   */
  async #contributions(
    entry: ChatEntry,
    session: Session,
    count: (text: string) => number,
    record = true,
    generationType = 'normal',
  ): Promise<Contribution[]> {
    const names = entry.names
    const settings: GenerationSettings = this.#options.settings.get(entry.chatId)
    const window = this.#resolveWindow(settings).context
    // A reroll's world-info scan and its itemization must read the same
    // conversation the request carries — the driver drops the reply being
    // replaced, and a scan that still saw it could fire an entry on a keyword
    // that only exists in the text nobody is sending. Upstream's scan buffer is
    // built from `coreChat` **after** the pop (`script.js:4438`, then
    // `getWorldInfoPrompt(chat2, …)`), and its itemization records what was
    // actually sent.
    const projection: HistoryProjection = generationType === GENERATION_TYPE_OF.regenerate
      ? { dropTrailingReply: true }
      : {}
    // The scan knobs, read per assembly: the settings file can change while the
    // host runs, and a chat opened before the change must still scan with what
    // the user set, not with what was set when the chat was opened.
    const worldbookSettings = this.#options.settings.worldbookSettings()
    const persona = await this.#activePersona()
    // The budget macros report the numbers this generation actually runs under:
    // the context window, and the reply budget. Assigned before the prompt is
    // built, because the build's expansions are what read it.
    //
    // Through `#reserveFor` now, which is the same expression this line always
    // held — `settings.maxTokens ?? reserveTokens`. This was the one site that
    // already resolved the pair correctly; naming it made the other four agree
    // rather than leaving `{{maxResponse}}` reporting one figure while the
    // assembly it describes subtracted another.
    entry.tokenBudget = {
      context: window,
      response: this.#reserveFor(settings),
    }
    const built = buildPrompt({
      card: entry.card,
      ...entry.worldbook === undefined ? {} : { worldbook: entry.worldbook },
      preset: this.#activePreset,
      userName: names.user,
      characterName: names.character,
      // The same projection the model gets, so a world-info scan cannot match a
      // keyword inside a block the prompt scripts are about to strip.
      history: this.#history(entry, session, projection),
      count,
      // `world_info_budget` and `world_info_budget_cap`, translated by
      // `computeBudget` — the same percentage-of-context arithmetic upstream
      // runs, against the window this chat actually assembles under (a per-chat
      // override included). The fixed 25% share this call site used to
      // hard-code is the setting's own default, so a fresh installation
      // computes the same number.
      worldInfoBudget: computeBudget(window, worldbookSettings.budgetPercent, worldbookSettings.budgetCap),
      // The chat's expander, so the card's own variable macros resolve against
      // this chat's state rather than being sent as braces.
      substitute: entry.substitute,
      // The scan's outlet buckets become this chat's `{{outlet::key}}` answers
      // for the rest of the build — upstream writes `extension_prompts` at
      // exactly this point, before the preset's own text is rendered.
      outletSink: outlets => { entry.outletPrompts = outlets },
      ...entry.timedEffects === undefined ? {} : { timedEffects: entry.timedEffects },
      activationSettings: activationSettingsOf(worldbookSettings),
      includeNames: worldbookSettings.includeNames,
      insertionStrategy: worldbookSettings.insertionStrategy,
      chatLore: await this.#chatLore(entry),
      // The active persona, read per assembly — a switch must reach the next
      // turn, not the next chat open. Absent is the no-persona default.
      ...persona === undefined ? {} : { persona },
      ...generationType === 'normal' ? {} : { generationType },
    })
    // Carried forward, or a sticky entry would re-open its window every turn and
    // a cooldown would never elapse — the state exists precisely to span turns.
    //
    // **Only for a real turn.** A card-initiated generation assembles the same
    // prompt but is not a turn: storing the advanced windows would let a script
    // age out a sticky entry the conversation never saw, and the effect would
    // show up turns later as world info that stopped appearing. The same shape
    // as a preview that writes — a read-only path quietly changing chat state —
    // only hidden inside world-info timing instead of a variable table.
    if (record) {
      entry.timedEffects = built.timedEffects
      // Mirrored into the chat header, under the key upstream uses, so the
      // windows ride the next save the way every other piece of chat metadata
      // does. A restart without this would silently reset every sticky and
      // cooldown window in every conversation.
      writeTimedEffects(entry.header.chat_metadata, built.timedEffects)
    }

    const resolved = [...built.contributions, ...injectedContributions(entry, built.contributions)]

    // Which parts change between turns, and therefore which ones the reorder
    // moves out of the stable prefix. Two phases on purpose: the **verdict** is
    // read on every path, so a preview shows the layout the next real turn will
    // have, while the **record** advances only for a real turn. A preview that
    // advanced the generation counter would age every mark out of hysteresis by
    // opening the prompt panel.
    const verdict = classifyVolatility(
      entry.volatility ?? emptyVolatility(),
      resolved,
      { entropic: new Set(built.entropic), runtime: runtimeIds(entry) },
    )
    if (record) {
      entry.volatility = verdict.next
      writeVolatility(entry.header.chat_metadata, verdict.next)
    }
    const contributions = markCachePhase(resolved, verdict)
    const cacheFriendly = cacheFriendlyOf(settings)

    // Recorded here because this is the only moment the parts and the history
    // agree with what is about to be sent: by the time the turn settles, the
    // reply is on the log and the same assembly would produce something else.
    // Recorded for the turn being generated, and only then: the itemization is
    // an account of what a real request contained, and a side generation
    // overwriting it would replace the record of the turn the user is looking at.
    const turn = record ? entry.pending?.turn : undefined
    if (turn !== undefined) {
      const assembled = assemble({
        contributions,
        history: this.#history(entry, session, projection),
        budget: this.#budget(count, window, this.#reserveFor(settings)),
        cacheFriendly,
      })
      // The first floor the budget kept is the one the dropped count names —
      // history entries map one-to-one onto chat-file lines. This is
      // `chat_metadata.lastInContextMessageId` upstream and, like it, a real
      // turn's byproduct: a preview must not write it.
      //
      // **Offset by the compaction**, because `droppedHistory` counts drops
      // from the conversation the assembler was handed, and after a compaction
      // that conversation starts with a summary standing for `count` real
      // floors. Without the offset this macro would name a floor that is in the
      // request only as a sentence inside the summary — the summary itself is
      // pinned, so it is never the dropped one, and the arithmetic is a plain
      // shift rather than a special case.
      entry.firstIncludedMessageId
        = (readCompaction(entry.header)?.count ?? 0) + assembled.overflow.droppedHistory
      // `window`, not the composition default. Without it the recorded
      // itemization reported `budget.context: 32768` for a chat that had just
      // assembled against a 2 000 000 override — the preview path
      // (`#previewItemization`) passed the window and the record did not, so the
      // panel's capacity line changed meaning depending on which of the two
      // answered.
      //
      // **Found twice, independently: once by the cache census pass and once by
      // the window-provenance pass**, which is worth recording because neither
      // of this file's own suites could have found it — every fixture here runs
      // on the default window, where the two numbers agree. It is now pinned
      // from the clamp side too (`tests/model-context.test.ts`: a real turn is
      // generated and `prompt.itemize` is asked *with* its turn, which is the
      // only way to get a record back rather than a fresh preview).

      entry.itemizations.set(
        turn,
        this.#itemizationOf(assembled, turn, false, window, this.#reserveFor(settings)),
      )
    }

    return contributions
  }

  /**
   * The chat-bound world book, read fresh for every assembly.
   *
   * `chat_metadata.world_info` holds a book **name**; the file is loaded here,
   * per generation, because this is the one body of world info a card writes
   * during play — `getOrCreateChatWorldbook` mints it and
   * `createWorldbookEntries` appends to it, and a resolution taken at chat-open
   * time would never see any of that.
   *
   * Upstream's guard is reproduced (`getChatLore`, `world-info.js:4430`): the
   * key is only honoured when the named file exists (a failed read is a skip,
   * not an error), and a chat book that is also globally selected is skipped —
   * global wins that overlap. When the chat book *is* the character's bound
   * book, upstream drops the character side instead ("already activated in chat
   * lore! Skipping...", `world-info.js:4392`), and that guard lives in
   * `scanEntriesOf`, where both sides are visible at once.
   * @param entry - the conversation.
   * @returns zero or one book; the key holds a single name upstream.
   */
  async #chatLore(entry: ChatEntry): Promise<{ world: string, entries: LorebookEntry[] }[]> {
    if (this.#options.worldbooks === undefined) return []
    const name = entry.header.chat_metadata['world_info']
    if (typeof name !== 'string' || name === '') return []

    if (this.#options.settings.globalSelect().includes(name)) return []

    try {
      const book = await this.#options.worldbooks.read(name)
      return [{ world: name, entries: Object.values(book.entries) }]
    } catch {
      // Deleted, or never existed under this name. Upstream checks the key
      // against `world_names` and silently ignores a miss; so does this.
      return []
    }
  }

  /**
   * The budget every assembly for this host runs under.
   *
   * Both figures are **required parameters** and neither has a default to fall
   * into, which is the fix `#itemizationOf` already documents for `window`
   * carried one field further: a defaulted budget figure is a wrong answer that
   * assembles perfectly, and the reserve now varies per chat
   * ({@link #reserveFor}) exactly the way the window does, so it is reachable
   * the same way.
   * @param count - the token counter.
   * @param window - the window this assembly runs against, from `#resolveWindow`.
   * @param reserve - what it holds back for the reply, from `#reserveFor`.
   * @returns the budget.
   */
  #budget(
    count: (text: string) => number,
    window: number,
    reserve: number,
  ): { context: number, reserve: number, count: (text: string) => number, trimBlockFloors: number } {
    return {
      context: window,
      reserve,
      count,
      // Carried by every budget this host builds, so the real turn, the
      // preview, a card's own `generate` and the itemization all decide the
      // same cut. A block that only some paths knew about would make the
      // preview name floors the request did not send.
      trimBlockFloors: this.#options.trimBlockFloors,
    }
  }

  /**
   * Project an assembly onto the wire shape.
   *
   * `window` and `reserve` are both **required**, and that is the fix for the
   * bug two separate passes found here: the window used to default to the
   * composition's value, so the one caller that forgot it filed a record
   * claiming 32 768 for an assembly that had run against something else. A
   * defaulted budget figure is a wrong answer that renders perfectly, so
   * neither parameter has a default to fall into — a third caller cannot repeat
   * it without the compiler saying so. `reserve` joined the rule when it stopped
   * being one host-wide constant ({@link #reserveFor}); read off `#options`
   * here it would have reported 1 024 for assemblies that actually gave up
   * 65 535, and the capacity card divides by exactly this figure.
   * @param result - what the assembler produced.
   * @param turn - the turn this describes.
   * @param preview - whether this is the next request rather than a record.
   * @param window - the window that assembly actually ran against.
   * @param reserve - what that assembly held back for the reply.
   * @returns the itemization.
   */
  #itemizationOf(
    result: AssembleResult,
    turn: number,
    preview: boolean,
    window: number,
    reserve: number,
  ): PromptItemization {
    return {
      turn,
      entries: result.items.map(item => ({
        id: item.id,
        // The id is frequently a UUID; the label is what a person reads.
        label: item.label ?? item.id,
        kind: item.kind,
        tokens: item.tokens,
        ...item.depth === undefined ? {} : { depth: item.depth },
        ...item.role === undefined || item.role === 'system' ? {} : { role: item.role },
        ...item.deferred === true ? { deferred: true } : {},
        ...item.promoted === true ? { promoted: true } : {},
        // The entries a split depth bucket is the join of, each with where the
        // reorder sent it. Present only when the reorder read them, which is
        // the same condition the placement used — so the panel can never show a
        // split the request did not make.
        ...item.members === undefined
          ? {}
          : {
              members: item.members.map(member => ({
                id: member.id,
                label: member.label ?? member.id,
                tokens: member.tokens,
                ...member.deferred === true ? { deferred: true } : {},
                ...member.promoted === true ? { promoted: true } : {},
              })),
            },
      })),
      tokens: result.tokens,
      stablePrefixTokens: result.stablePrefixTokens,
      budget: {
        context: window,
        reserve,
      },
      droppedHistory: result.overflow.droppedHistory,
      overBudget: result.overflow.overBudget,
      preview,
    }
  }

  /**
   * How the next request for this chat would assemble.
   *
   * Needs no stored record because assembly is pure: the same inputs produce
   * the same answer, so a preview is always available even for a chat the host
   * has only just opened.
   * @param entry - the conversation.
   * @returns the itemization of a request that has not been sent.
   */
  async #previewItemization(entry: ChatEntry): Promise<PromptItemization> {
    const count = (text: string): number => this.#counter.count(text)
    const names = entry.names
    const settings: GenerationSettings = this.#options.settings.get(entry.chatId)
    const window = this.#resolveWindow(settings).context
    const worldbookSettings = this.#options.settings.worldbookSettings()
    const persona = await this.#activePersona()
    const built = buildPrompt({
      card: entry.card,
      ...entry.worldbook === undefined ? {} : { worldbook: entry.worldbook },
      preset: this.#activePreset,
      userName: names.user,
      characterName: names.character,
      history: this.#history(entry, entry.session),
      count,
      // Against the window this chat actually assembles under (a per-chat
      // override included), with `world_info_budget` and `world_info_budget_cap`
      // from the stored settings.
      worldInfoBudget: computeBudget(window, worldbookSettings.budgetPercent, worldbookSettings.budgetCap),
      // The preview has to show what would actually be sent, macros included —
      // an itemization that still holds `{{format_message_variable::…}}` would
      // hide precisely the defect this seam exists to prevent.
      substitute: entry.substitute,
      ...entry.timedEffects === undefined ? {} : { timedEffects: entry.timedEffects },
      activationSettings: activationSettingsOf(worldbookSettings),
      includeNames: worldbookSettings.includeNames,
      insertionStrategy: worldbookSettings.insertionStrategy,
      chatLore: await this.#chatLore(entry),
      // Same persona read as a real turn: the preview has to show what would
      // actually be sent, and that includes the persona's slot.
      ...persona === undefined ? {} : { persona },
    })
    const resolved = [...built.contributions, ...injectedContributions(entry, built.contributions)]
    // The verdict, not the record: a preview must show the layout the next real
    // turn will send, and must not advance the classifier's generation counter
    // — `prompt.itemize` is a read.
    const verdict = classifyVolatility(
      entry.volatility ?? emptyVolatility(),
      resolved,
      { entropic: new Set(built.entropic), runtime: runtimeIds(entry) },
    )
    const reserve = this.#reserveFor(settings)
    const result = assemble({
      contributions: markCachePhase(resolved, verdict),
      history: this.#history(entry, entry.session),
      budget: this.#budget(count, window, reserve),
      cacheFriendly: cacheFriendlyOf(settings),
    })
    return this.#itemizationOf(result, entry.lastTurn + 1, true, window, reserve)
  }

  /**
   * Run one completion that never touches the log.
   *
   * A card asks for this to compute something on the side — a summary, a
   * classification — so it is not a turn: nothing is appended to the log,
   * nothing streams, and no candidate is produced.
   *
   * **One thing is written: what it cost.** The record goes on the
   * conversation's header (`./side-usage.ts`), not into the log, and it is a
   * *cost* rather than conversation state — it changes nothing about what the
   * conversation does next, which is the property the paragraph above is
   * really about. Before it existed these requests were billed by the provider
   * and recorded nowhere, so a conversation's running total and the whole usage
   * page were about a population narrower than the user's bill.
   * @param entry - the conversation whose model route to use.
   * @param prompt - what to ask.
   * @param systemPrompt - an optional system slot.
   * @returns the finished text.
   * @throws {AppError} `provider-error` when the stream ends in failure.
   */
  async #generateRaw(entry: ChatEntry, prompt: string, systemPrompt?: string): Promise<string> {
    const settings = this.#options.settings.get(entry.chatId)
    const sampling = samplingOf(settings)
    const assembler = new BlockAssembler()

    for await (const chunk of this.#stream({
      provider: settings.provider,
      model: settings.model,
      ...systemPrompt === undefined ? {} : { system: systemPrompt },
      messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })],
      ...settings.temperature === undefined ? {} : { temperature: settings.temperature },
      ...settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens },
      ...sampling === undefined ? {} : { sampling },
      // No `entry`, for the reasons this method's doc gives, but a trace target
      // all the same: this request goes to the same provider on the same route
      // and its prefix competes for the same cache, so a chat whose card fires
      // one of these between turns is a chat whose turn-to-turn traces have a
      // stranger in between. Leaving it out would make that stranger invisible
      // and the gap in sequence numbers unexplained. It carries no layout —
      // nothing here was assembled — so its spans are unattributed, and the
      // trace says so rather than guessing.
    },
    undefined,
    { chatId: entry.chatId, kind: 'side', caller: 'script.generateRaw', turn: -1 },
    // Billed to this conversation all the same — see `./side-usage.ts`. The
    // caller is the RPC method name because that is the finest attribution
    // the contract carries: `script.generateRaw` sends no script id.
    { entry, caller: 'script.generateRaw', source: 'script' })) {
      assembler.push(chunk)
    }

    const finish = assembler.finish
    if (finish.kind === 'error') {
      throw new AppError('provider-error', finish.failure?.message ?? 'the provider ended the stream with an error')
    }
    return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
  }

  /**
   * Generate the way a real turn would, without becoming one.
   *
   * This is upstream's `TavernHelper.generate`, and the distinction from
   * `generateRaw` is the whole point: `generate` assembles the preset, the world
   * info and the history and puts `userInput` last, while `generateRaw` sends
   * only what it is handed. A card asking for the first and receiving the second
   * gets an answer produced with no persona, no lorebook and no conversation —
   * and it reports as success, which is why the two must not share an
   * implementation.
   *
   * **Nothing that changes the conversation is written.** Not the log, and not
   * the two pieces of chat state a real assembly advances: the world-info timed
   * effects and the turn's itemization. A side generation that stored either
   * would change what the conversation does next — a sticky entry aged out by a
   * script, or the account of the user's own turn overwritten — from a call
   * that never appears in the chat.
   *
   * What *is* written is the bill: one append-only record on the header
   * (`./side-usage.ts`). It changes nothing the conversation does; leaving it
   * out was what made a card's spend invisible on every surface that reports
   * cost.
   * @param entry - the conversation to assemble from.
   * @param userInput - the card's prompt, placed as the final user message.
   * @param systemPrompt - replaces the assembled system slot when given.
   * @param maxHistory - how many history entries to keep; all of them when absent.
   * @returns the finished text.
   * @throws {AppError} `provider-error` when the stream ends in failure.
   */
  async #sideGenerate(
    entry: ChatEntry,
    userInput: string,
    systemPrompt?: string,
    maxHistory?: number,
  ): Promise<string> {
    const settings = this.#options.settings.get(entry.chatId)
    const count = (text: string): number => this.#counter.count(text)

    const history = this.#history(entry, entry.session)
    // `max_chat_history` counts from the recent end: a card asking for two wants
    // the last two exchanges, not the first two.
    const kept = maxHistory === undefined ? history : history.slice(Math.max(0, history.length - maxHistory))

    const result = assemble({
      contributions: await this.#contributions(entry, entry.session, count, false),
      // The card's prompt is a floor of its own with an id of its own, so a
      // trace of this request can name it. Without an id its slot would be
      // unattributed and the whole trace would be marked so — a routine path
      // reading as a defect.
      history: [...kept, { role: 'user' as const, text: userInput, id: 'script.userInput' }],
      // **Against this chat's own window**, not the composition's. A chat with a
      // per-chat `contextWindow` override used to have its side generations
      // assembled against the host default, so the trim cut at a different
      // floor than the real turn does and the card's `generate` stopped being a
      // prefix of the conversation it belongs to. Upstream has no separate
      // budget for `TavernHelper.generate` at all — it goes through the same
      // `Generate`, so it gets the same `openai_max_context`.
      //
      // Through `#resolveWindow`, so the model clamp reaches this path too. Same
      // argument one step further: a side generation assembled against 2M while
      // the real turn ran at the model's 1M would trim at a different floor for
      // the same reason, and it would do it on every chat rather than only on
      // ones carrying an override.
      //
      // The reserve travels the same way and for the same reason: upstream has
      // one `openai_max_tokens` for every generation type, so a card's assembly
      // that held back a different amount would cut at a different floor than
      // the turn beside it.
      budget: this.#budget(count, this.#resolveWindow(settings).context, this.#reserveFor(settings)),
    })

    const assembler = new BlockAssembler()
    const sampling = samplingOf(settings)
    // Same squash as the real turn's. It is a per-chat setting and upstream
    // applies it at the end of `prepareOpenAIMessages` (`openai.js:1599`),
    // which every generation type passes through — a side generation that
    // skipped it would send this conversation's injections in a different
    // shape than the turn beside it, so the two requests would stop sharing a
    // prefix at the first injection.
    //
    // It runs over **slots**, not over bare messages, because the squash is
    // also the one pass that changes how many messages go out: a layout taken
    // from `result.messages` would describe one slot per assembled message and
    // the body would carry fewer, which a trace reads as "the layout describes
    // more messages than the body has" and refuses wholesale. Squashing the
    // slots merges each run's provenance with its text in the same step.
    const slots = settings.squashSystemMessages === true
      ? squashSystemRuns(slotsOf(result.messages))
      : slotsOf(result.messages)
    const messages = slots.map(slot => slot.message)
    for await (const chunk of this.#stream({
      provider: settings.provider,
      model: settings.model,
      ...systemPrompt === undefined
        ? result.system === '' ? {} : { system: result.system }
        : { system: systemPrompt },
      messages: messages.map(message => (message.role === 'assistant'
        ? createAssistantMessage({
          content: [{ type: 'text', text: message.text }],
          source: { provider: 'iris', model: 'history' },
        })
        : createUserMessage({ content: [{ type: 'text', text: message.text }], source: { kind: 'user' } }))),
      ...settings.temperature === undefined ? {} : { temperature: settings.temperature },
      ...settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens },
      ...sampling === undefined ? {} : { sampling },
      // The layout the driver would have attached, built here because this path
      // assembles its own request rather than going through the driver. A card
      // that passed its own `systemPrompt` replaced the assembled string, so the
      // segments describing what it replaced would be confidently wrong offsets
      // — the one output the trace must not produce. Its own text becomes one
      // named segment instead, which is both exact and the honest label.
      layout: {
        system: systemPrompt === undefined
          ? result.systemSegments
          : [{ id: 'script.systemPrompt', text: systemPrompt }],
        messages: slots.map(slot => ({
          parts: slot.parts.map(part => ({ ...part })),
          role: slot.message.role,
        })),
      },
    },
    undefined,
    { chatId: entry.chatId, kind: 'side', caller: 'script.generate', turn: -1 },
    // The bill, on the conversation this was assembled from. This is the path
    // that re-sends the whole prefix, so it is also the expensive one of the
    // two — which is what makes separating the callers worth storing.
    { entry, caller: 'script.generate', source: 'script' })) {
      assembler.push(chunk)
    }

    const finish = assembler.finish
    if (finish.kind === 'error') {
      throw new AppError('provider-error', finish.failure?.message ?? 'the provider ended the stream with an error')
    }
    return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
  }

  /**
   * Ask the model to condense one span of conversation.
   *
   * The call's **shape** is the harness's
   * (`packages/compaction/compaction-basic/src/summarizer.ts`) and the shape is
   * the mechanism: the conversation's own system prompt, then the span's own
   * messages in order, then the compaction instruction as the **final user
   * message**. That makes the auxiliary request a genuine prefix of the request
   * this conversation was already sending, so the provider's KV cache is reused
   * and only the trailing instruction is novel input — where a separate
   * summarizer system prompt would invalidate the whole prefix and bill the
   * full span again at uncached rates.
   *
   * The span is sent whole, against no budget, on purpose. It was part of a
   * request that had *already* fitted the window — that is what made it
   * compactable — so it cannot overflow on its own, and handing it to the
   * trimmer would silently drop the oldest floors from the summary of the
   * oldest floors.
   *
   * No `entry` is passed to {@link #stream}, following `#generateRaw`: this
   * prompt is written by the host, so a card's templates must not evaluate in
   * it, its residual macros are not a card's fault, and — the one that would
   * actually corrupt a record — the estimator calibration and the turn's
   * `actualTokens` must not be moved by a request that is not the turn.
   *
   * **A `side` and a `trace` are passed, and that is this round's fix.** For
   * the whole time compaction has existed, this request was billed by the
   * provider and recorded nowhere: no usage, no fingerprint, no route, no
   * moment, no trace — so a profile that had compacted was short by exactly one
   * summary per compaction on every figure Iris printed, and the gap had no
   * name anywhere on the page. It goes to the same array a card's generation
   * goes to (`./side-usage.ts`), under `source: 'compaction'` and
   * `caller: 'host.compaction'`, because it has the same shape of problem: it is
   * billed, it belongs to this conversation, and it has no candidate to hang
   * off. The trace is filed under `kind: 'compaction'` for a reason the card
   * path does not have — a summary lands at the *front* of the next request's
   * history, so it is the one body that explains why every later turn's prefix
   * changed, and a reader comparing two turns across a compaction has no other
   * way to see it.
   * @param entry - the conversation.
   * @param span - the floors to condense, oldest first.
   * @param contributions - this turn's resolved contributions, for the system slot.
   * @returns the summary text.
   * @throws {AppError} `provider-error` when the stream fails or is cut off.
   */
  async #summarize(
    entry: ChatEntry,
    span: readonly HistoryEntry[],
    contributions: readonly Contribution[],
  ): Promise<string> {
    const settings = this.#options.settings.get(entry.chatId)
    // The system slot only. Assembled against an empty conversation because
    // that is what isolates it: the depth injections (author's note, world-info
    // `atDepth`, a card's `/inject`) belong beside the newest floors of a live
    // request and have no place in a replay of the oldest ones.
    const system = assemble({
      contributions: [...contributions],
      history: [],
      budget: { context: Number.MAX_SAFE_INTEGER, reserve: 0, count: text => this.#counter.count(text) },
    }).system

    const assembler = new BlockAssembler()
    for await (const chunk of this.#stream({
      provider: settings.provider,
      model: settings.model,
      ...system === '' ? {} : { system },
      messages: [
        ...span.map(item => (item.role === 'assistant'
          ? createAssistantMessage({
            content: [{ type: 'text', text: item.text }],
            source: { provider: 'iris', model: 'history' },
          })
          : createUserMessage({ content: [{ type: 'text', text: item.text }], source: { kind: 'user' } }))),
        createUserMessage({
          content: [{ type: 'text', text: COMPACTION_INSTRUCTION }],
          source: { kind: 'user' },
        }),
      ],
      maxTokens: SUMMARY_MAX_TOKENS,
    },
    // No `entry` — see this method's doc.
    undefined,
    // `turn: -1`, like a card's: this request is billed and it is not a turn,
    // and folding it onto whichever turn happened to be pending would file the
    // host's own summary against the user's reply. The automatic trigger runs
    // *before* the turn it protects, so "whichever turn was pending" is a real
    // turn here rather than a theoretical one.
    { chatId: entry.chatId, kind: 'compaction', caller: 'host.compaction', turn: -1 },
    // The bill, on the conversation whose history was folded.
    { entry, caller: 'host.compaction', source: 'compaction' })) {
      assembler.push(chunk)
    }

    const finish = assembler.finish
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      throw new AppError('provider-error', finish.failure?.message ?? 'the provider ended the summary with an error')
    }
    // A truncated checkpoint is worse than none: it is missing its last
    // sections and nothing downstream can tell. The harness fails closed here
    // too (`summarizer.ts`'s `finishError`, `MAX_TOKENS`).
    if (finish.kind === 'max-tokens') {
      throw new AppError(
        'provider-error',
        `the summary was cut off at the ${String(SUMMARY_MAX_TOKENS)}-token cap, so the checkpoint is incomplete`,
      )
    }
    return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('').trim()
  }

  /**
   * Fold this conversation's older history into one summary, and record it.
   *
   * The transaction, in the harness's order: choose the span from the
   * conversation **as the model currently sees it** (an earlier summary
   * included, so a second compaction merges rather than nests), summarize it,
   * refuse a replacement that is not smaller than what it replaces, then write
   * the record and save. Nothing is written until the summary is in hand and
   * has passed the shrink guard, so a failed compaction leaves the conversation
   * exactly as it was.
   * @param entry - the idle conversation.
   * @param retainTokens - the verbatim tail to keep; `0` for a manual compaction.
   * @returns what the compaction did, or `null` when there was nothing to compact.
   * @throws {AppError} `provider-error` from the model, `unsupported` when the
   *   summary would save nothing.
   */
  async #compact(
    entry: ChatEntry,
    retainTokens: number,
  ): Promise<{ floors: number, spanTokens: number, summaryTokens: number } | null> {
    const count = (text: string): number => this.#counter.count(text)
    const previous = readCompaction(entry.header)
    const effective = this.#history(entry, entry.session)
    const keepFrom = selectCompactableSpan(effective, retainTokens, count)
    if (keepFrom === null) return null

    const span = effective.slice(0, keepFrom)
    const spanTokens = historyTokens(span, count)
    const contributions = await this.#contributions(entry, entry.session, count, false)
    const summary = await this.#summarize(entry, span, contributions)
    if (summary === '') {
      throw new AppError('provider-error', 'the summarization produced no text to keep')
    }

    const summaryTokens = count(frameSummary(summary))
    if (summaryTokens >= spanTokens) {
      throw new AppError('unsupported', new SummaryNotSmallerError(summaryTokens, spanTokens).message)
    }

    const covered = rawCoverage(keepFrom, previous)
    writeCompaction(entry.header, {
      count: covered,
      summary,
      spanTokens,
      summaryTokens,
      at: Date.now(),
      model: this.#options.settings.get(entry.chatId).model,
    })
    entry.touch()
    await this.#options.chats.save(entry)
    return { floors: covered - (previous?.count ?? 0), spanTokens, summaryTokens }
  }

  /**
   * Compact before generating, if the next request is about to be too big.
   *
   * The harness's `compactIfNeeded` on its `agent/pre-step` listener, with its
   * pressure reading translated: it measures the latest durable routed request
   * envelope through its token meter, and the same fact here is the itemization
   * this host already records for every real turn (`entry.itemizations`). So the
   * reading is free — no second assembly — and, exactly as in the harness, it
   * describes the **previous** request rather than the one about to be built.
   * That lag is the point: a threshold at 80% of the budget leaves room for one
   * more turn's growth, which is what makes measuring the previous request
   * sufficient.
   *
   * **A conversation with no record yet is never compacted**, and that is a
   * refusal rather than a gap: the only other available reading would be the
   * provider's reported prompt size, which is a different measurement of a
   * different assembly, and choosing between them per call would make the
   * trigger fire at two different fullnesses depending on history nobody can
   * see. The first real turn after opening a chat writes a record.
   *
   * Failures are swallowed into a report, not raised. The user asked to send a
   * message; a compaction that could not run is a reason to send the message
   * uncompacted (the budget trimmer still keeps the request legal), not a reason
   * to refuse the turn.
   * @param entry - the conversation about to generate.
   */
  async #autoCompact(entry: ChatEntry): Promise<void> {
    const budget = this.#chatBudget(entry.chatId)
    const spec = compactionSpec(budget.context - budget.reserve)
    if (spec === null) return
    const latest = entry.lastTurn
    const recorded = latest < 0 ? undefined : entry.itemizations.get(latest)
    if (recorded === undefined || recorded.tokens < spec.thresholdTokens) return
    try {
      const outcome = await this.#compact(entry, spec.retainTokens)
      if (outcome === null) return
      this.#report(
        `compaction folded ${String(outcome.floors)} floor(s) into a summary `
        + `(${String(outcome.spanTokens)} estimated tokens became ${String(outcome.summaryTokens)}); `
        + `the previous request was ${String(recorded.tokens)} against a threshold of ${String(spec.thresholdTokens)}`,
        { kind: 'prompt', grade: 'note', chatId: entry.chatId },
      )
      this.#announceChat(entry)
    } catch (error: unknown) {
      // Reported beside the successes rather than dropped. Copying the
      // harness's "log and continue the turn" is behaviour parity; a failure
      // that says nothing is indistinguishable from a threshold that is never
      // reached, and those two send a reader to opposite places.
      this.#report(error, { kind: 'prompt', grade: 'fault', chatId: entry.chatId })
    }
  }

  /**
   * The conversation as the model should see it.
   *
   * The prompt direction of the chat's regex scripts runs here, which is what
   * keeps a card's own command blocks out of the next request. Leaving them in
   * is not cosmetic: the model reads back its own `<UpdateVariable>` output from
   * every earlier turn and starts imitating it.
   * The **projection** is honoured here rather than left to the driver's
   * repair, because the `depth` below is computed over whatever this returns:
   * upstream's regex depths are counted on the popped conversation
   * (`coreChat.length - index - 1` after `coreChat.pop()`,
   * `public/script.js:4438-4444`), so a reroll must number its floors from the
   * user's line and not from the reply being thrown away.
   * @param entry - the conversation.
   * @param session - the log to project.
   * @param projection - what the generation this is for must not be shown.
   * @returns history entries, oldest first.
   */
  #history(entry: ChatEntry, session: Session, projection: HistoryProjection = {}): HistoryEntry[] {
    return applyCompaction(this.#rawHistory(entry, session, projection), readCompaction(entry.header))
  }

  /**
   * The conversation before any compaction is substituted.
   *
   * Split out for exactly one caller — the summarizer, which has to read the
   * span it is about to replace and would otherwise be handed the summary
   * standing in for it. Everything else wants {@link #history}: putting the
   * substitution at that one choke point is what makes the real turn, the
   * world-info scan, the itemization record, the preview and
   * `TavernHelper.generate` agree about what the model is being shown, instead
   * of five call sites each remembering to compact.
   *
   * The regex depths are computed here, on the **raw** conversation, and that
   * is deliberate: a script scoped to "the newest three floors" must mean the
   * newest three floors whether or not the head has been compacted, and
   * compaction removes from the other end.
   * @param entry - the conversation.
   * @param session - the log to project.
   * @param projection - what the generation this is for must not be shown.
   * @returns history entries, oldest first, every floor verbatim.
   */
  #rawHistory(entry: ChatEntry, session: Session, projection: HistoryProjection = {}): HistoryEntry[] {
    const names = entry.names
    const entries = historyFromSession(session, {
      characterName: names.character,
      userName: names.user,
      ...projection,
    })
    const scripts = entry.scripts
    if (scripts.length === 0) return entries
    return entries.map((item, index) => ({
      ...item,
      text: runScripts(item.text, item.role, scripts, {
        isPrompt: true,
        depth: entries.length - 1 - index,
        substitute: entry.substitute,
      }),
    }))
  }

  /**
   * Rewrite a settled reply the way reply shaping and permanent scripts say it
   * should be stored.
   *
   * Two writers land here with one shape: the reply-shaping settings (the
   * sentence trim) and the chat's permanent regex scripts — both change the
   * message itself, which is why the render and send directions then leave the
   * stored form alone. It goes through the chat-file projection because an
   * append-only log cannot rewrite a message in place — the same route
   * `chat.editMessage` takes, and for the same reason.
   * @param entry - the conversation.
   * @param scripts - the chat's ordered scripts.
   * @param generated - the reply as the model produced it.
   * @param stored - the reply after reply shaping, before scripts.
   */
  #storeRewritten(entry: ChatEntry, scripts: readonly RegexScript[], generated: string, stored: string): void {
    let final = stored
    if (scripts.length > 0) {
      const rewritten = runScripts(final, 'assistant', scripts, { substitute: entry.substitute })
      if (rewritten !== final) final = rewritten
    }
    if (final === generated) return

    const { messages } = entry.toFile()
    const index = messages.length - 1
    const line = messages[index]
    if (line === undefined || line.is_user) return
    line.mes = final
    if (line.swipes !== undefined) line.swipes[line.swipe_id ?? 0] = final
    entry.rebuild(messages, position => position)
  }

  /**
   * Stream one call, folding the provider's own token count back into the estimate.
   *
   * Every response reports what the prompt actually cost — the ground truth for
   * the number just estimated, free of charge. Feeding it back is the only way
   * a character-class estimator converges, because the residual is vocabulary
   * dependent and no static table fixes it.
   * @param options - the composed request.
   * @param entry - the conversation, when this generation belongs to one.
   * @param trace - the conversation and the kind to file a cache trace under.
   *   Separate from `entry` on purpose, because the three parameters answer
   *   three different questions and no generation here answers them the same
   *   way: `entry` is "whose templates and whose turn record", `trace` is "which
   *   request body to keep for comparison", `side` is "whose bill". The host's
   *   own compaction summary passes a `trace` and a `side` and **no `entry`**
   *   — its prompt is the host's, so nothing of the card author's may evaluate
   *   in it and the turn's calibration must not move, but its body is very much
   *   something a reader compares (a summary sits at the front of the next
   *   request's history and breaks the prefix there) and it is very much billed.
   * @param side - the conversation to **bill** a generation that is not a turn,
   *   with the asker to file it under. A third parameter and not `entry`,
   *   because passing `entry` would turn on four other things such a generation
   *   must not do: evaluate the card's own templates over a prompt the card
   *   wrote, move the turn's recorded `actualTokens`, file a fingerprint against
   *   whatever turn is pending, and emit a per-turn report line. The bill is the
   *   one thing that *is* shared, and it lands on the header rather than on any
   *   turn (`./side-usage.ts`). `source` is stated by the caller rather than
   *   defaulted: a default would silently file the host's own requests as a
   *   card's, which is the reading the split exists to make possible.
   */
  async *#stream(
    options: GenerateOptions,
    entry?: ChatEntry,
    trace?: { chatId: string, kind: string, caller?: string, turn?: number },
    side?: { entry: ChatEntry, caller: string, source: SideSource },
  ): AsyncIterable<StreamChunk> {
    // **The route is settled before anything else runs**, and here rather than
    // at each of the four callers: a turn, `script.generateRaw`,
    // `script.generate` and the compaction summarizer all compose
    // `provider: settings.provider` from their own read of the settings, and a
    // check written per caller is a check three callers have and the fourth
    // one added next year does not. `#resolveRoute` installs what it can and
    // falls back to the host's own route when the name is dangling, so the
    // substitution lands *before* the fingerprint and `noteRoute` below —
    // which must name the route the provider was actually billed on, not the
    // one the settings asked for.
    const routed = await this.#resolveRoute(options.provider, entry?.chatId ?? side?.entry.chatId ?? trace?.chatId)
    const asked = routed === options.provider ? options : { ...options, provider: routed }
    // The templates run here because here is the only place that has both the
    // assembled prompt and the chat it belongs to. `#generateRaw` reaches this
    // with no entry and is left alone deliberately: its prompt is written by
    // this host, not by a card, so there is nothing of the author's to evaluate.
    const request = entry === undefined ? asked : await this.#applyTemplates(asked, entry)
    const messages = [
      ...request.system === undefined ? [] : [{ text: request.system }],
      ...request.messages.map(message => ({ text: textOf(message) })),
    ]
    // The corrected number, which is what `observe` must be given: passing the
    // raw estimate would make the correction compound on itself.
    const estimated = this.#counter.countRequest(messages, { templateOverhead: this.#options.templateOverhead })

    // The last thing before the provider, so it sees everything — macros,
    // templates, injections. An unexpanded macro is the one prompt defect with
    // no symptom at all: the braces go out, the model answers around them, and
    // the reply looks like an ordinary refusal to follow the format.
    // A scope a macro asked for and this host has no store for. It rendered as
    // `null`, which is what an empty store renders as too — so without this the
    // difference between "you have not set that" and "Iris never built that"
    // never reaches anyone.
    if (entry !== undefined && entry.unsupportedScopes.size > 0) {
      const scopes = [...entry.unsupportedScopes].join(', ')
      entry.unsupportedScopes.clear()
      this.#report(
        `a macro read the ${scopes} variable scope, which Iris has no store for — it rendered as null, `
        + 'which is not a statement that the value is unset',
        { kind: 'prompt', grade: 'fault', chatId: entry.chatId },
      )
    }

    const residual = residualMacros(messages.map(message => message.text).join(' '))
    if (residual.length > 0) {
      // Attributed, not merely listed. An unattributed list of names reads as a
      // complaint about the card, because that is the nearest suspect a reader
      // has — and for the half of them this host is supposed to expand, the card
      // is innocent.
      const registry = defaultRegistry()
      const { ours, theirs } = attributeResidualMacros(
        residual,
        name => registry.has(name) || isHelperMacroName(name),
      )
      if (ours.length > 0) {
        this.#report(
          `${ours.join(', ')} reached the provider unexpanded — Iris implements these, so the expansion did not reach that text`,
          { kind: 'prompt', grade: 'fault', ...entry === undefined ? {} : { chatId: entry.chatId } },
        )
      }
      if (theirs.length > 0) {
        this.#report(
          `${theirs.join(', ')} reached the provider unexpanded — nothing here implements these, so they are the card's own (a typo, or a macro one of its scripts registers)`,
          { kind: 'prompt', grade: 'note', ...entry === undefined ? {} : { chatId: entry.chatId } },
        )
      }
    }

    // **Which body went out, recorded before it goes.** A turn that comes back
    // with `cacheReadTokens: 0` has two possible causes — we sent something
    // different from last turn, or the provider did not serve its cache — and
    // after the fact nothing could tell them apart, because the request is
    // gone. Taken from `request` rather than from `options`: the templates and
    // the macro pass above have already run, so this is the body the provider
    // sees. A side generation (`#generateRaw`, `#sideGenerate`) arrives here
    // with no entry and has no candidate to file this record against, so it
    // records nothing *here* — it takes the `side` route below instead, which
    // files the same fingerprint on the conversation's header once the
    // provider has said what it charged (`DEVIATIONS.md` §47).
    const fingerprint = fingerprintRequest(request)
    const pendingTurn = entry?.pending?.turn
    if (entry !== undefined && pendingTurn !== undefined) {
      entry.notePromptFingerprint(pendingTurn, fingerprint)
      // **The route and the moment, from the same request the fingerprint was
      // taken from.** A stored cost that names no model can be added up and
      // nothing more — which is the state every record written before this line
      // is in — so "which model is this costing me" is not a question the
      // corpus could answer. Taken from `request` rather than from `options`
      // for the reason the fingerprint gives above: this is the body the
      // provider actually sees, so it is the route it is actually billed on.
      // `at` is the request's moment, not the reply's; `UsageRoute` says why.
      //
      // Both fields are required on `GenerateOptions` and are still checked for
      // emptiness: a host started with no model configured composes a request
      // with `model: ''`, and a blank string reaching the summary would draw a
      // chart series with no label — the unknown case wearing a known case's
      // clothes. Blank is dropped, so it reads as unknown, which it is.
      entry.noteRoute(pendingTurn, {
        ...request.model === '' ? {} : { model: request.model },
        ...request.provider === '' ? {} : { provider: request.provider },
        at: Date.now(),
      })
    }
    let cacheReadTokens: number | undefined
    let inputTokens: number | undefined
    // What surfaced in the report panel, when the reply did not complete. The
    // trace below records it so a reader comparing two adjacent turns can tell
    // an interrupted one from a free one — and knows *why* the figures are
    // missing. Set only for a genuine failure to finish: a user pressing stop
    // surfaces as an `AbortError`, which is the caller's own decision and is a
    // note, not a fault (the adapter rethrows it untouched, and `#fail` settles
    // the partial the user kept), so it is never recorded as an error.
    let streamFailure: string | undefined
    // The request's moment, taken once. The trace, the report line below and a
    // side generation's own record all describe this request, and three
    // `Date.now()` calls around a stream that ran for a minute would describe
    // three.
    const sentAt = Date.now()
    // What a not-a-turn generation cost, held until the `finally` can store it.
    // Held rather than written on the spot for one reason: a record has to
    // reach disk, and `chats.save` is a file write that must not run inside
    // the loop yielding chunks to whoever is consuming this stream.
    let sideUsage: TurnUsage | undefined
    /*
     * **The stopwatch, in the one funnel every generation passes through.**
     *
     * Four moments, three of them read off the chunks themselves:
     *
     * - `sentAt` above is the start, and it is the same moment `noteRoute`
     *   stamps — reused rather than taken again, so the cost's `at` and the
     *   timer's `gen_started` cannot disagree by the width of the macro pass.
     * - `firstTokenAt` is the first chunk carrying **any** output the model
     *   produced, a reasoning delta counting exactly as much as a text one:
     *   upstream's own time-to-first-token is set on the first chunk of its
     *   generator whatever it holds (`public/script.js:3819`), and on a
     *   reasoning model the first visible word can be a minute after the model
     *   started answering.
     * - `reasoningEndAt` is where the thinking stopped, which upstream reads as
     *   "the first content delta after reasoning was under way" (its
     *   `ReasoningHandler` sets `endTime` when the message text changes while
     *   the state is still `Thinking`, `public/scripts/reasoning.js:448`) and
     *   otherwise as the last reasoning it saw. Both are here, in that order.
     * - `lastChunkAt` is the end. The `finally` below cannot take it itself:
     *   that block runs after the consumer has finished with the final chunk,
     *   so it would fold the shell's broadcast and the assembler's work into
     *   the model's time. The last chunk's own arrival is the moment the
     *   provider stopped speaking, which is what `gen_finished` means.
     *
     * Nothing here is per-turn state: a side generation runs through this same
     * loop and is measured the same way. What it has no room for is the
     * *record* — see the `finally`.
     */
    let firstTokenAt: number | undefined
    let reasoningEndAt: number | undefined
    let reasoningClosed = false
    let lastChunkAt: number | undefined
    try {
      for await (const chunk of this.#options.stream(request)) {
        lastChunkAt = Date.now()
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
          firstTokenAt ??= lastChunkAt
          if (chunk.type === 'reasoning-delta') {
            // Every reasoning delta moves the end forward, so a stream that
            // was still reasoning when it closed has an end anyway.
            if (!reasoningClosed) reasoningEndAt = lastChunkAt
          } else if (reasoningEndAt !== undefined && !reasoningClosed) {
            // The first visible word after thinking — upstream's own boundary,
            // and the last time this may move. It is *this* moment and not the
            // previous reasoning delta's, because that is what upstream
            // records and the two differ by the pause a reader sees.
            reasoningEndAt = lastChunkAt
            reasoningClosed = true
          }
        }
        if (chunk.type === 'usage') {
          this.#counter.observe(estimated, chunk.usage.inputTokens)
          // Recorded beside the estimate so a user can see whether to trust it.
          const turn = entry?.pending?.turn
          const recorded = turn === undefined ? undefined : entry?.itemizations.get(turn)
          if (recorded !== undefined) recorded.actualTokens = chunk.usage.inputTokens
          cacheReadTokens = chunk.usage.cacheReadTokens
          inputTokens = chunk.usage.inputTokens
          // **The whole report, kept.** The estimator above takes one number out
          // of it and throws the rest away, which is what this code did in full
          // until now: `cacheReadTokens` — the figure that decides what a long
          // chat costs — was arriving on every DeepSeek reply and being dropped.
          // Held on `pending` and attached to the candidate when the turn settles,
          // because the candidate does not exist yet.
          if (turn !== undefined) entry?.noteUsage(turn, chunk.usage)
          // **The same report, for a generation that will never have a
          // candidate.** The route and the moment are merged on here rather
          // than parked on `pending` and merged at settle time, because there
          // is no settle: this record is complete now. Taken from `request`,
          // like the turn's, so it names the route the provider actually
          // billed; blank is dropped so it reads as unknown rather than as a
          // chart series with no label.
          if (side !== undefined) {
            sideUsage = {
              ...chunk.usage,
              ...request.model === '' ? {} : { model: request.model },
              ...request.provider === '' ? {} : { provider: request.provider },
              at: sentAt,
              source: side.source,
            }
          }
        }
        yield chunk
      }
    } catch (error: unknown) {
      // The reply never completed: hold onto what the report panel will say so
      // the trace written below can name the failure. The adapter has already
      // turned undici's bare `terminated` into a sentence naming the peer close
      // and the missing usage; whatever arrives here is what `#fail` broadcasts
      // verbatim as `stream.error`, so recording it makes the trace and the
      // report agree. Rethrown untouched — `#fail` still owns how the turn
      // settles.
      if (!(error instanceof Error && error.name === 'AbortError')) {
        streamFailure = error instanceof Error ? error.message : String(error)
      }
      throw error
    } finally {
      // **The stopwatch, filed on the turn.** First in the `finally` and in a
      // `finally` at all for the reason the side bill below gives: an abort and
      // a provider failure are exactly the generations whose duration is worth
      // having, and a record written only on the happy path would be missing
      // from every turn a reader is trying to explain. `#fail` settles a kept
      // partial through `#settle`, which is where `recordTiming` picks this up.
      //
      // Read off `pendingTurn`, the turn this request was composed for, rather
      // than `entry.pending?.turn` again: the second read can have moved (the
      // turn settled and another began) and `noteTiming`'s own guard would then
      // silently drop the record instead of refusing the wrong one.
      //
      // **Side generations are left out, and that is a decision.** A card's
      // `TavernHelper.generate` and the host's compaction summary have no
      // candidate and land on the chat header (`./side-usage.ts`), where
      // upstream has no timer field and Iris has no surface — so a duration
      // stored there would be a number nothing reads. §67 records it as the
      // open follow-up.
      if (entry !== undefined && pendingTurn !== undefined) {
        const finishedAt = lastChunkAt ?? Date.now()
        // Never negative, whatever the clock did between the two readings: a
        // duration that ran backwards is what upstream's own timer refuses to
        // render (`isNaN(seconds) || seconds < 0`, `public/script.js:2700`),
        // and `./timing.ts` refuses to read one back.
        const durationMs = Math.max(0, finishedAt - sentAt)
        entry.noteTiming(pendingTurn, {
          startedAt: sentAt,
          durationMs,
          // Clamped the same way and for the same reason. Absent — never
          // zero — when nothing ever arrived, which is the shape of a request
          // that failed before its first token: `0` there would read as
          // "answered instantly".
          ...firstTokenAt === undefined ? {} : { firstTokenMs: Math.max(0, firstTokenAt - sentAt) },
          ...reasoningEndAt === undefined ? {} : { reasoningMs: Math.max(0, reasoningEndAt - sentAt) },
        })
      }
      // **A generation that is not a turn, billed to its conversation.** In
      // the `finally` rather than in the loop, because that
      // is what covers the abort and the provider error: a request that
      // reported its usage and then failed was still charged, and dropping it
      // would leave a gap exactly where a reader is comparing what they paid
      // against what they can see.
      //
      // Guarded on `sideUsage` and not on `side`: a provider that reported
      // nothing leaves no record at all, rather than a zero-filled one — the
      // rule `recordUsage` states for the turn side, for the same reason (an
      // invented `0` is a claim about a generation nobody measured).
      //
      // The fingerprint rides along, so "did this card's request read the
      // cache, and was it sending the same prefix as last time" is answerable
      // from the stored record instead of only from a trace that rotates
      // after eight.
      if (side !== undefined && sideUsage !== undefined) {
        side.entry.noteSideUsage({
          usage: sideUsage,
          caller: side.caller,
          fingerprint,
        })
        try {
          await this.#options.chats.save(side.entry)
        } catch {
          // A bookkeeping write must not replace the generation's own outcome,
          // and must not turn a successful card call into a failure. The
          // record is already on the in-memory header, so a later save — the
          // next turn's — picks it up; what is lost is only durability across
          // a crash in between.
        }
      }
      // In a `finally`, so **every** generation leaves exactly one line — an
      // aborted one and a refused one included. Those are the turns whose cache
      // figure is missing, and a report that skipped them would leave a gap
      // exactly where a reader is counting turns to compare two prefixes.
      // A note, not a fault: nothing here is wrong, it is a measurement.
      if (entry !== undefined) {
        try {
          this.#report(fingerprintLine(fingerprint, cacheReadTokens), {
            kind: 'prompt',
            grade: 'note',
            chatId: entry.chatId,
            ...entry.meta.characterId === undefined ? {} : { characterId: entry.meta.characterId },
          })
        } catch {
          // A note must not replace the failure it was written beside. This is
          // the one report site that runs in a `finally`, so a host whose
          // `onError` throws would otherwise surface *its* error to the user
          // instead of the provider's — the generation error would be lost on
          // the way out of the generator.
        }
      }
      // **The body itself, kept on disk.** The line above settles whether the
      // prompt changed; this settles *where* and *whose text*, which no hash
      // can. In the same `finally` and for the same reason: an aborted turn is
      // a turn whose cache figure is missing, and it is exactly the turn a
      // reader is trying to place.
      //
      // Written last, so a store that is slow or full cannot delay the report.
      // `write` never throws — the trace exists to explain a cost and must not
      // be able to fail the generation that paid it — so there is no `catch`
      // here to add.
      const store = this.#options.cacheTrace
      if (trace !== undefined && store !== undefined && store.enabled) {
        await store.write(traceOf(
          request,
          {
            chatId: trace.chatId,
            kind: trace.kind,
            ...trace.caller === undefined ? {} : { caller: trace.caller },
            // The turn a caller stated, or the one in flight. A side generation
            // states `-1`: it is billed and it is not a turn, and folding it
            // onto whatever turn happened to be pending would file a card's
            // request against the user's.
            turn: trace.turn ?? entry?.pending?.turn ?? -1,
          },
          sentAt,
          { ...inputTokens === undefined ? {} : { inputTokens },
            ...cacheReadTokens === undefined ? {} : { cacheReadTokens } },
          streamFailure,
        ))
      }
    }
  }

  /**
   * Run the chat's EJS templates over one assembled prompt.
   *
   * Nothing here is allowed to cost the caller a generation. A template that
   * throws keeps its original text, a batch that overruns keeps the rest, and a
   * write the host would refuse is reported rather than raised — upstream's own
   * behaviour, and the only one under which a card with one broken template is
   * still playable.
   * @param options - the assembled request.
   * @param entry - the conversation it was assembled for.
   * @returns the request to send, rewritten where a template succeeded.
   */
  async #applyTemplates(options: GenerateOptions, entry: ChatEntry): Promise<GenerateOptions> {
    const templates = this.#options.templates
    if (templates === undefined) return options
    // Before the fork, not after: a chat with no `<%` anywhere must not pay for
    // a child process and a 3 MiB snapshot to be told it had nothing to do.
    if (!promptHasTemplate(options)) return options

    // The message scope hangs off the turn being generated. A prompt assembled
    // outside a turn has none, and `0` is what the evaluator's own backstop
    // reads as "no candidate here" — an empty table rather than another turn's.
    const turn = entry.pending?.turn ?? 0
    this.#traceId += 1

    try {
      const evaluated = await evaluatePrompt(
        options,
        buildSnapshot(entry, turn, this.#traceId),
        entry.chatId,
        templates.deadlineMs,
      )
      for (const failure of evaluated.failures) {
        this.#report(`${failure.origin} failed: ${failure.message}`, { kind: 'template', grade: 'fault', chatId: entry.chatId })
      }
      if (evaluated.ops.length > 0) {
        // Applied separately so a single refused write does not throw away the
        // text every other template produced.
        try {
          applyOps(entry, evaluated.ops, turn,
            reason => { this.#report(reason, { kind: 'template', grade: 'fault', chatId: entry.chatId }) })
        } catch (error: unknown) {
          this.#report(error, { kind: 'template', grade: 'fault', chatId: entry.chatId })
        }
      }
      return evaluated.options
    } catch (error: unknown) {
      // The evaluator promises not to throw for a template's sake, so anything
      // arriving here is the host's own failure — a child that could not be
      // forked, a snapshot that could not be built. The generation still goes
      // out, with `<%` in it, which is visible rather than silent.
      this.#report(error, { kind: 'host', grade: 'fault', chatId: entry.chatId })
      return options
    }
  }

  /**
   * Replace the text of one or more lines, through the one path that knows how.
   *
   * A floor's text lives in its swipe list and `mes` only points at one entry;
   * writing `mes` alone is undone by the next swipe back and forth. That is why
   * a card's `setChatMessages` and a user's edit share this rather than having
   * one each — the rule is subtle enough that a second implementation would get
   * it wrong, and the failure would look like a swipe losing an edit rather than
   * like a missing line of code.
   *
   * Every id is checked before anything is written: a batch that rewrote three
   * floors and then refused the fourth would leave a conversation half-edited
   * with no record of which half.
   * @param entry - the conversation, already known idle.
   * @param edits - the lines to replace.
   * @returns the view, already announced.
   * @throws {AppError} `not-found` when any id names no line.
   */
  /**
   * Rewrite message bodies in place.
   * @param entry - the open conversation.
   * @param edits - message id and its new text.
   * @param persist - whether to write the file here.
   *
   *   True for a user's edit, which is a complete action on its own. False for a
   *   card's `setChatMessages`, because a card's writes arrive as a batch across
   *   three arms and a save inside any one of them commits **everything queued
   *   before it** — measured: an append that had not been written reached the
   *   file as a side effect of a later rewrite. A batch that then fails leaves
   *   half of itself on disk while the card is told it failed.
   *
   *   Upstream saves in all three of its equivalents, but through
   *   `saveChatConditionalDebounced` (`chat_message.ts:172`), which coalesces —
   *   so committing once at the end of a batch is *closer* to upstream than
   *   committing per call. The façade calls `script.saveChat` to do it.
   */
  async #rewriteLines(
    entry: ChatEntry,
    edits: readonly { messageId: number, message: string }[],
    persist = true,
  ): Promise<ChatView> {
    const { messages } = entry.toFile()
    for (const edit of edits) {
      if (messages[edit.messageId] === undefined) {
        throw notFound(`this chat has no message ${String(edit.messageId)}`)
      }
    }

    for (const edit of edits) {
      const line = messages[edit.messageId] as { mes: string, swipes?: string[], swipe_id?: number }
      line.mes = edit.message
      if (line.swipes !== undefined) line.swipes[line.swipe_id ?? 0] = edit.message
    }

    entry.rebuild(messages, index => index)
    entry.touch()
    if (persist) await this.#options.chats.save(entry)
    return this.#announceChat(entry)
  }

  /**
   * Hand a survived failure to the composition's logger, and keep it.
   *
   * **A string argument means the sentence was written here; an `Error` means
   * one was caught.** That distinction is the whole stack rule, made structural
   * rather than left to discipline: a caught error's stack points at the
   * failure, while an error constructed at the report site points at the
   * report, and a stack that names the reporter reads as the origin. So only
   * the caught form carries `stack`, and a site cannot get one wrong without
   * changing what it passes.
   * @param what - a caught error, or the message this site wrote.
   * @param context - the kind, plus whatever attribution is in scope.
   */
  #report(what: unknown, context: ReportContext): void {
    const caught = what instanceof Error ? what : undefined
    const message = caught?.message ?? String(what)
    const recorded = this.#options.diagnostics?.record(context, message, caught?.stack)
    // Pushed, not merely retained, when the report is about something already
    // gone. **The stored record itself travels** — no fields are copied across,
    // so a field added to a report reaches the page in the same edit.
    //
    // A host with no buffer pushes nothing, and that is not an oversight: the
    // buffer is what mints `seq` and `at`, so without it there is no record to
    // send, only a sentence.
    if (recorded !== undefined && context.irreversible === true) {
      this.#options.broadcast({ type: 'report', report: recorded, irreversible: true })
    }
    // The log line keeps a prefix, because a logger has no fields to carry the
    // kind in. It is now uniformly `kind: message`, replacing the ad-hoc
    // prefixes each site used to write into its own text (`template `,
    // `variables: `, `script.evalTemplate: `) — the same information, in one
    // shape, and no longer duplicated in the structured record.
    this.#options.onError(caught ?? new Error(`${context.kind}: ${message}`))
  }
}

/**
 * Where the preset put its main prompt, which is what a script's `before` and
 * `after` injections are placed relative to.
 *
 * Read off the resolved contributions rather than off the preset file, because
 * the number that matters is the one `resolvePreset` computed: the order is
 * `10 × the item's position among the ones that rendered`, so it moves when the
 * user enables or disables a prompt.
 *
 * Absent has a meaning of its own — a preset whose `main` is disabled, empty,
 * or filtered out by this generation's `injection_trigger` produced no main
 * section, and upstream drops the injection entirely in that case (see
 * {@link injectedContributions}).
 * @param contributions - what the preset resolved to for this generation.
 * @returns main's placement, or undefined when the preset produced none.
 */
function mainPlacement(contributions: readonly Contribution[]): Contribution['placement'] | undefined {
  return contributions.find(item => item.id === 'main')?.placement
}

/**
 * Where one injection goes, decided exhaustively.
 *
 * **A `switch` with a `never` default rather than a chain of conditions**, and
 * the difference is not tidiness. This was
 * `position === 'at-depth' ? … : { order: position === 'before' ? 850 : 950 }`,
 * which handles two positions by name and gives **every other value the
 * `after` slot** — silently, with no compile error and no report. Adding a
 * fifth `ScriptPromptPosition` would have placed a card's text somewhere nobody
 * chose, and nothing would have said so.
 *
 * The same shape as `Set<Code>` against `Record<Code, true>`: a construct that
 * only complains about an *extra* case cannot complain about a missing one.
 *
 * **`before` and `after` are anchored to the preset's `main` prompt**, which is
 * what upstream means by them and not what this host used to do. The path:
 * `getPromptPosition` turns `BEFORE_PROMPT` into `'start'` and `IN_PROMPT` into
 * `'end'` (`public/scripts/openai.js:1131-1140`), and the only consumer of
 * those two words is `injectToMain`, which inserts the message into the **main
 * prompt's own collection** — `chatCompletion.insert(message, 'main', position)`
 * with `'start'` unshifting and `'end'` pushing (`openai.js:1256-1300`,
 * `:3940-3960`). So an injection sits immediately before or immediately after
 * the main prompt, near the TOP of the request; `850` / `950` put both of them
 * after every preset section instead (the preset's own orders are 10, 20, 30 …
 * — `chat-completion.ts:249`), which is neither of upstream's two positions.
 * A card injecting a rule for the model to follow had it land behind 400 lines
 * of preset that the rule was supposed to qualify.
 *
 * When `main` is itself an in-chat (absolute) injection, upstream places the
 * extension prompt as a depth injection copying main's depth, role and order
 * (the `else` branch of `injectToMain`) — mirrored here, because a preset that
 * moves its main prompt into the conversation would otherwise send the card's
 * text to a place no upstream branch puts it.
 * @param injection - the registered injection.
 * @param main - where this generation's main prompt landed, if it produced one.
 * @returns its placement, or undefined when the position asks for none.
 */
function placementFor(
  injection: ScriptInjection,
  main: Contribution['placement'] | undefined,
): Contribution['placement'] | undefined {
  switch (injection.position) {
    case 'at-depth':
      return { kind: 'depth', depth: injection.depth, role: injection.role ?? 'system', order: 2 }
    case 'before':
    case 'after': {
      // `±1`, because the preset's own sections are ten apart: the injection
      // lands beside main with nothing able to sort between them. Upstream
      // keeps the *same* order bucket and relies on array position instead
      // ("Keeping prompts in the same order bucket will squash them together
      // during in-chat injection", `openai.js:1268`) — a pipeline that sorts by
      // (order, sequence) cannot express "before" that way, since injections
      // are appended after the preset's contributions.
      const offset = injection.position === 'before' ? -1 : 1
      if (main?.kind === 'system') return { kind: 'system', order: main.order + offset }
      if (main?.kind === 'depth') {
        return {
          kind: 'depth',
          depth: main.depth,
          role: main.role,
          order: (main.order ?? 0) + offset,
        }
      }
      // No main section at all. Upstream loses the injection here — `injectToMain`
      // finds neither a main message nor an absolute main prompt and simply
      // returns — so there is no position to copy. Kept at the old ends of the
      // system block rather than dropped: silently deleting a card's text is
      // the one outcome that cannot be diagnosed from the prompt panel, and a
      // preset with no main prompt at all is not the case this parity is about.
      return { kind: 'system', order: injection.position === 'before' ? 850 : 950 }
    }
    case 'none':
      return undefined
    default: {
      const unreachable: never = injection.position
      throw new AppError('internal', `unknown injection position ${String(unreachable)}`)
    }
  }
}

/**
 * A card script's keyed injections, as prompt contributions.
 *
 * Placed relative to the preset's `main` prompt, which is what upstream's two
 * relative positions mean — see {@link placementFor}.
 * @param entry - the conversation holding the injections.
 * @param preset - the contributions the preset resolved to, so `before` and
 *   `after` can find main. Absent falls back to the ends of the system block.
 * @returns one contribution per live injection.
 */
/**
 * Contributions whose **source** makes them volatile, not their text: every
 * live card-script injection.
 *
 * A `setExtensionPrompt` value is computed by a script while the turn is being
 * prepared; that is what the API is for. So two turns producing the same string
 * is not evidence the third will, and this set is re-asserted on every
 * classification rather than being a first-sight guess — the classifier's rule
 * 2 rather than its rule 3.
 *
 * The asymmetry is worth the cost here in a way it is not for a macro: since
 * #17 a `'before'` injection lands at `main.order - 1`, ahead of the entire
 * preset, and `CACHE-PREFIX.md` §2.1 puts a per-turn value there at a ceiling
 * near 0.2%. Nothing else in the request can do that much damage from one
 * contribution.
 *
 * A `position: 'none'` injection contributes no text, so no contribution
 * carries its id; naming it here is harmless and cheaper than filtering, since
 * the classifier only consults ids it actually sees.
 * @param entry - the conversation, for its live injections.
 * @returns the injection contribution ids.
 */
function runtimeIds(entry: ChatEntry): Set<string> {
  const ids = new Set<string>()
  for (const key of entry.extensionPrompts.keys()) ids.add(`script.${key}`)
  return ids
}

export function injectedContributions(entry: ChatEntry, preset: readonly Contribution[] = []): Contribution[] {
  const main = mainPlacement(preset)
  const contributions: Contribution[] = []
  // **Sorted by key, because upstream is**: `getExtensionPrompt` walks
  // `Object.keys(extension_prompts).sort()` (`script.js:3249`), so within one
  // (position, depth, role) group the concatenation order is the *lexicographic
  // key order* — not the order the injections were registered in. That is why
  // upstream names its own keys `1_memory` / `2_floating_prompt` / `3_vectors`:
  // the digits are a sorting device, not a naming habit.
  //
  // Iterating the Map gave insertion order, which agrees with upstream only
  // when a card happens to inject in alphabetical order. Nothing would have
  // reported the difference — two injections would simply arrive in the other
  // sequence, and a card whose id is a UUID lands at a random position in that
  // order either way.
  for (const key of [...entry.extensionPrompts.keys()].sort()) {
    const injection = entry.extensionPrompts.get(key)
    if (injection === undefined) continue
    const placement = placementFor(injection, main)
    // `position: 'none'` is registered but never assembled — upstream's `-1` is
    // queried by no call site, so such an injection exists to be overwritten or
    // removed by key and contributes no text, which is a distinct state from
    // absent. It is the one position that yields no placement.
    if (placement === undefined) continue
    contributions.push({
      id: `script.${key}`,
      label: `Script injection (${key})`,
      placement,
      // Expanded here, at assembly, against the chat's own expander — the same
      // projection every other contribution gets from `buildPrompt`. Measured on
      // the 不要被神隐挑战 card: its engine injects a prompt carrying `{{user}}`,
      // and the raw braces reached the provider — the host's own residual-macro
      // report names exactly this as a fault ("Iris implements these, so the
      // expansion did not reach that text"). The stored value stays raw on
      // purpose: speaker names and variables are read at assembly time, so an
      // injection keeps meaning what its author wrote across turns and renames.
      text: entry.substitute(injection.value),
    })
  }
  return contributions
}

/**
 * Map a card's scope selector onto a variable store option.
 * @param scope - the scope the card named.
 * @param messageId - the turn, for the message scope.
 * @param scriptId - the partition, for the script scope.
 * @returns the option the store addresses.
 */
/**
 * Translate a card's `message_id` — a **message index** — into a turn.
 *
 * The contract says `message_id` counts messages, because two independent
 * sources say so: upstream addresses `chat.at(message_id)`, and this host's own
 * `ScriptContext.floor.messageId` is a message index. What the variable service
 * takes is a *turn*, and turns count exchanges — so without this translation a
 * non-negative id was passed through as a turn number and silently addressed a
 * different floor. Measured on a 7-message chat before the fix:
 * `setVariables({message_id: 2})` stored its table at message index 3.
 *
 * Nothing was relying on the old reading: the frame refuses every
 * `message_id` but `'latest'`, so no explicit id had ever reached this code.
 * That is the whole reason the meaning could be corrected rather than
 * grandfathered — the window closes the moment the frame opens that path, and
 * MVU's own addressing is explicit (12 sites across 13 of 19 cards), so the
 * first traffic through it will be substantial.
 *
 * **A residual, worth knowing before relying on this.** A turn owns both a user
 * line and its reply, so both indices map to one turn and therefore to one
 * candidate's table. Upstream stores a table *per message* and would answer a
 * user row with its own; this host has no per-user-row store, so a user-row id
 * reads its reply's table. The rows themselves survive in the file — see
 * `tests/user-row-variables.test.ts` — it is the variable service that has no
 * place to put them.
 * @param entry - the open conversation.
 * @param messageId - the card's message index, or absent for the latest.
 * @returns the turn to address, or undefined to mean the latest.
 * @throws {AppError} `not-found` when no message has that index.
 */
function turnForMessage(
  entry: ChatEntry,
  messageId: number | string | null | undefined,
): number | undefined {
  const lines = lineTurns(entry.session)

  // **`null` is refused by name, and this is a policy rather than an
  // improvement.** Upstream does not normalise it either, but its guards let it
  // through by accident: `_.inRange(null, …)` is true and `chat.at(null)` is
  // `chat.at(0)`, so a card that computed `null` for its target silently reads
  // — and on the write path silently *overwrites* — the opening message. A
  // read-modify-write aimed at floor 0 destroys data and then reports success,
  // which is the one class of return value worth refusing outright.
  if (messageId === null) {
    throw invalid('message_id is null; SillyTavern would silently address the first message instead')
  }
  if (messageId === undefined) return undefined

  // `'latest'` means the last **non-system** message, on the read path *and*
  // the write path. Upstream reads the last non-system message and writes the
  // last message, so a chat whose final row is a system message reads one floor
  // and writes another — silently, and only sometimes. One rule here, so this
  // host carries one fewer inconsistency rather than a matching one.
  if (messageId === 'latest') {
    const system = lineSystemFlags(entry.session)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (system[index] === true) continue
      return lines[index]
    }
    return undefined
  }

  // Numeric strings are accepted because upstream accepts them in effect:
  // `_.inRange` and `Array.prototype.at` both coerce, so `'3'` works there, and
  // a card that built its id by concatenation is not asking for anything
  // upstream would have refused.
  const asNumber = typeof messageId === 'string' ? Number(messageId) : messageId
  if (!Number.isInteger(asNumber)) {
    throw invalid(
      `message_id must be an integer, "latest", or omitted; received ${JSON.stringify(messageId)}`,
    )
  }

  // Negative ids count from the end — the domain of `Array.prototype.at`, which
  // is what upstream indexes the chat with.
  const index = asNumber < 0 ? lines.length + asNumber : asNumber
  const turn = lines[index]
  // Refused rather than clamped: an id past the end is a card that has
  // miscounted, and answering the newest floor instead would hand it a table it
  // did not ask for and cannot tell apart from the one it wanted.
  if (turn === undefined) throw notFound(`this chat has no message ${String(messageId)}`)
  return turn
}

export function variableOptionFor(
  scope: 'message' | 'chat' | 'global' | 'script',
  messageId?: number,
  scriptId?: string,
): Parameters<ChatEntry['variables']['getVariables']>[0] {
  if (scope === 'message') {
    return messageId === undefined ? { type: 'message' } : { type: 'message', message_id: messageId }
  }
  if (scope === 'script') {
    return scriptId === undefined ? { type: 'script' } : { type: 'script', script_id: scriptId }
  }
  return { type: scope }
}

/**
 * The sampling fields the harness does not carry itself.
 * @param settings - the chat's generation settings.
 * @returns the extra sampling block, with only the fields that are set.
 */
export function samplingOf(settings: GenerationSettings): GenerateOptions['sampling'] {
  return {
    ...settings.topP === undefined ? {} : { topP: settings.topP },
    ...settings.topK === undefined ? {} : { topK: settings.topK },
    ...settings.minP === undefined ? {} : { minP: settings.minP },
    ...settings.repetitionPenalty === undefined ? {} : { repetitionPenalty: settings.repetitionPenalty },
    ...settings.frequencyPenalty === undefined ? {} : { frequencyPenalty: settings.frequencyPenalty },
    ...settings.presencePenalty === undefined ? {} : { presencePenalty: settings.presencePenalty },
    ...settings.seed === undefined ? {} : { seed: settings.seed },
    ...settings.reasoningEffort === undefined ? {} : { reasoningEffort: settings.reasoningEffort },
  }
}


/**
 * The host-wide off switch for the cache-friendly reorder.
 *
 * `IRIS_CACHE_FRIENDLY=0` (or `false`) disables it for every chat whatever the
 * per-chat setting says — one line in the environment restores byte-for-byte
 * SillyTavern order across a whole installation, which is what an operator
 * needs when the question is "is the reorder causing this?". Anything else, the
 * variable being unset included, leaves the decision to the setting.
 *
 * Read per assembly rather than captured at construction, so an operator does
 * not have to reason about when the host last started.
 * @returns false when the environment forbids the reorder.
 */
function cacheFriendlyAllowed(): boolean {
  const flag = process.env['IRIS_CACHE_FRIENDLY']
  return !(flag === '0' || flag?.toLowerCase() === 'false')
}

/**
 * Whether this chat assembles cache-friendly.
 *
 * **Default on**, and that is the one place this feature is not conservative:
 * the measured ceiling *without* it is 21.9% for a card that puts a `{{roll}}`
 * near the front of its world info (`CACHE-PREFIX.md` §1.3), and a default that
 * has to be found in a drawer is a default nobody gets. `cacheFriendly: false`
 * on the chat — or on the global layer under it — turns it off; the environment
 * can veto both.
 * @param settings - the chat's merged settings.
 * @returns whether to reorder.
 */
function cacheFriendlyOf(settings: GenerationSettings): boolean {
  return cacheFriendlyAllowed() && settings.cacheFriendly !== false
}

/**
 * The markers upstream refuses to let the user untoggle, and the one rule the
 * refusal follows.
 *
 * `isPromptToggleAllowed` (PromptManager.js:1099): a *marker* not on this list
 * has no toggle at all; everything else — including `chatHistory` and
 * `dialogueExamples`, which are markers and on the list — toggles freely.
 * Mirrored exactly, because the list is upstream's opinion about which slots a
 * prompt manager cannot function without, and a slot it cannot function
 * without is a slot a preset cannot be edited to lose.
 */
const FORCE_TOGGLE_MARKERS = new Set([
  'charDescription',
  'charPersonality',
  'scenario',
  'personaDescription',
  'worldInfoBefore',
  'worldInfoAfter',
  'main',
  'chatHistory',
  'dialogueExamples',
])

/**
 * Whether the manager may toggle one prompt off, by upstream's rule.
 * @param item - the prompt.
 * @returns true when a toggle is allowed at all.
 */
function toggleAllowed(item: PromptItem): boolean {
  if (item.marker === true) return FORCE_TOGGLE_MARKERS.has(item.identifier)
  return true
}

/**
 * The scalar fields of one preset that ride the global settings layer on a
 * switch, mapped onto their GenerationSettings names.
 *
 * This is Iris's whole equivalent of upstream's 102-key `settingsToUpdate`
 * overwrite table: the keys a preset can carry that this host *acts on*, and
 * not one more. Applied to the **global** layer, so a chat-scoped override —
 * an explicit decision made for one conversation — survives a preset switch,
 * where upstream's single flat settings space has nothing to survive in.
 *
 * Garbage is skipped rather than refused: a preset with `"temperature": "high"`
 * switches fine upstream (the DOM select simply fails to match), so it must not
 * fail here either — one bad field must not take the whole preset down.
 * @param preset - the preset being switched to.
 * @returns a patch for `SettingsStore.set`, possibly empty.
 */
export function presetScalarPatch(preset: ChatCompletionPreset): Record<string, number | string | boolean> {
  const numbers: [string, keyof GenerationSettings][] = [
    ['temperature', 'temperature'],
    ['openai_max_tokens', 'maxTokens'],
    ['openai_max_context', 'contextWindow'],
    ['top_p', 'topP'],
    ['top_k', 'topK'],
    ['min_p', 'minP'],
    ['repetition_penalty', 'repetitionPenalty'],
    ['frequency_penalty', 'frequencyPenalty'],
    ['presence_penalty', 'presencePenalty'],
    ['seed', 'seed'],
  ]
  const patch: Record<string, number | string | boolean> = {}
  for (const [key, field] of numbers) {
    const value = preset[key]
    if (typeof value === 'number' && Number.isFinite(value)) patch[field] = value
  }
  // `squash_system_messages` is a checkbox in `settingsToUpdate`
  // (`openai.js:380`) and a preset carries it like any other field — the two
  // presets in the local profile disagree about it, one shipping `false`
  // explicitly. It reached `GenerationSettings.squashSystemMessages` only if a
  // user set it by hand, so switching presets left the previous preset's squash
  // running over the new preset's prompt list. Booleans are read separately
  // because the numeric loop's `typeof value === 'number'` guard silently drops
  // them.
  const squash = preset['squash_system_messages']
  if (typeof squash === 'boolean') patch['squashSystemMessages'] = squash
  /*
   * `max_context_unlocked`, which travels with `openai_max_context` and never
   * apart from it.
   *
   * The two are one decision upstream: the unlock is what makes the window
   * *reachable*, because upstream's slider bound is the model's maximum until it
   * is ticked (`openai.js:4967`). Reading the number and dropping the flag is
   * how a preset's 2 000 000 came to be in force here under a 1M model —
   * measured on the reported install: `[主预设] V19.5 狐神抚 · 毓忻.json`
   * carries `openai_max_context: 2000000` *and* `max_context_unlocked: true`,
   * and only the first half was ever applied.
   *
   * `false` is applied as deliberately as `true`. A preset that says "clamp me"
   * has said something, and leaving a previous preset's unlock standing would
   * make the window depend on the order presets were switched in.
   */
  const unlocked = preset['max_context_unlocked']
  if (typeof unlocked === 'boolean') patch['contextUnlocked'] = unlocked
  const effort = preset['reasoning_effort']
  if (typeof effort === 'string' && REASONING_EFFORT_VALUES.has(effort)) {
    patch['reasoningEffort'] = effort
  }
  // A preset is a full snapshot upstream, and a Chat Completion preset carries
  // its continue separator (`continue_postfix`, openai.js:496, default ' ').
  // Real presets tune it — the double-newline spelling is how a preset asks a
  // continued reply to start a fresh paragraph — so switching presets without
  // it would silently keep the last preset's boundary. Stored as the word, not
  // the literal, so the same refuse-garbage rule as everything else applies.
  const postfix = preset['continue_postfix']
  if (typeof postfix === 'string') {
    const word = (Object.entries(CONTINUE_POSTFIX_SEPARATORS) as [ContinuePostfix, string][])
      .find(([, separator]) => separator === postfix)?.[0]
    if (word !== undefined) patch['continuePostfix'] = word
  }
  return patch
}

/** The reasoning-effort words upstream accepts, as a set for the patch filter. */
const REASONING_EFFORT_VALUES: ReadonlySet<string> = new Set<string>(['auto', 'low', 'medium', 'high', 'min', 'max'])

/**
 * The built-in identifiers the manager must not let a new prompt overwrite.
 *
 * These are the assembler's slots — `resolvePreset` reads them from the
 * markers map, not from user text — and a `preset.upsertPrompt` that created
 * one would put literal content where the host fills in live data.
 */
const BUILTIN_MARKERS: ReadonlySet<string> = new Set([
  'main', 'nsfw', 'worldInfoBefore', 'personaDescription', 'charDescription',
  'charPersonality', 'scenario', 'enhanceDefinitions', 'worldInfoAfter',
  'dialogueExamples', 'chatHistory', 'jailbreak',
])

/**
 * The prompt manager's ordering: the global sentinel first, the legacy one as a
 * last resort — the same chain the assembler runs, kept identical so the
 * manager can only ever edit the list the assembler reads.
 * @param preset - the preset.
 * @returns the chosen order group, creating nothing.
 */
function chosenOrder(preset: ChatCompletionPreset): PromptOrder | undefined {
  const orders = preset.prompt_order ?? []
  return orders.find(entry => entry.character_id === GLOBAL_ORDER_ID)
    ?? orders.find(entry => entry.character_id === LEGACY_ORDER_ID)
}

/**
 * The manager's view of one preset: every prompt, in order, with its toggle.
 *
 * Prompts missing from the ordering sit disabled at the end, which is the
 * reading the assembler gives them too — absence from the order is how a
 * preset turns a prompt off.
 * @param name - the preset's library name, when it has one.
 * @param preset - the preset itself.
 * @returns the view.
 */
function managerViewOf(name: string | undefined, preset: ChatCompletionPreset): PresetManagerView {
  const order = chosenOrder(preset)
  const enabled = new Map((order?.order ?? []).map(entry => [entry.identifier, entry.enabled]))
  const position = new Map((order?.order ?? []).map((entry, index) => [entry.identifier, index]))

  const prompts: PresetPromptView[] = preset.prompts.map(item => {
    const absolute = item.injection_position === 'absolute' || item.injection_position === 1
    return {
      id: item.identifier,
      ...item.name === undefined ? {} : { name: item.name },
      ...item.role === undefined ? {} : { role: item.role },
      // No ordering at all runs everything on, in file order — the same
      // fallback `resolveOrder` makes.
      enabled: order === undefined ? true : enabled.get(item.identifier) ?? false,
      ...item.marker === true ? { marker: true } : {},
      ...item.system_prompt === true ? { systemPrompt: true } : {},
      ...(item.injection_position === 'relative' || item.injection_position === 'absolute')
        ? { injectionPosition: item.injection_position }
        : {},
      ...absolute && item.injection_depth !== undefined ? { injectionDepth: item.injection_depth } : {},
      ...absolute && item.injection_order !== undefined ? { injectionOrder: item.injection_order } : {},
      ...item.forbid_overrides === true ? { forbidOverrides: true } : {},
      toggleable: toggleAllowed(item),
    }
  })
  // Stable sort by order position; unpositioned prompts (Infinity) keep their
  // file order behind the ordered ones.
  prompts.sort((left, right) => (position.get(left.id) ?? Number.POSITIVE_INFINITY) - (position.get(right.id) ?? Number.POSITIVE_INFINITY))
  return {
    ...name === undefined ? {} : { name },
    prompts,
  }
}

/**
 * Give the preset an ordering group to mutate, when it has none.
 *
 * Seeded with every prompt enabled in file order — the exact semantics the
 * assembler gives an order-less preset — so the first toggle against such a
 * preset turns one prompt off instead of inventing a list that contradicts
 * what was being assembled a moment before.
 * @param preset - the preset to seed; not mutated.
 * @returns the preset carrying a global order group.
 */
function withSeededOrder(preset: ChatCompletionPreset): ChatCompletionPreset {
  if (chosenOrder(preset) !== undefined) return preset
  const seeded: PromptOrder = {
    character_id: GLOBAL_ORDER_ID,
    order: preset.prompts.map(prompt => ({ identifier: prompt.identifier, enabled: true })),
  }
  return { ...preset, prompt_order: [...preset.prompt_order ?? [], seeded] }
}
