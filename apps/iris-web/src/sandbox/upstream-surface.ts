/**
 * Every member upstream's type definitions declare for a card script.
 *
 * Not a list of what Iris provides — `identity.ts` is that, and it holds 31 of
 * these. This is the far larger set a card **may reasonably reach for**, and it
 * exists so that reaching for one Iris has not built produces the right
 * sentence.
 *
 * Without it, `getTavernHelperVersion is not defined` reads as a broken card, and
 * that misattribution is the expensive kind: the report arrives with a suspect
 * already named, so nobody checks the innocent party. It has cost this project
 * twice already — first `waitGlobalInitialized`, then Vue, where a library Iris
 * was supposed to seed went unnamed because no list knew about it. The shape is
 * identical both times: **a checklist can only ever speak about names that are
 * on it**, so anything missing from the list is missing from every report the
 * list can produce.
 *
 * Extracted from the installed Tavern Helper's `@types` declarations rather than
 * written by hand. A hand-kept list that long would rot silently, and the rot is
 * invisible until a card is handed the wrong diagnosis.
 *
 * Membership here says nothing about whether Iris implements a member — only
 * that a card is entitled to expect it. `identity.ts` answers the other question.
 *
 * ## Two lists, two surfaces
 *
 * A card reaches for two vocabularies, and until now only one of them was
 * written down. The Tavern Helper list at the bottom of this file holds the
 * names its `@types` declare — 171 at the extraction — plus `setChatMessage`,
 * which upstream's registration table carries and its `@types` never did; a
 * list read off the declarations alone had no way to know the member existed,
 * and a card calling it met `setChatMessage is not defined` with no sentence
 * anywhere naming it as expected scope (measured: 魔法少女的扣扣审判1.0's 封面
 * regex, at its enter button). {@link UPSTREAM_CONTEXT_MEMBERS}, first, holds
 * SillyTavern's own — the 145 keys `getContext()` returns. They are separate
 * lists because they are separate authorities, they are extracted from
 * different files, and a name on one says nothing about the other.
 *
 * **Declaration order matters here, unusually, and so does this comment's
 * wording.** The caliper `scripts/th-member-census.mjs` (and, until its branch
 * was retired on 2026-09-11, `scripts/th-surface-audit.mjs` too) finds the
 * Tavern Helper list by searching this file for its name and then matching
 * every quoted identifier from there to the **end of the file**. Two
 * consequences, and both are easy to trip over while doing something else:
 *
 * - a second array placed *after* that list is swallowed into it — 171 becomes
 *   316, and a caliper answering with a 316-name surface reports most of it as
 *   "declared but unused", which reads as a finding rather than as a broken
 *   extractor. So the context list goes first;
 * - and the search finds the **first** occurrence of the name, comment text
 *   included, so spelling it in prose up here would put the cut above the
 *   context list and swallow it anyway. That is why this section talks about
 *   "the Tavern Helper list" instead of naming it.
 *
 * The census in this tree slices to the closing bracket and no longer cares;
 * the member census still reads to the end of the file, so the order still
 * matters.
 *
 * @module iris-web/sandbox/upstream-surface
 */

/**
 * Every key `SillyTavern.getContext()` returns — the *other* surface a card
 * reaches for, and the one no list here used to cover.
 *
 * Extracted from the installed SillyTavern's `public/scripts/st-context.js`
 * (1.18.0, `getContext()`'s returned object literal), not written by hand, and
 * re-extracted by `upstream-context.test.ts` wherever that install is present.
 * Two independently written extractors — this one and `st-context-audit.mjs`
 * (retired with its branch on 2026-09-11; frozen at PR #51's head `c91d7b5`) —
 * answered the same 145 names, which is the only reason the number is quoted
 * rather than hedged.
 *
 * It exists for the same reason the Tavern Helper list does, and closes the same
 * gap one surface later: a card reading `SillyTavern.printMessages` was told "Iris
 * has not built" it in a sentence that could not distinguish **a member
 * upstream really has** from **a name nothing anywhere carries** — and the
 * corpus reaches for both. The frame's report now separates them
 * (`frame.ts`, the facade's absent-member branch), and only this list lets it.
 *
 * **Not the parent surface.** These 145 are reachable in a card *frame* as
 * `SillyTavern.X` because Tavern Helper's `predefine.js:26-31` defines that
 * frame's `SillyTavern` global as `{...getContext(), getContext,
 * writeExtensionField}`. They are **not** on the host page's `window`:
 * `public/script.js` loads as `type="module"` (`index.html:8204`), so its
 * exports never land there, and the SillyTavern page's own `SillyTavern` global
 * carries only `{libs, getContext}` (`script.js:292-295`). A card reading
 * `top.printMessages` gets `undefined` upstream too — measured, and recorded in
 * ST-CONTEXT-SURFACE-AUDIT §4.2.3 (retired with its branch on 2026-09-11 and
 * frozen at PR #51's head `c91d7b5`; `notes/apps/iris-web/CARD-SURFACE.md`
 * says where it went, since the file is not in this tree). So this list must
 * never be consulted by
 * the virtual **parent** proxy's absent-name report: it would answer "upstream
 * declares this" about names upstream's page does not have, manufacturing scope
 * we never owed out of a list that is true about a different object.
 */
export const UPSTREAM_CONTEXT_MEMBERS: readonly string[] = [
  'ARGUMENT_TYPE',
  'CONNECT_API_MAP',
  'ChatCompletionService',
  'ConnectionManagerRequestService',
  'ModuleWorkerWrapper',
  'POPUP_RESULT',
  'POPUP_TYPE',
  'Popup',
  'SlashCommand',
  'SlashCommandArgument',
  'SlashCommandEnumValue',
  'SlashCommandNamedArgument',
  'SlashCommandParser',
  'TextCompletionService',
  'ToolManager',
  'accountStorage',
  'activateSendButtons',
  'addLocaleData',
  'addOneMessage',
  'appendMediaToMessage',
  'callGenericPopup',
  'callPopup',
  'canPerformToolCalls',
  'characterId',
  'characters',
  'chat',
  'chatCompletionSettings',
  'chatId',
  'chatMetadata',
  'clearChat',
  'constants',
  'convertCharacterBook',
  'createCharacterData',
  'deactivateSendButtons',
  'deleteLastMessage',
  'deleteMessage',
  'ensureMessageMediaIsArray',
  'eventSource',
  'eventTypes',
  'event_types',
  'executeSlashCommands',
  'executeSlashCommandsWithOptions',
  'extensionPrompts',
  'extensionSettings',
  'extractMessageFromData',
  'generate',
  'generateQuietPrompt',
  'generateRaw',
  'generateRawData',
  'getCharacterCardFields',
  'getCharacterSource',
  'getCharacters',
  'getChatCompletionModel',
  'getCurrentChatId',
  'getCurrentLocale',
  'getExtensionManifest',
  'getMediaDisplay',
  'getMediaIndex',
  'getOneCharacter',
  'getPresetManager',
  'getReasoningTemplateByName',
  'getRequestHeaders',
  'getTextGenServer',
  'getTextTokens',
  'getThumbnailUrl',
  'getTokenCount',
  'getTokenCountAsync',
  'getTokenizerModel',
  'getWorldInfoNames',
  'getWorldInfoPrompt',
  'groupId',
  'groups',
  'hideLoader',
  'humanizedDateTime',
  'importFromExternalUrl',
  'importTags',
  'isMobile',
  'isToolCallingSupported',
  'loadWorldInfo',
  'loader',
  'macros',
  'mainApi',
  'maxContext',
  'menuType',
  'messageFormatting',
  'name1',
  'name2',
  'onlineStatus',
  'openCharacterChat',
  'openGroupChat',
  'openThirdPartyExtensionMenu',
  'parseReasoningFromString',
  'powerUserSettings',
  'printMessages',
  'registerDataBankScraper',
  'registerDebugFunction',
  'registerFunctionTool',
  'registerHelper',
  'registerMacro',
  'registerSlashCommand',
  'reloadCurrentChat',
  'reloadWorldInfoEditor',
  'renameChat',
  'renderExtensionTemplate',
  'renderExtensionTemplateAsync',
  'saveChat',
  'saveMetadata',
  'saveMetadataDebounced',
  'saveReply',
  'saveSettingsDebounced',
  'saveWorldInfo',
  'scrollChatToBottom',
  'scrollOnMediaLoad',
  'selectCharacterById',
  'sendGenerationRequest',
  'sendStreamingRequest',
  'sendSystemMessage',
  'setExtensionPrompt',
  'shouldSendOnEnter',
  'showLoader',
  'stopGeneration',
  'streamingProcessor',
  'substituteParams',
  'substituteParamsExtended',
  'swipe',
  'symbols',
  't',
  'tagMap',
  'tags',
  'textCompletionSettings',
  'timestampToMoment',
  'tokenizers',
  'translate',
  'unregisterFunctionTool',
  'unregisterMacro',
  'unshallowCharacter',
  'unshallowGroupMembers',
  'updateChatMetadata',
  'updateMessageBlock',
  'updateReasoningUI',
  'updateWorldInfoList',
  'uuidv4',
  'variables',
  'writeExtensionField',
  'writeExtensionFieldBulk',
]

/** Names upstream declares as available to a card script. */
export const UPSTREAM_MEMBERS: readonly string[] = [
  'EjsTemplate',
  'Mvu',
  'SillyTavern',
  'TavernHelper',
  'appendAudioList',
  'appendInexistentScriptButtons',
  'builtin',
  'builtin_prompt_default_order',
  'createCharacter',
  'createChatMessages',
  'createLorebook',
  'createLorebookEntries',
  'createOrReplaceCharacter',
  'createOrReplacePersona',
  'createOrReplacePreset',
  'createOrReplaceWorldbook',
  'createPersona',
  'createPreset',
  'createWorldbook',
  'createWorldbookEntries',
  'default_preset',
  'deleteCharacter',
  'deleteChatMessages',
  'deleteLorebook',
  'deleteLorebookEntries',
  'deletePersona',
  'deletePreset',
  'deleteVariable',
  'deleteWorldbook',
  'deleteWorldbookEntries',
  'errorCatched',
  'eventClearAll',
  'eventClearEvent',
  'eventClearListener',
  'eventEmit',
  'eventEmitAndWait',
  'eventMakeFirst',
  'eventMakeLast',
  'eventOn',
  'eventOnButton',
  'eventOnce',
  'eventRemoveListener',
  'formatAsDisplayedMessage',
  'formatAsTavernRegexedString',
  'generate',
  'generateRaw',
  'getAllEnabledScriptButtons',
  'getAllVariables',
  'getAudioList',
  'getAudioSettings',
  'getButtonEvent',
  'getCharAvatarPath',
  'getCharData',
  'getCharLorebooks',
  'getCharWorldbookNames',
  'getCharacter',
  'getCharacterIds',
  'getCharacterNames',
  'getChatHistoryBrief',
  'getChatHistoryDetail',
  'getChatLorebook',
  'getChatMessages',
  'getChatWorldbookName',
  'getCurrentAudio',
  'getCurrentCharPrimaryLorebook',
  'getCurrentCharacterId',
  'getCurrentCharacterName',
  'getCurrentMessageId',
  'getCurrentPersonaId',
  'getCurrentPersonaName',
  'getExtensionInstallationInfo',
  'getExtensionType',
  'getGlobalWorldbookNames',
  'getIframeName',
  'getLastMessageId',
  'getLoadedPresetName',
  'getLorebookEntries',
  'getLorebookSettings',
  'getLorebooks',
  'getMessageId',
  'getModelList',
  'getOrCreateChatLorebook',
  'getOrCreateChatWorldbook',
  'getPersona',
  'getPersonaAvatarPath',
  'getPersonaIds',
  'getPersonaNames',
  'getPreset',
  'getPresetNames',
  'getProxyPresetNames',
  'getScriptButtons',
  'getScriptId',
  'getScriptInfo',
  'getScriptName',
  'getScriptTrees',
  'getTavernHelperExtensionId',
  'getTavernHelperVersion',
  'getTavernRegexes',
  'getTavernVersion',
  'getVariables',
  'getWorldbook',
  'getWorldbookNames',
  'iframe_events',
  'importRawCharacter',
  'importRawChat',
  'importRawPreset',
  'importRawTavernRegex',
  'importRawWorldbook',
  'initializeGlobal',
  'injectPrompts',
  'insertOrAssignVariables',
  'insertVariables',
  'installExtension',
  'isAdmin',
  'isCharacterTavernRegexesEnabled',
  'isInstalledExtension',
  'isPresetNormalPrompt',
  'isPresetPlaceholderPrompt',
  'isPresetSystemPrompt',
  'loadPreset',
  'pauseAudio',
  'placeholder_prompt_default_order',
  'playAudio',
  'rebindCharWorldbooks',
  'rebindChatWorldbook',
  'rebindGlobalWorldbooks',
  'refreshOneMessage',
  'registerMacroLike',
  'registerVariableSchema',
  'reinstallExtension',
  'reloadIframe',
  'renamePreset',
  'replaceAudioList',
  'replaceCharacter',
  'replaceLorebookEntries',
  'replacePersona',
  'replacePreset',
  'replaceScriptButtons',
  'replaceScriptInfo',
  'replaceScriptTrees',
  'replaceTavernRegexes',
  'replaceVariables',
  'replaceWorldbook',
  'retrieveDisplayedMessage',
  'rotateChatMessages',
  'setAudioSettings',
  'setChatLorebook',
  'setChatMessage',
  'setChatMessages',
  'setCurrentCharLorebooks',
  'setLorebookEntries',
  'setLorebookSettings',
  'setPreset',
  'stopAllGeneration',
  'stopGenerationById',
  'substitudeMacros',
  'tavern_events',
  'triggerSlash',
  'uninjectPrompts',
  'uninstallExtension',
  'unregisterMacroLike',
  'updateCharacterWith',
  'updateExtension',
  'updateLorebookEntriesWith',
  'updatePersonaWith',
  'updatePresetWith',
  'updateScriptButtonsWith',
  'updateScriptTreesWith',
  'updateTavernRegexesWith',
  'updateVariablesWith',
  'updateWorldbookWith',
  'waitGlobalInitialized',
]
