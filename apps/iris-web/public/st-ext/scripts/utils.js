import { s as state } from "../chunks/scripts-events-D2xxvW0r.js";
import "../chunks/kernel-core-CVpTC58g.js";
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(String(text));
  } catch (cause) {
    console.warn("[iris-st-compat] copyText could not reach the clipboard (sandboxed frame)", cause);
  }
}
function getCharaFilename(characterId) {
  const index = characterId ?? state.characterId;
  return `chara_${index >= 0 ? index : "unknown"}`;
}
export {
  copyText,
  getCharaFilename
};
