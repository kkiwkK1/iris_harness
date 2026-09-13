import { s as state } from "../chunks/scripts-events-D2xxvW0r.js";
import "../chunks/kernel-core-CVpTC58g.js";
const world_info_logic = {
  AND_ANY: 0,
  NOT_ALL: 1,
  NOT_ANY: 2,
  AND_ALL: 3
};
const world_info_position = {
  before: 0,
  after: 1,
  ANTop: 2,
  ANBottom: 3,
  atDepth: 4,
  EMTop: 5,
  EMBottom: 6,
  outlet: 7
};
const METADATA_KEY = "world_info";
const DEFAULT_DEPTH = 4;
const DEFAULT_WEIGHT = 100;
let world_info_case_sensitive = false;
let world_info_match_whole_words = false;
let world_info_use_group_scoring = false;
let world_info_max_recursion_steps = 0;
const world_names = [];
const selected_world_info = [];
const world_info = { charLore: null, globalSelect: [] };
async function loadWorldInfo(name) {
  const book = state.worldbooks.get(name);
  if (book !== void 0) return book;
  console.debug(`[iris-st-compat] loadWorldInfo("${name}") serves an empty book — the pilot hydrates no world-info entries`);
  return { entries: {} };
}
function parseRegexFromString(input) {
  const match = /^\/(.+)\/([gimsuy]*)$/su.exec(input);
  if (match === null) return null;
  const source = match[1];
  const flags = match[2];
  if (source === void 0) return null;
  try {
    return new RegExp(source, flags ?? "");
  } catch {
    return null;
  }
}
export {
  DEFAULT_DEPTH,
  DEFAULT_WEIGHT,
  METADATA_KEY,
  loadWorldInfo,
  parseRegexFromString,
  selected_world_info,
  world_info,
  world_info_case_sensitive,
  world_info_logic,
  world_info_match_whole_words,
  world_info_max_recursion_steps,
  world_info_position,
  world_info_use_group_scoring,
  world_names
};
