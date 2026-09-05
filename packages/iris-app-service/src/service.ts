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

import { BlockAssembler, createAssistantMessage, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { appendCandidate, selectCandidate, SwipeError } from '@iris/chat'
import { assemble, type AssembleResult, type Contribution, type HistoryEntry } from '@iris/pipeline'
import { computeBudget, type LorebookEntry } from '@iris/lorebook'
import { evaluateBatch } from '@iris/compat-prompt-template'
import { GLOBAL_ORDER_ID, LEGACY_ORDER_ID, type ChatCompletionPreset, type PromptItem, type PromptOrder } from '@iris/preset'
import type { ChatView, GenerationSettings, IrisEvent, PresetManagerView, PresetPromptView, PromptItemization, RpcMethod, RpcRequest, RpcResponse } from '@iris/protocol'
import type { RegexScript } from '@iris/regex'
import { isHelperMacroName, parseSlashCommands } from '@iris/compat-tavernhelper'
import { checkScriptFetch, extractScripts } from '@iris/script'
import { defaultRegistry } from '@iris/macro'
import { createCalibratingCounter, type CalibratingCounter } from '@iris/tokenizer'
import { historyFromSession, TurnDriver, type GenerateEvents, type StreamFn } from '@iris/turn'
import { randomUUID } from 'node:crypto'

import { PresetStore } from './presets.ts'
import { ConnectionStore } from './connections.ts'
import type { ChatStore } from './chats.ts'
import type { ChatEntry, ScriptInjection } from './entry.ts'
import { writeTimedEffects } from './entry.ts'
import { AppError, invalid, notFound } from './errors.ts'
import { ScriptButtonStore } from './script-buttons.ts'
import { charWorldbookNames, WorldbookStore } from './worldbooks.ts'
import { activationSettingsOf } from './worldbook-settings.ts'
import type { CharacterLibrary } from './library.ts'
import { assertStorable, buildCardContext, commitChatMetadata, type ExtensionSettingsStore } from './context.ts'
import { chatLines, lineSystemFlags, lineTurns } from './entry.ts'
import { attributeResidualMacros, buildPrompt, DEFAULT_PRESET, residualMacros } from './prompt.ts'
import { CardStorageStore, QuotaExceeded, removalNote } from './card-storage.ts'
import { DiagnosticBuffer, type ReportContext } from './diagnostics.ts'
import type { PruneOptions } from './prune.ts'
import { DEFAULT_PRUNE, pruneDue } from './prune.ts'
import { runScripts } from './regex.ts'
import { evaluatePrompt, promptHasTemplate } from './templates.ts'
import { applyOps, buildSnapshot } from './template.ts'
import type { ScriptPolicyStore } from './scripts.ts'
import type { ScriptVariableStore } from './script-variables.ts'
import type { SettingsStore } from './settings.ts'
import { textOf } from './views.ts'

/** Provenance stamped on a partial reply the user stopped. */
const INTERRUPTED_SOURCE = { provider: 'iris', model: 'interrupted' } as const

/** Every method, keyed by name. */
export type Handlers = {
  [M in RpcMethod]: (params: RpcRequest<M>) => Promise<RpcResponse<M>>
}

/** What the service needs that it does not own. */
export interface AppServiceOptions {
  /** Normally `ctx.llm.stream` bound to the registry. */
  stream: StreamFn
  library: CharacterLibrary
  chats: ChatStore
  settings: SettingsStore
  /**
   * The user's decisions about card scripts.
   *
   * Optional so that a host with no page attached — a test, a headless run —
   * need not carry one. Absent means every script list is empty and no card
   * holds a document grant, which is the safe reading of "not configured".
   */
  scripts?: ScriptPolicyStore
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
   * Fetches a remote script dependency. Defaults to global `fetch`.
   *
   * Injectable so the whitelist can be tested without a network, and so a
   * deployment can route these through its own proxy.
   */
  fetchRemote?: (url: string) => Promise<{ ok: boolean, status: number, text: () => Promise<string>, headers: { get: (name: string) => string | null } }>
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
  readonly #options: Required<Omit<AppServiceOptions, 'onError' | 'scripts' | 'extensionSettings' | 'scriptButtons' | 'cardStorage' | 'worldbooks' | 'connections' | 'templates' | 'scriptVariables' | 'pruneVariables' | 'diagnostics' | 'presets' | 'presetName' | 'sillyTavernDir'>>
    & {
      onError: (error: Error) => void
      scripts?: ScriptPolicyStore
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
      onError: options.onError ?? (() => {}),
      fetchRemote: options.fetchRemote ?? ((url: string) => fetch(url)),
      ...options.scripts === undefined ? {} : { scripts: options.scripts },
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
    }
    // The manager's live state starts on whatever the caller assembled: a
    // stored selection is applied by the caller (the plugin) before the
    // handlers are ever registered, so nothing here needs to read files.
    this.#activePreset = this.#options.preset
    this.#activePresetName = options.presetName
  }

  /** How well the token estimate currently tracks the provider, for diagnostics. */
  get calibration(): { scale: number, samples: number } {
    return { scale: this.#counter.scale, samples: this.#counter.samples }
  }

  /** The prompt manager's view of the live preset. */
  #managerView(): PresetManagerView {
    return managerViewOf(this.#activePresetName, this.#activePreset)
  }

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
    const cardStorage = this.#options.cardStorage

    return {
      'chat.list': async () => ({ chats: await chats.list() }),

      'chat.create': async ({ characterId }) => {
        const entry = await chats.create(characterId, this.#options.userName)
        await this.#announceChats()
        return { view: entry.toView() }
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
        return { view: entry.toView() }
      },

      'chat.delete': async ({ chatId }) => {
        chats.cached(chatId)?.abort()
        await chats.delete(chatId)
        await settings.forget(chatId)
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
        this.#options.broadcast({ type: 'chat.updated', chatId, view: entry.toView() })
        return { chats: await chats.list() }
      },

      'chat.search': async ({ query, caseSensitive, limit }) => ({
        hits: await chats.search(query, {
          ...caseSensitive === undefined ? {} : { caseSensitive },
          ...limit === undefined ? {} : { limit },
        }),
      }),

      'chat.send': async ({ chatId, text }) => ({ turn: await this.#start(chatId, { kind: 'send', text }) }),

      'chat.regenerate': async ({ chatId }) => ({ turn: await this.#start(chatId, { kind: 'regenerate' }) }),

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
        // See `DEVIATIONS.md` for the three options and why this one.
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
        // Refused by name rather than falling back. This host runs one preset;
        // answering a request for another with the one in use would let a card
        // reason confidently about prompts that are not in the preset it asked
        // for, and nothing in its reply would say so.
        if (name !== 'in_use') {
          throw notFound(`preset "${name}" — this host only carries the one in use`)
        }

        // Read live, not captured at construction: the preset the manager
        // swapped in is the one a card's next generation assembles with, and a
        // card reading the preset should see the preset that will run.
        const preset = this.#activePreset
        const orders = preset.prompt_order ?? []
        // The same fallback chain the assembler uses, minus the enabled filter:
        // a card reads `enabled` and so needs the disabled entries too.
        const chosen = orders.find(entry => entry.character_id === GLOBAL_ORDER_ID)
          ?? orders.find(entry => entry.character_id === LEGACY_ORDER_ID)
        const enabled = new Map((chosen?.order ?? []).map(entry => [entry.identifier, entry.enabled]))

        return {
          prompts: preset.prompts.map(item => ({
            // `identifier` here, `id` on the wire: upstream's name for the field
            // is what a card matches on.
            id: item.identifier,
            // A preset with no ordering at all runs its list in file order with
            // everything on, which is what `resolveOrder` falls back to. With an
            // ordering present, an item missing from it is off — being absent
            // from the order is how a preset turns a prompt off.
            enabled: chosen === undefined ? true : enabled.get(item.identifier) ?? false,
            ...item.role === undefined ? {} : { role: item.role },
            ...item.content === undefined ? {} : { content: item.content },
          })),
        }
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
        const view = child.toView()
        this.#options.broadcast({ type: 'chat.updated', chatId, view: (await chats.open(chatId)).toView() })
        return { view, chats: await chats.list() }
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
        this.#options.broadcast({ type: 'chat.updated', chatId, view: entry.toView() })
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

        // The corpus's only pattern, and the only one with a meaning Iris can
        // honour exactly. A lone `/send` means "insert without generating", and
        // treating it as this pair would start a generation the card explicitly
        // did not ask for — spending the user's tokens. Doing more silently is
        // worse than doing less.
        if (names.length !== 2 || names[0] !== 'send' || names[1] !== 'trigger') {
          throw new AppError(
            'unsupported',
            `only "/send <text>|/trigger" is supported; got "${names.map(name => `/${name}`).join('|')}". `
            + 'A lone /send would need a method that inserts without generating, which does not exist yet.',
          )
        }

        const first = commands[0]
        if (first?.name !== 'send') throw invalid('the pipeline lost its /send')
        await this.#start(chatId, { kind: 'send', text: first.text })
        // Upstream resolves with the pipeline's result; this pair produces none.
        return { result: '' }
      },

      'connection.list': async () => this.#connections().list(),

      'connection.save': async (input) => this.#connections().save({
        provider: input.provider,
        model: input.model,
        ...input.id === undefined ? {} : { id: input.id },
        ...input.label === undefined ? {} : { label: input.label },
        ...input.preset === undefined ? {} : { preset: input.preset },
        ...input.sampling === undefined ? {} : { sampling: input.sampling },
      }),

      'connection.delete': async ({ id }) => this.#connections().delete(id),

      'connection.activate': async ({ id, chatId }) => {
        const store = this.#connections()
        const profile = await store.get(id)
        // Applied through `settings.set`, so a profile cannot install a value
        // that setting it by hand would have been refused.
        const applied = await settings.set(chatId, ConnectionStore.patchOf(profile))
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

      'character.list': async () => ({ characters: await library.list() }),

      'character.import': async ({ filename, content }) => ({
        character: await library.import(filename, content),
      }),

      'character.delete': async ({ characterId }) => {
        await library.delete(characterId)
        // Every per-character store, not just the ones that happened to have a
        // `forget`. Ids are minted from the card's name against the cards that
        // exist, so deleting one frees its id and the next card imported under
        // that name inherits whatever was left behind. For the script policy
        // that includes `documentGranted` — a grant the user gave to one card
        // would silently apply to another.
        await this.#options.extensionSettings?.forget(characterId)
        await this.#options.scriptButtons?.forget(characterId)
        await this.#options.scriptVariables?.forget(characterId)
        await scripts?.forget(characterId)
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

      'settings.get': ({ chatId }) => Promise.resolve({ settings: settings.get(chatId) }),

      'settings.set': async ({ chatId, settings: patch }) => ({
        settings: await settings.set(chatId, patch),
      }),

      // World books that live in their own files rather than inside a card.
      // Reads only: the write half of this family is a ruling item, because
      // replacing a book is a whole-file replacement and the decision about
      // whether Iris performs one at a card's request has not been made.
      'worldbook.names': async () => ({ names: await worldbooks?.names() ?? [] }),
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
        this.#options.broadcast({ type: 'chat.updated', chatId, view: entry.toView() })
        const bound = entry.header.chat_metadata['world_info']
        return { name: typeof bound === 'string' ? bound : null }
      },
      'worldbook.settings': async () => ({ settings: this.#options.settings.worldbookSettings() }),
      'worldbook.setSettings': async patch => ({
        settings: await this.#options.settings.setWorldbookSettings(patch),
      }),
      'worldbook.charNames': async ({ characterId }) => {
        const card = await library.load(characterId)
        return charWorldbookNames(card)
      },

      'script.list': async ({ characterId }) => {
        // A host with no policy store cannot remember an answer, so it must not
        // claim one was given: `scriptsAllowed` stays absent rather than `false`.
        // Absent is "not asked", and a host that cannot store the answer is
        // exactly a host that has never asked.
        if (scripts === undefined) return { scripts: [], documentGranted: false }
        const card = await library.load(characterId)
        const allowed = await scripts.scriptsAllowed(characterId)
        return {
          scripts: await scripts.view(characterId, card, await this.#options.scriptButtons?.all(characterId) ?? {}),
          documentGranted: await scripts.documentGranted(characterId),
          // Omitted rather than sent as `undefined`, because the key's absence
          // is the third state and `exactOptionalPropertyTypes` makes the
          // difference a type error rather than a convention.
          ...allowed === undefined ? {} : { scriptsAllowed: allowed },
        }
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

      'script.setEnabled': async ({ characterId, scriptId, enabled }) => {
        if (scripts === undefined) throw new AppError('unsupported', 'script policy is not configured on this host')
        const card = await library.load(characterId)
        // Refused for a script the card does not have, rather than stored: a
        // policy file that accumulates ids from typos and stale cards is a
        // policy file nobody can audit.
        const known = await scripts.view(characterId, card, await this.#options.scriptButtons?.all(characterId) ?? {})
        if (!known.some(row => row.id === scriptId)) {
          throw notFound(`${characterId} has no script "${scriptId}"`)
        }
        await scripts.setEnabled(characterId, scriptId, enabled)
        return { scripts: await scripts.view(characterId, card, await this.#options.scriptButtons?.all(characterId) ?? {}) }
      },

      'script.body': async ({ characterId, scriptId }) => {
        const card = await library.load(characterId)
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
            worldbookSettings: settings.worldbookSettings(),
            ...cardStorage === undefined ? {} : { storage: await cardStorage.snapshot() },
            characters: await library.list(),
            ...messageId === undefined ? {} : { messageId },
            onReport: message => { this.#report(message, { kind: 'script', grade: 'note', chatId, characterId }) },
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

      'script.fetch': async ({ url }) => {
        const verdict = checkScriptFetch(url)
        // `unsupported` and not `invalid-request`: the URL is well-formed and
        // the request is understood, it is the source that is not allowed, and
        // the message names the host so the person holding the card can see why.
        if (!verdict.allowed) throw new AppError('unsupported', verdict.reason)

        const fetcher = this.#options.fetchRemote
        let response: Awaited<ReturnType<NonNullable<AppServiceOptions['fetchRemote']>>>
        try {
          response = await fetcher(verdict.url)
        } catch (cause: unknown) {
          throw new AppError('provider-error', `could not reach ${new URL(verdict.url).hostname}: ${String(cause)}`)
        }
        if (!response.ok) {
          throw new AppError('provider-error', `${new URL(verdict.url).hostname} answered ${String(response.status)}`)
        }
        const contentType = response.headers.get('content-type')
        return {
          content: await response.text(),
          ...contentType === null ? {} : { contentType },
        }
      },
    }
  }

  /** The connection store, or a refusal naming why there is none. */
  #connections(): ConnectionStore {
    const store = this.#options.connections
    if (store === undefined) {
      throw new AppError('unsupported', 'connection profiles are not configured on this host')
    }
    return store
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

  /** Push a chat's settled view and return it. */
  #announceChat(entry: ChatEntry): ReturnType<ChatEntry['toView']> {
    const view = entry.toView()
    this.#options.broadcast({ type: 'chat.updated', chatId: entry.chatId, view })
    return view
  }

  /** Push the conversation list. */
  async #announceChats(): Promise<void> {
    this.#options.broadcast({ type: 'chats.updated', chats: await this.#options.chats.list() })
  }

  /**
   * Open a turn and start generating into the event stream.
   *
   * Returns the turn number rather than the reply: the driver's first
   * statements are synchronous, so by the time this resolves the turn is on the
   * log and the client can start correlating `stream.*` frames to it.
   * @param chatId - the conversation.
   * @param request - a new user message, or a reroll of the last turn.
   * @returns the turn now generating.
   * @throws {AppError} `busy` when one already is, `invalid-request` when there
   *   is no turn to reroll.
   */
  async #start(chatId: string, request: { kind: 'send', text: string } | { kind: 'regenerate' }): Promise<number> {
    const entry = await this.#options.chats.open(chatId)
    const turn = request.kind === 'send' ? entry.lastTurn + 1 : entry.lastTurn
    if (turn < 0) throw invalid('this chat has no turn to regenerate')

    const signal = entry.begin(turn)
    const driver = this.#driver(entry)
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

    const running = request.kind === 'send'
      // The storage direction runs on what the user typed, before it enters the
      // log — the one point where a message is written for the first time.
      ? driver.send(
        entry.session,
        runScripts(request.text, 'user', entry.scripts, { substitute: entry.substitute }),
        events,
      )
      : driver.regenerate(entry.session, events)

    // Announced after the call, not before: `send` appends the user's line
    // synchronously at the top of the driver, and until it has, the spare key
    // slot belongs to that line rather than to the reply. Nothing can have been
    // emitted yet — the first delta waits on the network — and the ordering is
    // pinned by test rather than argued.
    this.#options.broadcast({ type: 'stream.start', chatId, turn, key: entry.streamingKeyFor(turn) })

    void running.then(
      candidate => this.#settle(entry, turn, textOf(candidate.message), 'completed'),
      error => this.#fail(entry, turn, signal, error),
    )

    return turn
  }

  /** Record a finished candidate and tell every page. */
  async #settle(
    entry: ChatEntry,
    turn: number,
    text: string,
    reason: 'completed' | 'aborted',
  ): Promise<void> {
    try {
      // Variables first: a permanent script may be there precisely to strip the
      // command block, and the commands have to be read before it does.
      // Reported, not swallowed: a reply whose update block nothing understood
      // is indistinguishable from a model that never wrote one, and telling
      // those apart is the difference between "the card is broken" and "we are".
      entry.recordVariables(turn, text, message => {
        this.#report(message, {
          kind: 'mvu',
          grade: 'fault',
          chatId: entry.chatId,
          ...entry.meta.characterId === undefined ? {} : { characterId: entry.meta.characterId },
        })
      })
      this.#storeRewritten(entry, entry.scripts, text)
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
      this.#options.broadcast({
        type: 'stream.end', chatId: entry.chatId, turn, view: entry.toView(), reason,
      })
      await this.#announceChats()
    } catch (cause: unknown) {
      entry.finish()
      this.#report(cause, { kind: 'host', grade: 'fault', chatId: entry.chatId })
    }
  }

  /**
   * Report a turn that did not finish.
   *
   * A stop is not a failure: SillyTavern keeps whatever the model produced
   * before the user pressed stop, and throwing away half a reply the user
   * decided was good enough is worse than the abort itself. So a stopped turn
   * with text becomes a real candidate and settles normally.
   */
  async #fail(entry: ChatEntry, turn: number, signal: AbortSignal, error: unknown): Promise<void> {
    const partial = entry.pending?.text ?? ''

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
        await this.#settle(entry, turn, partial, 'aborted')
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
      code: signal.aborted ? 'aborted' : 'provider-error',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  /** Build the driver for one chat, with its current settings. */
  #driver(entry: ChatEntry): TurnDriver {
    const settings: GenerationSettings = this.#options.settings.get(entry.chatId)
    const count = (text: string): number => this.#counter.count(text)
    const names = entry.names

    return new TurnDriver({
      stream: options => this.#stream(options, entry),
      provider: settings.provider,
      model: settings.model,
      contributions: session => this.#contributions(entry, session, count),
      history: session => this.#history(entry, session),
      budget: {
        context: windowOf(settings, this.#options.contextWindow),
        reserve: this.#options.reserveTokens,
        count,
      },
      ...settings.temperature === undefined ? {} : { temperature: settings.temperature },
      ...settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens },
      ...settings.stop === undefined ? {} : { stop: settings.stop },
      sampling: samplingOf(settings),
    })
  }

  /**
   * One generation's prompt policy, plus whatever a card script has injected.
   * @param entry - the conversation.
   * @param session - the log to assemble from.
   * @param count - the token counter the budget uses.
   * @returns the contributions for this generation.
   */
  async #contributions(
    entry: ChatEntry,
    session: Session,
    count: (text: string) => number,
    record = true,
  ): Promise<Contribution[]> {
    const names = entry.names
    const settings: GenerationSettings = this.#options.settings.get(entry.chatId)
    const window = windowOf(settings, this.#options.contextWindow)
    // The scan knobs, read per assembly: the settings file can change while the
    // host runs, and a chat opened before the change must still scan with what
    // the user set, not with what was set when the chat was opened.
    const worldbookSettings = this.#options.settings.worldbookSettings()
    // The budget macros report the numbers this generation actually runs under:
    // the context window, and the reply budget — `maxTokens` when the chat
    // configures one, else the reserve every assembly holds back for the reply.
    // Assigned before the prompt is built, because the build's expansions are
    // what read it.
    entry.tokenBudget = {
      context: window,
      response: settings.maxTokens ?? this.#options.reserveTokens,
    }
    const built = buildPrompt({
      card: entry.card,
      ...entry.worldbook === undefined ? {} : { worldbook: entry.worldbook },
      preset: this.#activePreset,
      userName: names.user,
      characterName: names.character,
      // The same projection the model gets, so a world-info scan cannot match a
      // keyword inside a block the prompt scripts are about to strip.
      history: this.#history(entry, session),
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
      insertionStrategy: worldbookSettings.insertionStrategy,
      chatLore: await this.#chatLore(entry),
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

    const contributions = [...built.contributions, ...injectedContributions(entry)]

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
        history: this.#history(entry, session),
        budget: this.#budget(count, window),
      })
      // The first floor the budget kept is the one the dropped count names —
      // history entries map one-to-one onto chat-file lines. This is
      // `chat_metadata.lastInContextMessageId` upstream and, like it, a real
      // turn's byproduct: a preview must not write it.
      entry.firstIncludedMessageId = assembled.overflow.droppedHistory
      entry.itemizations.set(turn, this.#itemizationOf(assembled, turn, false))
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

  /** The budget every assembly for this host runs under. */
  #budget(count: (text: string) => number, window?: number): { context: number, reserve: number, count: (text: string) => number } {
    return { context: window ?? this.#options.contextWindow, reserve: this.#options.reserveTokens, count }
  }

  /** Project an assembly onto the wire shape. */
  #itemizationOf(result: AssembleResult, turn: number, preview: boolean, window?: number): PromptItemization {
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
      })),
      tokens: result.tokens,
      budget: {
        context: window ?? this.#options.contextWindow,
        reserve: this.#options.reserveTokens,
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
    const window = windowOf(settings, this.#options.contextWindow)
    const worldbookSettings = this.#options.settings.worldbookSettings()
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
      insertionStrategy: worldbookSettings.insertionStrategy,
      chatLore: await this.#chatLore(entry),
    })
    const contributions = [...built.contributions, ...injectedContributions(entry)]
    const result = assemble({
      contributions,
      history: this.#history(entry, entry.session),
      budget: this.#budget(count, window),
    })
    return this.#itemizationOf(result, entry.lastTurn + 1, true, window)
  }

  /**
   * Run one completion that never touches the log.
   *
   * A card asks for this to compute something on the side — a summary, a
   * classification — so it is not a turn: nothing is appended, nothing streams,
   * and no candidate is produced.
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
    })) {
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
   * **Nothing is written.** Not the log, and not the two pieces of chat state a
   * real assembly advances: the world-info timed effects and the turn's
   * itemization. A side generation that stored either would change what the
   * conversation does next — a sticky entry aged out by a script, or the account
   * of the user's own turn overwritten — from a call that never appears in the
   * chat.
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
      history: [...kept, { role: 'user' as const, text: userInput }],
      budget: this.#budget(count),
    })

    const assembler = new BlockAssembler()
    const sampling = samplingOf(settings)
    for await (const chunk of this.#stream({
      provider: settings.provider,
      model: settings.model,
      ...systemPrompt === undefined
        ? result.system === '' ? {} : { system: result.system }
        : { system: systemPrompt },
      messages: result.messages.map(message => (message.role === 'assistant'
        ? createAssistantMessage({
          content: [{ type: 'text', text: message.text }],
          source: { provider: 'iris', model: 'history' },
        })
        : createUserMessage({ content: [{ type: 'text', text: message.text }], source: { kind: 'user' } }))),
      ...settings.temperature === undefined ? {} : { temperature: settings.temperature },
      ...settings.maxTokens === undefined ? {} : { maxTokens: settings.maxTokens },
      ...sampling === undefined ? {} : { sampling },
    })) {
      assembler.push(chunk)
    }

    const finish = assembler.finish
    if (finish.kind === 'error') {
      throw new AppError('provider-error', finish.failure?.message ?? 'the provider ended the stream with an error')
    }
    return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('')
  }

  /**
   * The conversation as the model should see it.
   *
   * The prompt direction of the chat's regex scripts runs here, which is what
   * keeps a card's own command blocks out of the next request. Leaving them in
   * is not cosmetic: the model reads back its own `<UpdateVariable>` output from
   * every earlier turn and starts imitating it.
   * @param entry - the conversation.
   * @param session - the log to project.
   * @returns history entries, oldest first.
   */
  #history(entry: ChatEntry, session: Session): HistoryEntry[] {
    const names = entry.names
    const entries = historyFromSession(session, { characterName: names.character, userName: names.user })
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
   * Rewrite a settled reply the way a permanent script says it should be stored.
   *
   * Only the scripts marked neither display-only nor prompt-only reach this:
   * they change the message itself, which is why the render and send directions
   * then leave the stored form alone. It goes through the chat-file projection
   * because an append-only log cannot rewrite a message in place — the same
   * route `chat.editMessage` takes, and for the same reason.
   * @param entry - the conversation.
   * @param scripts - the chat's ordered scripts.
   * @param text - the reply as generated.
   */
  #storeRewritten(entry: ChatEntry, scripts: readonly RegexScript[], text: string): void {
    if (scripts.length === 0) return
    const stored = runScripts(text, 'assistant', scripts, { substitute: entry.substitute })
    if (stored === text) return

    const { messages } = entry.toFile()
    const index = messages.length - 1
    const line = messages[index]
    if (line === undefined || line.is_user) return
    line.mes = stored
    if (line.swipes !== undefined) line.swipes[line.swipe_id ?? 0] = stored
    entry.rebuild(messages, position => position)
  }

  /**
   * Stream one call, folding the provider's own token count back into the estimate.
   *
   * Every response reports what the prompt actually cost — the ground truth for
   * the number just estimated, free of charge. Feeding it back is the only way
   * a character-class estimator converges, because the residual is vocabulary
   * dependent and no static table fixes it.
   */
  async *#stream(options: GenerateOptions, entry?: ChatEntry): AsyncIterable<StreamChunk> {
    // The templates run here because here is the only place that has both the
    // assembled prompt and the chat it belongs to. `#generateRaw` reaches this
    // with no entry and is left alone deliberately: its prompt is written by
    // this host, not by a card, so there is nothing of the author's to evaluate.
    const request = entry === undefined ? options : await this.#applyTemplates(options, entry)
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

    for await (const chunk of this.#options.stream(request)) {
      if (chunk.type === 'usage') {
        this.#counter.observe(estimated, chunk.usage.inputTokens)
        // Recorded beside the estimate so a user can see whether to trust it.
        const turn = entry?.pending?.turn
        const recorded = turn === undefined ? undefined : entry?.itemizations.get(turn)
        if (recorded !== undefined) recorded.actualTokens = chunk.usage.inputTokens
      }
      yield chunk
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
 * A card script's keyed injections, as prompt contributions.
 *
 * Ordered around the preset's own sections rather than inside them: a card
 * injecting text has no way to know what the preset numbered its parts, so the
 * only stable promise is "before everything" or "after everything".
 * @param entry - the conversation holding the injections.
 * @returns one contribution per live injection.
 */
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
 * @param injection - the registered injection.
 * @returns its placement, or undefined when the position asks for none.
 */
function placementFor(injection: ScriptInjection): Contribution['placement'] | undefined {
  switch (injection.position) {
    case 'at-depth':
      return { kind: 'depth', depth: injection.depth, role: injection.role ?? 'system', order: 2 }
    case 'before':
      return { kind: 'system', order: 850 }
    case 'after':
      return { kind: 'system', order: 950 }
    case 'none':
      return undefined
    default: {
      const unreachable: never = injection.position
      throw new AppError('internal', `unknown injection position ${String(unreachable)}`)
    }
  }
}

export function injectedContributions(entry: ChatEntry): Contribution[] {
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
    const placement = placementFor(injection)
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
 * The context window one chat assembles under.
 *
 * Preset-scoped: the active preset's `openai_max_context` wins when it carries
 * one (they always do in practice — measured on real presets: 4095 to
 * 2 000 000), and the composition's value stands otherwise. A preset tuned for
 * one window assembled against another does not fail loudly; it trims a
 * different part of the conversation, which is the quiet kind of wrong.
 * @param settings - the chat's merged settings.
 * @param fallback - the composition's window.
 * @returns the window in tokens.
 */
function windowOf(settings: GenerationSettings, fallback: number): number {
  return settings.contextWindow ?? fallback
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
export function presetScalarPatch(preset: ChatCompletionPreset): Record<string, number | string> {
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
  const patch: Record<string, number | string> = {}
  for (const [key, field] of numbers) {
    const value = preset[key]
    if (typeof value === 'number' && Number.isFinite(value)) patch[field] = value
  }
  const effort = preset['reasoning_effort']
  if (typeof effort === 'string' && REASONING_EFFORT_VALUES.has(effort)) {
    patch['reasoningEffort'] = effort
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
