import { U as UnsupportedStCompatApiError, S as StCompatState, t as translationsFor } from "./kernel-core-VDxEywTX.js";
class StEventBus {
  #handlers = /* @__PURE__ */ new Map();
  /** Notified when a handler throws — the frame's route to surface handler
   *  crashes to the shell instead of burying them in the frame's console. */
  #onHandlerError;
  /** Install the shell-reporting hook (the kernel wires this at startup). */
  onHandlerError(handler) {
    this.#onHandlerError = handler;
  }
  #list(type) {
    const existing = this.#handlers.get(type);
    if (existing !== void 0) return existing;
    const created = [];
    this.#handlers.set(type, created);
    return created;
  }
  #register(type, handler, position, once) {
    if (typeof handler !== "function") throw new TypeError("eventSource: a handler must be a function");
    const list = this.#list(type);
    const registration = { handler, once };
    if (position === "unshift") list.unshift(registration);
    else list.push(registration);
    return handler;
  }
  /** Register in the normal order. Returns the handler for `removeListener`. */
  on(type, handler) {
    return this.#register(type, handler, "push", false);
  }
  /** Register for a single dispatch. */
  once(type, handler) {
    return this.#register(type, handler, "push", true);
  }
  /** Register to run before every same-event handler registered so far. */
  makeFirst(type, handler) {
    return this.#register(type, handler, "unshift", false);
  }
  /** Register to run after every same-event handler registered so far. */
  makeLast(type, handler) {
    return this.#register(type, handler, "push", false);
  }
  /** Remove a handler previously returned by a registration call. */
  removeListener(type, handler) {
    const list = this.#handlers.get(type);
    if (list === void 0) return;
    const index = list.findIndex((entry) => entry.handler === handler);
    if (index > -1) list.splice(index, 1);
  }
  /**
   * Dispatch, awaiting each handler sequentially in order. A `once` handler is
   * removed before its call, so a handler that re-emits the same event cannot
   * recurse into itself through its own registration.
   */
  async emit(type, ...args) {
    const list = this.#handlers.get(type);
    if (list === void 0 || list.length === 0) return void 0;
    let last;
    for (const entry of [...list]) {
      if (entry.once) this.removeListener(type, entry.handler);
      try {
        last = await entry.handler(...args);
      } catch (cause) {
        console.error(`[iris-st-compat] event handler for "${type}" threw`, cause);
        this.#onHandlerError?.(type, cause);
      }
    }
    return last;
  }
}
const event_types = {
  APP_READY: "app_ready",
  CHAT_CHANGED: "chat_id_changed",
  GENERATION_AFTER_COMMANDS: "GENERATION_AFTER_COMMANDS",
  CHAT_COMPLETION_SETTINGS_READY: "chat_completion_settings_ready",
  MESSAGE_RECEIVED: "message_received",
  MESSAGE_SENT: "message_sent",
  MESSAGE_UPDATED: "message_updated",
  MESSAGE_SWIPED: "message_swiped",
  MESSAGE_SWIPE_DELETED: "message_swipe_deleted",
  CHARACTER_MESSAGE_RENDERED: "character_message_rendered",
  USER_MESSAGE_RENDERED: "user_message_rendered",
  SETTINGS_LOADED: "settings_loaded",
  SETTINGS_UPDATED: "settings_updated",
  WORLDINFO_UPDATED: "worldinfo_updated",
  WORLDINFO_ENTRIES_LOADED: "worldinfo_entries_loaded"
};
function meta(name) {
  const tag = document.querySelector(`meta[name="${name}"]`);
  const value = tag?.getAttribute("content") ?? "";
  if (value === "") throw new Error(`[iris-st-compat] the srcdoc is missing the "${name}" meta tag`);
  return value;
}
const token = meta("iris-st-ext-token");
const artifactBase = meta("iris-st-ext-base");
const extensionDirName = meta("iris-st-ext-dir");
const state = new StCompatState();
const bus = new StEventBus();
bus.onHandlerError((type, cause) => {
  const detail = cause instanceof Error ? `${cause.message}
${cause.stack ?? ""}`.slice(0, 800) : String(cause);
  post({ irisStExt: token, type: "error", where: `event handler: ${type}`, message: detail });
});
const w = window;
w["__irisStKernelInstances"] = (w["__irisStKernelInstances"] ?? 0) + 1;
function post(message) {
  window.parent.postMessage(message, "*");
}
function postError(where, cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  post({ irisStExt: token, type: "error", where, message });
  console.error(`[iris-st-compat] ${where}:`, cause);
}
const toastShim = {
  success: (message) => post({ irisStExt: token, type: "toast", level: "success", message }),
  warning: (message) => post({ irisStExt: token, type: "toast", level: "warning", message }),
  error: (message, detail) => {
    if (detail === void 0) post({ irisStExt: token, type: "toast", level: "error", message });
    else post({ irisStExt: token, type: "toast", level: "error", message, detail });
  },
  info: (message) => post({ irisStExt: token, type: "toast", level: "info", message })
};
window["toastr"] = Object.assign(toastShim, {
  clear: () => {
  },
  remove: () => {
  }
});
function ensureFixtureDom() {
  if (document.getElementById("extensions_settings") === null) {
    const settingsRoot = document.createElement("div");
    settingsRoot.id = "extensions_settings";
    document.body.appendChild(settingsRoot);
  }
  if (document.getElementById("chat") === null) {
    const chatRoot = document.createElement("div");
    chatRoot.id = "chat";
    chatRoot.style.display = "none";
    document.body.appendChild(chatRoot);
  }
}
function ensureFloorDiv(messageId, text) {
  const chatRoot = document.getElementById("chat");
  if (chatRoot === null) throw new Error("[iris-st-compat] the chat fixture root is missing");
  let floor = chatRoot.querySelector(`div.mes[mesid="${messageId}"]`);
  if (floor === null) {
    floor = document.createElement("div");
    floor.setAttribute("mesid", String(messageId));
    floor.className = "mes";
    const textBlock2 = document.createElement("div");
    textBlock2.className = "mes_text";
    floor.appendChild(textBlock2);
    chatRoot.appendChild(floor);
  }
  const textBlock = floor.querySelector(".mes_text");
  if (textBlock !== null) textBlock.textContent = text;
  return floor;
}
async function loadLocaleTable(language) {
  const file = language.toLowerCase() === "zh-cn" ? "zh-cn" : language.toLowerCase() === "zh-tw" ? "zh-tw" : null;
  if (file === null) return {};
  try {
    const response = await fetch(`${artifactBase}/scripts/extensions/third-party/${extensionDirName}/locales/${file}.json`);
    if (!response.ok) return {};
    return await response.json();
  } catch (cause) {
    console.warn("[iris-st-compat] the locale table could not be read; the settings panel falls back to source text", cause);
    return {};
  }
}
function applyTranslations(root, table) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  const elements = [];
  while (walker.nextNode()) elements.push(walker.currentNode);
  if (root instanceof Element) elements.push(root);
  for (const element of elements) {
    const attributes = /* @__PURE__ */ new Map();
    for (const attribute of [...element.attributes]) attributes.set(attribute.name, attribute.value);
    for (const edit of translationsFor({ textContent: element.textContent, attributes }, table)) {
      if (edit.kind === "text") element.textContent = edit.value;
      else element.setAttribute(edit.attribute, edit.value);
    }
  }
}
let settingsPersistTimer;
function persistSettings() {
  if (settingsPersistTimer !== void 0) clearTimeout(settingsPersistTimer);
  settingsPersistTimer = setTimeout(() => {
    settingsPersistTimer = void 0;
    void bus.emit(event_types.SETTINGS_UPDATED);
    post({ irisStExt: token, type: "settings-persist", extensionSettings: structuredCloneSafe(state.extensionSettings) });
  }, 300);
}
function structuredCloneSafe(value) {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value));
  }
}
let this_chid = -1;
let name1 = "User";
let name2 = "Assistant";
let main_api = "openai";
let user_avatar = "default";
let online_status = "";
function syncBindings() {
  this_chid = state.characterId;
  name1 = state.userName;
  name2 = state.characterName;
}
async function runGenerateRound(payload) {
  state.applyContext(payload);
  syncBindings();
  await bus.emit(event_types.GENERATION_AFTER_COMMANDS, payload.generateType, {}, false);
  const data = {
    chat: state.chat,
    messages: payload.messages.map((message) => ({ ...message })),
    type: payload.generateType
  };
  await bus.emit(event_types.CHAT_COMPLETION_SETTINGS_READY, data);
  const messages = data.messages;
  if (!Array.isArray(messages)) throw new Error("the CHAT_COMPLETION_SETTINGS_READY handler replaced messages with a non-array");
  return {
    kind: "generate",
    messages: messages.map((message) => ({
      role: typeof message.role === "string" ? message.role : "",
      content: typeof message.content === "string" ? message.content : ""
    })),
    chatVariables: state.collectChatVariables(),
    globalVariables: state.collectGlobalVariables()
  };
}
async function runReplyRound(payload) {
  state.applyContext(payload);
  syncBindings();
  if (payload.turn < 0 || payload.turn > state.chat.length) {
    throw new Error(`reply turn ${payload.turn} is outside the hydrated chat (length ${state.chat.length})`);
  }
  const floor = state.chat[payload.turn];
  if (floor === void 0) {
    throw new Error(`reply turn ${payload.turn} has no hydrated floor (chat length ${state.chat.length})`);
  }
  floor.mes = payload.text;
  floor.is_user = false;
  floor.is_system = false;
  floor.swipe_id = floor.swipe_id || 0;
  if (!Array.isArray(floor.is_ejs_processed) || floor.is_ejs_processed.length === 0) floor.is_ejs_processed = [false];
  ensureFloorDiv(payload.turn, payload.text);
  await bus.emit(event_types.MESSAGE_RECEIVED, payload.turn);
  await bus.emit(event_types.CHARACTER_MESSAGE_RENDERED, payload.turn);
  const floorVarKey = String(floor.swipe_id || 0);
  const floorVars = floor.variables[floorVarKey];
  return {
    kind: "reply",
    turn: payload.turn,
    mes: typeof floor.mes === "string" ? floor.mes : payload.text,
    chatVariables: state.collectChatVariables(),
    globalVariables: state.collectGlobalVariables(),
    floorVariables: typeof floorVars === "object" && floorVars !== null ? { ...floorVars } : {}
  };
}
function updateMessageBlockDom(messageId, mes) {
  const floor = document.querySelector(`div.mes[mesid="${messageId}"] .mes_text`);
  if (floor !== null) floor.textContent = mes;
}
async function renderExtensionTemplateAsync(templateKey, templateName) {
  if (templateKey !== "third-party/ST-Prompt-Template") {
    throw new UnsupportedStCompatApiError(`renderExtensionTemplateAsync("${templateKey}")`);
  }
  const response = await fetch(`${artifactBase}/scripts/extensions/third-party/ST-Prompt-Template/${templateName}.html`);
  if (!response.ok) throw new Error(`the extension's ${templateName}.html could not be read (HTTP ${response.status})`);
  const html = await response.text();
  const container = document.createElement("div");
  container.innerHTML = html;
  applyTranslations(container, await loadLocaleTable(state.language));
  return container;
}
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (typeof data !== "object" || data === null || data["irisStExt"] !== token) return;
  void handleShellMessage(data).catch((cause) => postError("envelope handling failed", cause));
});
window.addEventListener("error", (event) => {
  post({ irisStExt: token, type: "error", where: "uncaught error", message: `${event.message} (${event.filename}:${event.lineno})` });
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason instanceof Error ? `${event.reason.message}
${event.reason.stack ?? ""}` : String(event.reason);
  post({ irisStExt: token, type: "error", where: "unhandled rejection", message: reason.slice(0, 500) });
});
async function handleShellMessage(data) {
  switch (data["type"]) {
    case "chat-open": {
      const context = data["context"];
      state.applyContext(context);
      syncBindings();
      applyTranslations(document, await loadLocaleTable(state.language));
      if (!appReadyFired) {
        appReadyFired = true;
        await bus.emit(event_types.APP_READY);
      }
      await bus.emit(event_types.CHAT_CHANGED, context.chatId);
      return;
    }
    case "locale": {
      state.language = String(data["language"] ?? "en");
      applyTranslations(document, await loadLocaleTable(state.language));
      return;
    }
    case "bridge": {
      const envelopeToken = String(data["token"]);
      const payload = data["payload"];
      try {
        if (payload.kind === "chat-open") {
          await handleShellMessage({ type: "chat-open", context: payload });
          return;
        }
        const result = payload.kind === "generate" ? await runGenerateRound(payload) : await runReplyRound(payload);
        post({ irisStExt: token, type: "bridge-result", token: envelopeToken, result });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const stack = cause instanceof Error ? cause.stack : void 0;
        const error = stack === void 0 ? { message } : { message, stack };
        post({ irisStExt: token, type: "bridge-result", token: envelopeToken, result: void 0, error });
      }
      return;
    }
    case "settings-project": {
      const root = document.getElementById("extensions_settings");
      if (root === null) throw new Error("the settings fixture root disappeared");
      let seq = 0;
      for (const element of root.querySelectorAll("*")) {
        element.setAttribute("data-iris-proj-path", `p${seq}`);
        seq += 1;
      }
      post({ irisStExt: token, type: "settings-html", html: root.innerHTML, language: state.language });
      return;
    }
    case "replay-event": {
      const path = String(data["path"]);
      const eventType = data["eventType"];
      const target = document.querySelector(`[data-iris-proj-path="${path}"]`);
      if (target === null) {
        console.warn(`[iris-st-compat] replay: no settings element carries path "${path}"`);
        return;
      }
      if (eventType === "click") {
        target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        return;
      }
      const value = data["value"];
      if (typeof value === "string" && "value" in target) target.value = value;
      target.dispatchEvent(new Event(eventType, { bubbles: true }));
      return;
    }
    case "member-call": {
      const callId = String(data["callId"]);
      const method = String(data["method"]);
      const args = data["args"] ?? [];
      try {
        const api = globalThis["EjsTemplate"];
        if (typeof api !== "object" || api === null) throw new Error("the extension has not published its EjsTemplate API yet");
        const fn = api[method];
        if (typeof fn !== "function") throw new UnsupportedStCompatApiError(`EjsTemplate.${method} (member proxy)`);
        const result = await fn.apply(api, args);
        post({ irisStExt: token, type: "member-result", callId, result });
      } catch (cause) {
        post({ irisStExt: token, type: "member-result", callId, error: cause instanceof Error ? cause.message : String(cause) });
      }
      return;
    }
    case "probe": {
      post({
        irisStExt: token,
        type: "member-result",
        callId: "probe",
        result: {
          readyState: document.readyState,
          hasJQuery: typeof window["$"] === "function",
          hasLodash: typeof window["_"] === "function",
          ejsPublished: window["EjsTemplate"] !== void 0,
          kernelInstances: window["__irisStKernelInstances"],
          settingsDom: document.getElementById("extensions_settings")?.children.length ?? -1
        }
      });
      return;
    }
    default:
      return;
  }
}
let appReadyFired = false;
ensureFixtureDom();
jQueryReady(() => {
  setTimeout(() => {
    post({ irisStExt: token, type: "ready" });
  }, 0);
});
function jQueryReady(fn) {
  const jquery = window["$"];
  if (typeof jquery === "function") {
    jquery(fn);
    return;
  }
  throw new Error("[iris-st-compat] jQuery ($) is not loaded; the srcdoc must carry the vendor script tags before the module tag");
}
export {
  name2 as a,
  bus as b,
  user_avatar as c,
  event_types as e,
  main_api as m,
  name1 as n,
  online_status as o,
  persistSettings as p,
  renderExtensionTemplateAsync as r,
  state as s,
  this_chid as t,
  updateMessageBlockDom as u
};
