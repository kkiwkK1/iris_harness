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
function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function substituteMacrosMinimal(input, names, now = /* @__PURE__ */ new Date()) {
  const resolved = {
    user: names.userName,
    char: names.characterName,
    persona: "",
    time: now.toTimeString().slice(0, 8),
    date: now.toISOString().slice(0, 10),
    weekday: WEEKDAYS[now.getDay()] ?? "Sunday"
  };
  return input.replace(/\{\{(\w+)\}\}/gu, (match, name) => {
    const value = resolved[name];
    return value === void 0 ? match : value;
  });
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
export {
  StCompatState as S,
  UnsupportedStCompatApiError as U,
  escapeHtml as e,
  substituteMacrosMinimal as s,
  translationsFor as t
};
