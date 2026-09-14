import { s as state } from "../../../chunks/scripts-events-D2xxvW0r.js";
import { U as UnsupportedStCompatApiError } from "../../../chunks/kernel-core-CVpTC58g.js";
const regex_placement = {
  MD_DISPLAY: 0,
  USER_INPUT: 1,
  AI_OUTPUT: 2,
  SLASH_COMMAND: 3,
  WORLD_INFO: 5,
  REASONING: 6
};
function getRegexedString(content, placement, options = {}) {
  let value = String(content);
  const rules = Array.isArray(state.extensionSettings["regex"]) ? state.extensionSettings["regex"] : [];
  for (const rule of rules) {
    if (rule.disabled === true) continue;
    const placements = Array.isArray(rule.placement) ? rule.placement : [];
    if (placements.length > 0 && !placements.includes(placement)) continue;
    if (rule.promptOnly === true && options.isPrompt !== true) continue;
    if (rule.markdownOnly === true && options.isMarkdown !== true) continue;
    if (typeof rule.findRegex !== "string") continue;
    if (typeof rule.replaceString !== "function") {
      const pattern = parseRuleRegex(rule.findRegex);
      if (pattern === null) continue;
      value = value.replace(pattern, rule.replaceString ?? "");
    } else {
      throw new UnsupportedStCompatApiError("regex engine: function replacers in extension_settings.regex");
    }
  }
  return value;
}
function parseRuleRegex(findRegex) {
  const literal = /^\/(.*)\/([gimsuy]*)$/su.exec(findRegex);
  try {
    if (literal !== null) {
      const source = literal[1] ?? "";
      const flags = literal[2] ?? "";
      return new RegExp(source, flags);
    }
    return new RegExp(findRegex, "gu");
  } catch {
    return null;
  }
}
export {
  getRegexedString,
  regex_placement
};
