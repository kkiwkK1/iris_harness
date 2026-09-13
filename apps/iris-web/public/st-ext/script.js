import { s as state, p as persistSettings, u as updateMessageBlockDom } from "./chunks/scripts-events-D2xxvW0r.js";
import { b, e, m, n, a, o, t, c } from "./chunks/scripts-events-D2xxvW0r.js";
import { e as escapeHtml, s as substituteMacrosMinimal, U as UnsupportedStCompatApiError } from "./chunks/kernel-core-CVpTC58g.js";
const chat = state.chat;
const chat_metadata = state.chatMetadata;
const characters = state.characters;
function getCurrentChatId() {
  return state.chatId;
}
function substituteParams(content) {
  return substituteMacrosMinimal(String(content), { userName: state.userName, characterName: state.characterName });
}
function messageFormatting(markup) {
  return escapeHtml(String(markup));
}
function updateMessageBlock(messageId, message) {
  updateMessageBlockDom(Number(messageId), String(message?.mes ?? ""));
}
function appendMediaToMessage() {
}
function addCopyToCodeBlocks() {
}
function saveSettingsDebounced() {
  persistSettings();
}
async function saveChatConditional() {
}
function getThumbnailUrl() {
  return "";
}
function getUserAvatar() {
  return "";
}
function unimplemented(member) {
  throw new UnsupportedStCompatApiError(member);
}
export {
  addCopyToCodeBlocks,
  appendMediaToMessage,
  characters,
  chat,
  chat_metadata,
  b as eventSource,
  e as event_types,
  getCurrentChatId,
  getThumbnailUrl,
  getUserAvatar,
  m as main_api,
  messageFormatting,
  n as name1,
  a as name2,
  o as online_status,
  saveChatConditional,
  saveSettingsDebounced,
  substituteParams,
  t as this_chid,
  unimplemented,
  updateMessageBlock,
  c as user_avatar
};
