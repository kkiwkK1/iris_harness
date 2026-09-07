/**
 * An in-memory `IrisClient` for developing and testing the browser half.
 *
 * The interface programs against `IrisClient` and nothing else, so swapping
 * this for `@iris/rpc-client` is one import line. Keeping the fake honest is
 * therefore worth real effort: every place it is easier than the host is a
 * place the UI will be wrong.
 *
 * @module @iris/client-fake
 */

export { createFakeClient, FakeRpcError, type FakeClient, type FakeClientOptions } from './client.ts'
export { readCard, type ReadCard } from './card.ts'
export { fakeItemization } from './prompt.ts'
export {
  activateConnection,
  deleteConnection,
  hostDefault,
  listConnections,
  saveConnection,
  summarize,
} from './connections.ts'
export { mergeSettings } from './settings.ts'
export { DEFAULT_SETTINGS, seedCharacters, seedChats } from './seed.ts'
export {
  fakeBookEntries,
  fakeCardWorldbook,
  FAKE_CARD_BINDINGS,
  FAKE_GLOBAL_SELECT,
  FAKE_WORLDBOOKS,
  type FakeWorldbook,
} from './worldbooks.ts'
export {
  selected,
  toChatSummary,
  toChatView,
  toMessageView,
  type Candidate,
  type FakeChat,
  type FakeMessage,
} from './state.ts'
export { chunk, reasoningFor, replyFor } from './corpus.ts'
