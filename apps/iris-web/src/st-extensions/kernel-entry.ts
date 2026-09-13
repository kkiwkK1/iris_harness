/**
 * The extension-frame kernel's live half: wiring the state and the event bus to
 * the iframe's document and the postMessage channel the shell plane speaks.
 *
 * This module is the shared chunk behind all seventeen facade entry points, so
 * its top level runs exactly once, when the upstream bundle's first import is
 * evaluated. It reads its identity from the meta tags the srcdoc carries,
 * builds the fixture DOM upstream's selectors expect, and answers the shell's
 * envelopes (`bridge`, `chat-open`, `locale`, `member-call`). Vendor globals
 * (`$`, `_`) are classic script tags the srcdoc loads before this module is
 * imported; the toastr shim is installed here.
 */

import { StEventBus } from '../../../../packages/iris-compat-st-extension/src/runtime/event-bus.ts'
import { event_types } from '../../../../packages/iris-compat-st-extension/src/runtime/event-types.ts'
import {
  escapeHtml,
  StCompatState,
  substituteMacrosMinimal,
  UnsupportedStCompatApiError,
  translationsFor,
} from '../../../../packages/iris-compat-st-extension/src/runtime/kernel-core.ts'
import type {
  StBridgeContext,
  StBridgePayload,
  StBridgeResult,
  StFrameToShell,
  StGenerateResult,
  StReplyResult,
} from '../../../../packages/iris-compat-st-extension/src/runtime/protocol.ts'

function meta(name: string): string {
  const tag = document.querySelector(`meta[name="${name}"]`)
  const value = tag?.getAttribute('content') ?? ''
  if (value === '') throw new Error(`[iris-st-compat] the srcdoc is missing the "${name}" meta tag`)
  return value
}

const token = meta('iris-st-ext-token')
/** e.g. `/iris-st-ext/st-prompt-template/<rev>` — the URL mirror root of this install. */
const artifactBase = meta('iris-st-ext-base')
/** The extension's own directory name under `scripts/extensions/third-party/`. */
const extensionDirName = meta('iris-st-ext-dir')

const state = new StCompatState()
const bus = new StEventBus()
// Handler crashes ride the error envelope to the shell: a facade-side or
// upstream-side exception inside a dispatched handler must be locatable from
// outside the frame, not buried in a console nobody opens.
bus.onHandlerError((type, cause) => {
  const detail = cause instanceof Error ? `${cause.message}\n${cause.stack ?? ''}`.slice(0, 800) : String(cause)
  post({ irisStExt: token, type: 'error', where: `event handler: ${type}`, message: detail })
})
// Instance guard: the module chunk must evaluate exactly once per frame. A
// second evaluation means two bus instances exist — the upstream registers
// its handlers on one while the envelope channel answers on the other, and
// every round silently no-ops. The probe reports the count.
const w = window as unknown as Record<string, unknown>
w['__irisStKernelInstances'] = ((w['__irisStKernelInstances'] as number | undefined) ?? 0) + 1

function post(message: StFrameToShell): void {
  window.parent.postMessage(message, '*')
}

function postError(where: string, cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause)
  post({ irisStExt: token, type: 'error', where, message })
  console.error(`[iris-st-compat] ${where}:`, cause)
}

// --- toastr shim ------------------------------------------------------------
// The upstream error paths call toastr; the shim forwards so failures reach
// the shell's report surface instead of vanishing with the hidden frame.

interface ToastFn { (message: string, detail?: string): void }
const toastShim: Record<'success' | 'warning' | 'error' | 'info', ToastFn> = {
  success: message => post({ irisStExt: token, type: 'toast', level: 'success', message }),
  warning: message => post({ irisStExt: token, type: 'toast', level: 'warning', message }),
  error: (message, detail) => {
    if (detail === undefined) post({ irisStExt: token, type: 'toast', level: 'error', message })
    else post({ irisStExt: token, type: 'toast', level: 'error', message, detail })
  },
  info: message => post({ irisStExt: token, type: 'toast', level: 'info', message }),
}
;(window as unknown as Record<string, unknown>)['toastr'] = Object.assign(toastShim, {
  clear: () => {},
  remove: () => {},
})

// --- fixture DOM ------------------------------------------------------------

function ensureFixtureDom(): void {
  if (document.getElementById('extensions_settings') === null) {
    const settingsRoot = document.createElement('div')
    settingsRoot.id = 'extensions_settings'
    document.body.appendChild(settingsRoot)
  }
  if (document.getElementById('chat') === null) {
    const chatRoot = document.createElement('div')
    chatRoot.id = 'chat'
    chatRoot.style.display = 'none'
    document.body.appendChild(chatRoot)
  }
}

/**
 * One floor div, the scratch rendering surface a reply round evaluates
 * against. Upstream's render handler selects `div.mes[mesid="N"] .mes_text`;
 * the projection floor exists only for the round's duration.
 */
function ensureFloorDiv(messageId: number, text: string): HTMLElement {
  const chatRoot = document.getElementById('chat')
  if (chatRoot === null) throw new Error('[iris-st-compat] the chat fixture root is missing')
  let floor = chatRoot.querySelector(`div.mes[mesid="${messageId}"]`)
  if (floor === null) {
    floor = document.createElement('div')
    floor.setAttribute('mesid', String(messageId))
    floor.className = 'mes'
    const textBlock = document.createElement('div')
    textBlock.className = 'mes_text'
    floor.appendChild(textBlock)
    chatRoot.appendChild(floor)
  }
  const textBlock = floor.querySelector('.mes_text')
  if (textBlock !== null) textBlock.textContent = text
  return floor as HTMLElement
}

// --- i18n -------------------------------------------------------------------

async function loadLocaleTable(language: string): Promise<Record<string, string>> {
  const file = language.toLowerCase() === 'zh-cn' ? 'zh-cn' : language.toLowerCase() === 'zh-tw' ? 'zh-tw' : null
  if (file === null) return {}
  try {
    const response = await fetch(`${artifactBase}/scripts/extensions/third-party/${extensionDirName}/locales/${file}.json`)
    if (!response.ok) return {}
    return await response.json() as Record<string, string>
  } catch (cause: unknown) {
    console.warn('[iris-st-compat] the locale table could not be read; the settings panel falls back to source text', cause)
    return {}
  }
}

function applyTranslations(root: ParentNode, table: Record<string, string>): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  const elements: Element[] = []
  while (walker.nextNode()) elements.push(walker.currentNode as Element)
  // The root itself is walked too when it is an element; a Document root has
  // no attributes of its own and carries nothing to translate.
  if (root instanceof Element) elements.push(root)
  for (const element of elements) {
    const attributes = new Map<string, string>()
    for (const attribute of [...element.attributes]) attributes.set(attribute.name, attribute.value)
    for (const edit of translationsFor({ textContent: element.textContent, attributes }, table)) {
      if (edit.kind === 'text') element.textContent = edit.value
      else element.setAttribute(edit.attribute, edit.value)
    }
  }
}

// --- settings persistence ---------------------------------------------------

let settingsPersistTimer: ReturnType<typeof setTimeout> | undefined

function persistSettings(): void {
  if (settingsPersistTimer !== undefined) clearTimeout(settingsPersistTimer)
  settingsPersistTimer = setTimeout(() => {
    settingsPersistTimer = undefined
    void bus.emit(event_types.SETTINGS_UPDATED)
    post({ irisStExt: token, type: 'settings-persist', extensionSettings: structuredCloneSafe(state.extensionSettings) })
  }, 300)
}

function structuredCloneSafe(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
  }
}

// --- the script.js facade's scalar bindings ---------------------------------
// `let` exports so the upstream import sites read live values. applyContext
// keeps them in step with the hydrated state; the extensions.js settings
// object and the arrays live on the state itself.

export let this_chid = -1
export let name1 = 'User'
export let name2 = 'Assistant'
/** Iris is a chat-completion host; presenting `openai` selects the upstream paths built for it. */
export let main_api = 'openai'
export let user_avatar = 'default'
export let online_status = ''

function syncBindings(): void {
  this_chid = state.characterId
  name1 = state.userName
  name2 = state.characterName
}

// --- bridge rounds ----------------------------------------------------------

async function runGenerateRound(payload: Extract<StBridgePayload, { kind: 'generate' }>): Promise<StGenerateResult> {
  state.applyContext(payload)
  syncBindings()
  // Upstream order: the command-phase handlers install the filter regex and
  // evaluate @@generate_before entries, then the chat-completion rewrite runs.
  await bus.emit(event_types.GENERATION_AFTER_COMMANDS, payload.generateType, {}, false)
  const data: { chat: unknown, messages: unknown, type: string } = {
    chat: state.chat,
    messages: payload.messages.map(message => ({ ...message })),
    type: payload.generateType,
  }
  await bus.emit(event_types.CHAT_COMPLETION_SETTINGS_READY, data)
  const messages = data.messages
  if (!Array.isArray(messages)) throw new Error('the CHAT_COMPLETION_SETTINGS_READY handler replaced messages with a non-array')
  return {
    kind: 'generate',
    messages: (messages as Array<{ role?: unknown, content?: unknown }>).map(message => ({
      role: typeof message.role === 'string' ? message.role : '',
      content: typeof message.content === 'string' ? message.content : '',
    })),
    chatVariables: state.collectChatVariables(),
    globalVariables: state.collectGlobalVariables(),
  }
}

async function runReplyRound(payload: Extract<StBridgePayload, { kind: 'reply' }>): Promise<StReplyResult> {
  state.applyContext(payload)
  syncBindings()
  if (payload.turn < 0 || payload.turn > state.chat.length) {
    throw new Error(`reply turn ${payload.turn} is outside the hydrated chat (length ${state.chat.length})`)
  }
  // The floor under processing gets a scratch DOM node so the render handler's
  // selectors resolve; every other floor stays div-less, which is what keeps a
  // re-enable's preload from reprocessing the disabled gap (upstream skips
  // messages whose container it does not find).
  const floor = state.chat[payload.turn]
  if (floor === undefined) {
    throw new Error(`reply turn ${payload.turn} has no hydrated floor (chat length ${state.chat.length})`)
  }
  floor.mes = payload.text
  floor.is_user = false
  floor.is_system = false
  floor.swipe_id = floor.swipe_id || 0
  if (!Array.isArray(floor.is_ejs_processed) || floor.is_ejs_processed.length === 0) floor.is_ejs_processed = [false]
  ensureFloorDiv(payload.turn, payload.text)

  await bus.emit(event_types.MESSAGE_RECEIVED, payload.turn)
  await bus.emit(event_types.CHARACTER_MESSAGE_RENDERED, payload.turn)

  const floorVarKey = String(floor.swipe_id || 0)
  const floorVars = floor.variables[floorVarKey]
  return {
    kind: 'reply',
    turn: payload.turn,
    mes: typeof floor.mes === 'string' ? floor.mes : payload.text,
    chatVariables: state.collectChatVariables(),
    globalVariables: state.collectGlobalVariables(),
    floorVariables: typeof floorVars === 'object' && floorVars !== null ? { ...floorVars } : {},
  }
}

// --- the upstream render path's DOM-facing facade hooks ---------------------
// Installed on the kernel so the script.js facade can call them; they are DOM
// work, which lives here rather than in the pure half.

function updateMessageBlockDom(messageId: number, mes: string): void {
  const floor = document.querySelector(`div.mes[mesid="${messageId}"] .mes_text`)
  if (floor !== null) floor.textContent = mes
}

async function renderExtensionTemplateAsync(templateKey: string, templateName: string): Promise<HTMLElement> {
  if (templateKey !== 'third-party/ST-Prompt-Template') {
    throw new UnsupportedStCompatApiError(`renderExtensionTemplateAsync("${templateKey}")`)
  }
  const response = await fetch(`${artifactBase}/scripts/extensions/third-party/ST-Prompt-Template/${templateName}.html`)
  if (!response.ok) throw new Error(`the extension's ${templateName}.html could not be read (HTTP ${response.status})`)
  const html = await response.text()
  const container = document.createElement('div')
  container.innerHTML = html
  applyTranslations(container, await loadLocaleTable(state.language))
  return container
}

// --- shell channel ----------------------------------------------------------

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window.parent) return
  const data = event.data as Record<string, unknown> | null
  if (typeof data !== 'object' || data === null || data['irisStExt'] !== token) return
  void handleShellMessage(data).catch(cause => postError('envelope handling failed', cause))
})

// A crash inside the extension's own realm would otherwise be invisible to the
// shell: report it so the failure is locatable instead of a silently dead frame.
window.addEventListener('error', event => {
  post({ irisStExt: token, type: 'error', where: 'uncaught error', message: `${event.message} (${event.filename}:${event.lineno})` })
})
window.addEventListener('unhandledrejection', event => {
  const reason = event.reason instanceof Error ? `${event.reason.message}\n${event.reason.stack ?? ''}` : String(event.reason)
  post({ irisStExt: token, type: 'error', where: 'unhandled rejection', message: reason.slice(0, 500) })
})

async function handleShellMessage(data: Record<string, unknown>): Promise<void> {
  switch (data['type']) {
    case 'chat-open': {
      const context = data['context'] as StBridgeContext
      state.applyContext(context)
      syncBindings()
      applyTranslations(document, await loadLocaleTable(state.language))
      // APP_READY once, then the chat-open preload — upstream's order.
      if (!appReadyFired) {
        appReadyFired = true
        await bus.emit(event_types.APP_READY)
      }
      await bus.emit(event_types.CHAT_CHANGED, context.chatId)
      return
    }
    case 'locale': {
      state.language = String(data['language'] ?? 'en')
      applyTranslations(document, await loadLocaleTable(state.language))
      return
    }
    case 'bridge': {
      const envelopeToken = String(data['token'])
      const payload = data['payload'] as StBridgePayload
      try {
        // A chat-open round rides the bridge envelope too (the host announces
        // an open the same way it announces a generate); it hydrates and
        // preloads, and answers with nothing — the host keeps no pending
        // round for it, so a bridge-result would only be reported as noise.
        if (payload.kind === 'chat-open') {
          await handleShellMessage({ type: 'chat-open', context: payload as unknown as StBridgeContext })
          return
        }
        const result = payload.kind === 'generate' ? await runGenerateRound(payload) : await runReplyRound(payload)
        post({ irisStExt: token, type: 'bridge-result', token: envelopeToken, result })
      } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause)
        const stack = cause instanceof Error ? cause.stack : undefined
        const error = stack === undefined ? { message } : { message, stack }
        post({ irisStExt: token, type: 'bridge-result', token: envelopeToken, result: undefined as unknown as StBridgeResult, error })
      }
      return
    }
    case 'settings-project': {
      const root = document.getElementById('extensions_settings')
      if (root === null) throw new Error('the settings fixture root disappeared')
      // Path tags let the projection relay an interaction back to the exact
      // element; the attribute is ours, not upstream's, and adds no behavior.
      let seq = 0
      for (const element of root.querySelectorAll('*')) {
        element.setAttribute('data-iris-proj-path', `p${seq}`)
        seq += 1
      }
      // The path attributes stay on: the replay looks the real element up by
      // them, so stripping after serialize would break the projection round trip.
      post({ irisStExt: token, type: 'settings-html', html: root.innerHTML, language: state.language })
      return
    }
    case 'replay-event': {
      const path = String(data['path'])
      const eventType = data['eventType'] as 'click' | 'change' | 'input'
      const target = document.querySelector(`[data-iris-proj-path="${path}"]`)
      if (target === null) {
        console.warn(`[iris-st-compat] replay: no settings element carries path "${path}"`)
        return
      }
      if (eventType === 'click') {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
        return
      }
      const value = data['value']
      if (typeof value === 'string' && 'value' in target) (target as HTMLInputElement).value = value
      target.dispatchEvent(new Event(eventType, { bubbles: true }))
      return
    }
    case 'member-call': {
      const callId = String(data['callId'])
      const method = String(data['method'])
      const args = (data['args'] as unknown[]) ?? []
      try {
        const api = (globalThis as unknown as Record<string, unknown>)['EjsTemplate']
        if (typeof api !== 'object' || api === null) throw new Error('the extension has not published its EjsTemplate API yet')
        const fn = (api as Record<string, unknown>)[method]
        if (typeof fn !== 'function') throw new UnsupportedStCompatApiError(`EjsTemplate.${method} (member proxy)`)
        const result = await (fn as (...args: unknown[]) => unknown).apply(api, args)
        post({ irisStExt: token, type: 'member-result', callId, result })
      } catch (cause: unknown) {
        post({ irisStExt: token, type: 'member-result', callId, error: cause instanceof Error ? cause.message : String(cause) })
      }
      return
    }
    case 'probe': {
      // Diagnostics for the acceptance driver: reports whether the frame's
      // kernel and the upstream share one realm (EjsTemplate visible) and
      // whether the kernel chunk evaluated exactly once.
      post({
        irisStExt: token,
        type: 'member-result',
        callId: 'probe',
        result: {
          readyState: document.readyState,
          hasJQuery: typeof (window as unknown as Record<string, unknown>)['$'] === 'function',
          hasLodash: typeof (window as unknown as Record<string, unknown>)['_'] === 'function',
          ejsPublished: (window as unknown as Record<string, unknown>)['EjsTemplate'] !== undefined,
          kernelInstances: (window as unknown as Record<string, unknown>)['__irisStKernelInstances'],
          settingsDom: document.getElementById('extensions_settings')?.children.length ?? -1,
        },
      })
      return
    }
    default:
      return
  }
}

let appReadyFired = false

// --- kernel bootstrap -------------------------------------------------------

ensureFixtureDom()

// The kernel self-reports once the document is parsed and the vendor globals
// are in place. The extension's own init runs inside its jQuery-ready
// callback, registered after ours (the module evaluates before DOMContentLoaded
// fires); one macrotask lets its synchronous half settle before the shell arms.
jQueryReady(() => {
  setTimeout(() => {
    post({ irisStExt: token, type: 'ready' })
  }, 0)
})

function jQueryReady(fn: () => void): void {
  const jquery = (window as unknown as Record<string, unknown>)['$'] as ((fn: () => void) => unknown) | undefined
  if (typeof jquery === 'function') {
    jquery(fn)
    return
  }
  // The vendor tags are the srcdoc's responsibility; reaching here means the
  // srcdoc assembled the frame without them, which is a build-time contract
  // break, not a runtime condition to paper over.
  throw new Error('[iris-st-compat] jQuery ($) is not loaded; the srcdoc must carry the vendor script tags before the module tag')
}

// --- what the facades re-export ---------------------------------------------

export {
  artifactBase,
  bus as eventSource,
  ensureFloorDiv,
  escapeHtml,
  event_types,
  persistSettings,
  renderExtensionTemplateAsync,
  state,
  substituteMacrosMinimal,
  UnsupportedStCompatApiError,
  updateMessageBlockDom,
}