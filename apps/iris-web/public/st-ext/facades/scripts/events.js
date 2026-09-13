class UnsupportedStCompatApiError extends Error {
  member;
  constructor(member) {
    super(
      `${member} is not implemented by the Iris ST-compat layer (pilot scope). The extension called a SillyTavern API outside the mapped pilot surface; the mapped surface is listed in notes/st-compat/PILOT-DESIGN.md §4 and the acceptance report records every refusal.`
    );
    this.name = "UnsupportedStCompatApiError";
    this.member = member;
  }
}
function sameFloor(a, floor) {
  const vars = floor.variables ?? {};
  const existing = a.variables[0] ?? {};
  return a.mes === floor.mes && a.name === floor.name && a.is_user === floor.is_user && a.is_system === floor.is_system && a.swipe_id === floor.swipe_id && JSON.stringify(existing) === JSON.stringify(vars) && JSON.stringify(a.is_ejs_processed) === JSON.stringify(floor.is_ejs_processed ?? []);
}
function floorToMessage(floor) {
  const message = {
    name: floor.name,
    is_user: floor.is_user,
    is_system: floor.is_system,
    mes: floor.mes,
    swipe_id: floor.swipe_id,
    variables: { [String(floor.swipe_id)]: { ...floor.variables ?? {} } },
    is_ejs_processed: [...floor.is_ejs_processed ?? [false]]
  };
  return message;
}
class StCompatState {
  chat = [];
  chatMetadata = {};
  extensionSettings = {};
  characters = [];
  chatId = "";
  language = "en";
  userName = "User";
  characterName = "Assistant";
  characterId = -1;
  /** The bound world book, hydrated when the host supplies one; empty otherwise. */
  worldbooks = /* @__PURE__ */ new Map();
  /**
   * Apply one bridge context onto the stable objects. Floors whose content is
   * unchanged keep their object identity; changed floors are mutated in place;
   * new floors append; removals truncate.
   */
  applyContext(context) {
    this.chatId = context.chatId;
    this.language = context.language;
    this.userName = context.userName;
    this.characterName = context.characterName;
    this.characterId = context.characterId ?? -1;
    this.chat.length = Math.min(this.chat.length, context.chat.length);
    for (const [index, floor] of context.chat.entries()) {
      const existing = this.chat[index];
      if (existing === void 0) {
        this.chat.push(floorToMessage(floor));
      } else if (sameFloor(existing, floor)) ;
      else {
        const fresh = floorToMessage(floor);
        existing.name = fresh.name;
        existing.is_user = fresh.is_user;
        existing.is_system = fresh.is_system;
        existing.mes = fresh.mes;
        existing.swipe_id = fresh.swipe_id;
        existing.variables = fresh.variables;
        existing.is_ejs_processed = fresh.is_ejs_processed;
      }
    }
    if (this.chat.length > context.chat.length) this.chat.length = context.chat.length;
    replaceInPlace(this.chatMetadata, { variables: context.chatVariables });
    const globalVariables = context.extensionSettings?.variables?.global ?? {};
    replaceInPlace(this.extensionSettings, { ...context.extensionSettings, variables: { global: globalVariables } });
    replaceArrayInPlace(this.characters, this.characterId >= 0 ? [{ name: context.characterName, description: "", data: {}, avatar: "none" }] : []);
  }
  /** The local (chat) variable layer as the upstream code leaves it. */
  collectChatVariables() {
    const variables = this.chatMetadata["variables"];
    return typeof variables === "object" && variables !== null ? { ...variables } : {};
  }
  /** The extension's global variable layer (`extension_settings.variables.global`). */
  collectGlobalVariables() {
    const variables = this.extensionSettings["variables"];
    const global = variables?.global;
    return typeof global === "object" && global !== null ? { ...global } : {};
  }
}
function replaceArrayInPlace(target, next) {
  target.length = 0;
  target.push(...next);
}
function replaceInPlace(target, next) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}
function translationsFor(element, table) {
  const edits = [];
  const spec = element.attributes.get("data-i18n");
  if (typeof spec !== "string" || spec === "") return edits;
  for (const part of spec.split(";").map((part2) => part2.trim()).filter(Boolean)) {
    const attributeForm = /^\[([^\]]+)\](.+)$/u.exec(part);
    if (attributeForm !== null) {
      const attribute = attributeForm[1];
      const key = attributeForm[2];
      if (attribute !== void 0 && key !== void 0) {
        const value = table[key];
        if (typeof value === "string") edits.push({ kind: "attribute", attribute, value });
      }
    } else {
      const value = table[part];
      if (typeof value === "string") edits.push({ kind: "text", value });
    }
  }
  return edits;
}
class StEventBus {
  #handlers = /* @__PURE__ */ new Map();
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
  CHARACTER_MESSAGE_RENDERED: "character_message_rendered"
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
  elements.push(root);
  for (const element of elements) {
    const attributes = /* @__PURE__ */ new Map();
    for (const attribute of [...element.attributes]) attributes.set(attribute.name, attribute.value);
    for (const edit of translationsFor({ textContent: element.textContent, attributes }, table)) {
      if (edit.kind === "text") element.textContent = edit.value;
      else element.setAttribute(edit.attribute, edit.value);
    }
  }
}
function syncBindings() {
  state.characterId;
  state.userName;
  state.characterName;
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
  return {
    kind: "reply",
    turn: payload.turn,
    mes: typeof floor.mes === "string" ? floor.mes : payload.text,
    chatVariables: state.collectChatVariables(),
    globalVariables: state.collectGlobalVariables()
  };
}
window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  const data = event.data;
  if (typeof data !== "object" || data === null || data["irisStExt"] !== token) return;
  void handleShellMessage(data).catch((cause) => postError("envelope handling failed", cause));
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
  state as s
};
