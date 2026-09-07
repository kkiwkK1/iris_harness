/**
 * The Iris shell's copy, in the two languages the interface ships with.
 *
 * **What is here: only the shell's own fixed copy.** Navigation, buttons,
 * placeholders, notes, panel headings, the consent and cleanup dialogs, and the
 * sentence builders the panels render. What is deliberately **not** here: card
 * content, model output, a card script's own notices, and the host diagnostic
 * reports' message bodies — the first three are a card author's words, and the
 * last one is kept in English so it can be read against the source that
 * produced it (the panels' own headings and buttons around those bodies are
 * translated).
 *
 * `en` is the key source: its key union is the type every other language has to
 * satisfy, so a key added here and not translated is a type error, not a
 * silently English row in a Chinese interface. A test (`i18n.test.ts`) holds the
 * two dictionaries to the same placeholder names as well.
 *
 * The full inventory — what was counted, where each string lived, and what was
 * left untranslated on purpose — is in `STRINGS.md` beside this file.
 *
 * @module iris-web/app/i18n/strings
 */

/** The languages the shell ships with. English is the source of the keys. */
export type Language = 'en' | 'zh'

/**
 * The English copy. Keys are grouped by the component that renders them; the
 * comments carry the context the translation needs.
 */
export const en = {
  /** Sidebar. */
  sidebarAria: 'Conversations and characters',
  tabReading: 'Reading',
  tabCharacters: 'Characters',
  chatsEmpty: 'No conversations yet. Pick a character to start one.',
  libraryEmpty: 'The library is empty. Drop a character card anywhere to import it.',
  importCard: 'Import a card',
  deleteConversation: 'Delete conversation',
  removeFromLibrary: 'Remove from library',
  moreActionsFor: 'More actions for {title}',
  noCreatorListed: 'no creator listed',
  byCreator: 'by {creator}',
  messageCount: '{count} messages',

  /** Sidebar content filter (`chat.search`). */
  chatSearchAria: 'Search conversations',
  chatSearchPlaceholder: 'Search message text…',
  chatSearchEmpty: 'No conversation contains “{query}”.',
  /** The hit's floor, as the stored index a card script would use. */
  chatSearchFloor: 'floor {floor}',
  chatSearchMore: '+{count} more floors',

  /** Chat import/export — the SillyTavern migration path. */
  importChats: 'Import chats (SillyTavern JSONL)',
  exportChat: 'Export as SillyTavern JSONL',
  openParentChat: 'Open the conversation this branched from',
  chatsImportedOne: 'Imported 1 chat.',
  chatsImported: 'Imported {n} chats.',
  chatExported: 'Exported “{name}”.',

  /** Character library — tags, favorites, sorting, and the card manager. */
  /* One box over names *and* tags, replacing the tag dropdown: the artboards
     promise 「搜索角色或标签」, and a corpus-wide tag census runs to dozens of
     names, which a select turns into a scroll. */
  librarySearchAria: 'Search characters and tags',
  librarySearchPlaceholder: 'Search characters or tags',
  librarySearchEmpty: 'No character matches “{query}”.',
  sortByAria: 'Sort characters',
  sortByName: 'By name',
  sortByUpdated: 'By updated',
  sortByFavorite: 'Favorites first',
  /* The character page: the artboards' 简介 band over 对话 / 世界书 / 脚本.
     A fact the summary does not carry removes its column rather than printing
     an empty one, so every sentence here is written for a fact that is present
     — the absent branches are `null`, not copy. The tag and card-file rows the
     page stood in while the protocol carried no card contents are gone with
     them. */
  characterPageAria: 'Character',
  startNewChat: 'Start a new conversation',
  faceConversations: 'Conversations',
  faceNoConversations: 'None yet',
  faceOneConversation: '1 open',
  faceOpenCount: '{n} open',
  faceLatest: 'Last {when}',
  /** Heading over the card's own description, clipped by the host to 200 characters. */
  faceDescription: 'Description',
  faceWorldbook: 'World book',
  /** The card's *embedded* book, never a book it is bound to by name. */
  faceBookEntries: '{n} entries embedded',
  /** A card that ships a book with nothing in it — distinct from shipping none. */
  faceBookEmpty: 'An embedded book, no entries',
  faceScripts: 'Scripts',
  /** No plural noun: the count reads correctly at 1 in both languages. */
  faceScriptCount: '{n} in this card',
  /** Shown only when this card's consent answer is actually known. */
  faceScriptsAllowed: 'You allowed these to run',
  faceScriptsDeclined: 'You declined these',
  faceCreator: 'By {creator}',
  facePickHint: 'Pick a character on the left to see its card.',

  /* The character page's three lists, fetched per page open rather than carried
     by the library (`loadCharacterDetail`). Each list sits under the count its
     column already showed, so a host that refuses a half leaves the page
     exactly as it was rather than empty. */
  /** One conversation row's own action, named so a screen reader hears which. */
  faceOpenConversation: 'Open “{title}”',
  /** The row under a book's name: the three figures that describe it. */
  faceBookFigures: '{n} entries · {enabled} on · {constant} always on',
  /** A book with no entries at all — the file exists and is empty. */
  faceBookNoEntries: 'No entries',
  /** The card carries the book itself; this host has not written it to a file. */
  faceBookEmbedded: 'in the card, not yet a file',
  /** This host minted the name because the one the card asked for collided. */
  faceBookMinted: 'renamed by this host',
  /** Bound by name, with no readable book behind it. 2 of 18 local bindings. */
  faceBookMissing: 'bound, but no such book here',
  /** A book the reader bound to this character themselves, beside the card's. */
  faceBookExtra: 'you bound this one',
  /** An entry that fires on every scan without matching anything. */
  faceEntryConstant: 'always on',
  /** What fires an entry, keys joined by the list separator. */
  faceEntryKeys: 'Keys: {keys}',
  /** A selective entry with no keys: it can never fire, and nothing else says so. */
  faceEntryNoKeys: 'no keys — never fires',
  /** Secondary conditions exist; how they combine is the entry editor's business. */
  faceEntrySecondary: '+{n} secondary',
  /** An entry its author, or the reader, switched off. */
  faceEntryOff: 'off',
  /* The eight world-info positions, in ST's own terms. Five of them do not occur
     in the local corpus and are carried for correctness. */
  facePlaceBeforeChar: 'before the character definition',
  facePlaceAfterChar: 'after the character definition',
  facePlaceBeforeExamples: 'before the example messages',
  facePlaceAfterExamples: 'after the example messages',
  facePlaceBeforeNote: 'before the author’s note',
  facePlaceAfterNote: 'after the author’s note',
  facePlaceAtDepth: 'at depth {depth}',
  facePlaceOutlet: 'in an outlet',
  /** Every row this list can show came out of the card; `script.list` reports no other tier. */
  faceScriptInCard: 'in the card',
  faceScriptOn: 'enabled',
  /** The two switches, said as the reason rather than as the result. */
  faceScriptOffByCard: 'the author shipped it off',
  faceScriptOffByYou: 'you switched it off',
  faceScriptOnByYou: 'you switched it on',
  /** Both numbers, always: 58 of the corpus's 89 buttons are hidden by their author. */
  faceScriptButtons: '{n} buttons, {visible} shown',
  /** The switch lives beside the conversation, not here — this page only reports. */
  faceScriptSwitchNote: 'Switch a script off in the card panel, beside the conversation it runs in.',
  favorite: 'Add to favorites',
  unfavorite: 'Remove from favorites',
  duplicateCharacter: 'Duplicate',
  renameCharacterMenu: 'Rename',
  editTags: 'Edit tags',
  exportCardPng: 'Export card PNG',
  exportCardJson: 'Export card JSON',
  characterNameAria: 'Character name',
  tagsInputAria: 'Tags, comma-separated',
  characterDuplicated: 'Duplicated “{name}”.',
  characterRenamed: 'Renamed to “{name}”.',
  characterExported: 'Exported “{name}”.',

  /** Relative time (`since`) and sizes (`describeBytes`). */
  justNow: 'just now',
  minutesAgo: '{n}m ago',
  hoursAgo: '{n}h ago',
  daysAgo: '{n}d ago',
  sizeEmpty: 'empty',
  unknownSize: 'unknown size',

  /** Masthead. */
  showConversations: 'Show conversations',
  settings: 'Settings',
  renameConversation: 'Rename this conversation',
  conversationTitle: 'Conversation title',
  notStarted: 'not started',
  oneTurn: '1 turn',
  turns: '{n} turns',
  writingNow: 'writing…',
  /* The artboards' 「N 个脚本在运行」. Counted from the run states, not the
     script list — `Masthead.tsx` says why those are different questions. */
  scriptsRunning: '{n} scripts running',
  seededNotice: 'Seeded data — this page is not talking to a host. Add',
  seededNoticeSource: 'Source:',

  /** App shell. */
  notConnected: 'Not connected to the Iris host. Nothing you write will be sent.',
  dismiss: 'Dismiss',
  /* The formats named here are `card-files.ts` `CARD_FILE_LABELS`; a test holds
     both languages to that table, because this row once promised `.charx` after
     the host had stopped taking it. */
  dropCard: 'Drop a character card — PNG, JPG or JSON — to add it to the library.',

  /** Chat pane. */
  openingLastChat: 'Opening your last conversation…',
  nothingOpen: 'Nothing open yet.',
  pickCharacterHint: 'Pick a character in the sidebar to begin a conversation.',
  showEarlier: 'Show {n} earlier',
  hiddenAbove: '{n} above',
  pageBlank: 'The page is blank.',
  writeFirstLine: 'Write the first line and {title} will answer.',

  /** Composer. */
  irisWriting: 'Iris is writing…',
  writeYourPart: 'Write your part…',
  yourMessage: 'Your message',
  promptButton: 'Prompt',
  composerHint: 'Enter sends · Shift+Enter for a new line · Alt+←/→ changes reading',
  send: 'Send',
  stop: 'Stop',

  /** The composer's model capsule and the menu behind it. */
  modelMenuOpen: 'Change the model for this conversation ({model})',
  modelMenuHeading: 'Model for this conversation',
  modelMenuFromConnection: 'From {connection}',
  /**
   * The heading when the list belongs to the host's own startup connection —
   * where a host configured from its environment stays until the user saves a
   * profile. The variable's *name* is named because that is where the reader
   * goes to change the route; its value appears nowhere.
   */
  modelMenuFromHost: 'From the host’s own connection',
  modelMenuFromHostEnv: 'From the host’s own connection ({keyEnv})',
  modelRestoreConnectionDefault: 'Back to the connection’s model ({model})',
  /** The dot beside the capsule: this chat is not on the connection's model. */
  modelOverriddenHere: 'This conversation overrides the model',
  modelMenuNoList: 'No model list for this connection yet.',
  modelMenuNoConnection: 'No connection is active, so there is no model list to offer.',
  /** Opening the menu asked the endpoint for its list, and the answer is not back. */
  modelMenuReading: 'Reading the model list…',
  /** It came back a no. `reason` is the host's own named refusal, passed through. */
  modelMenuReadFailed: 'Could not read the model list — {reason}',

  /** Message row. */
  save: 'Save',
  cancel: 'Cancel',
  copy: 'Copy',
  edit: 'Edit',
  regenerate: 'Regenerate',
  /** Write on from the newest reply; the result rejoins that floor. */
  continueWriting: 'Continue',
  /** Have the model write the user's own next line. */
  speakForMe: 'Speak for me',
  delete: 'Delete',
  copied: 'Copied.',
  generatingAria: 'Generating',

  /** Floor actions menu (`iris.message.actions` — contributions fold in here). */
  floorActions: 'Actions',
  /** Demo provider (`DemoActionsSection`), the B10 seam's living fixture. */
  demoSection: 'Demo — floor actions',
  demoProvider: 'Demo provider',
  demoOn: 'Installed',
  demoOff: 'Not installed',
  demoNote: 'Registers one floor action (“Copy as plain text”) through the iris.message.actions seam, as living proof of the extension point. Uninstalling leaves nothing behind.',
  demoCopyPlain: 'Copy as plain text',
  demoCopyPlainTitle: 'Copy this floor’s words without the markdown source',
  copiedPlain: 'Copied as plain text.',
  demoCopyFailed: 'Could not reach the clipboard.',

  /** Variant rail. */
  railReadings: '{count} readings of this reply',
  railRecord: '{count} readings were generated for this reply; the current one is {index}',
  railEarlier: 'Earlier reading',
  railLater: 'Later reading',
  railReadingOf: 'Reading {index} of {count}',

  /** Reasoning disclosure. */
  thinking: 'Thinking',
  reasoningWords: 'Reasoning · {n} words',

  /** Message interface slots. */
  renderThisOne: 'Render this one',

  /** Body-tag scaffolding, folded away from the prose. */
  bodyLeakSummary: 'Model scaffolding outside the body tag',

  /** Script buttons bar. */
  cardButtonsAria: 'Card script buttons',
  cardActionsToggle: 'Card actions ({n})',

  /** Overlay collapse control. */
  showCardUi: 'Show card UI',
  hideCardUi: 'Hide card UI',
  showCardUiTitle: 'Show the card interface',
  hideCardUiTitle: 'Collapse the card interface — Iris stays reachable',

  /** State panel. */
  stateAria: 'Conversation state',
  /* 「变量」, which is what this margin is: the host's own variable manager
     (canvas.json), not a general "state" panel. */
  stateHead: 'Variables',
  /* The collapse control on its heading row. Two labels, so the button says
     what pressing it does rather than where it is. */
  stateCollapse: 'Fold the variables away',
  stateExpand: 'Show the variables',
  /* Shown on the same control while the margin is yielding its column to the
     settings drawer: the reader's choice is intact and comes back on its own,
     so the sentence promises that rather than reporting a fault. */
  stateYielded: 'The settings panel is using this column — it comes back when you close the panel',
  stateEmpty: 'Nothing tracked yet. When a card keeps variables (MVU stat_data), they appear here as the scene moves.',
  booleanYes: 'yes',
  booleanNo: 'no',
  stateSearchAria: 'Filter variables by name',
  stateSearchPlaceholder: 'Filter by name…',
  stateSearchEmpty: 'No variable name contains “{query}”.',
  stateNoChanges: 'Nothing changed this round.',
  stateCollapseAll: 'Collapse all',
  stateExpandAll: 'Expand all',
  stateOnlyChanges: 'Changes only',
  stateOnlyChangesTitle: 'Show only what moved this round',
  /** The one-line tally under the tools; the symbols are shared, the sentence around them is not. */
  stateDiffSummaryAria: 'This round: {added} added, {changed} changed, {removed} removed',
  stateBadgeNew: 'new',
  stateBadgeChanged: 'mod',
  stateRemovedHead: 'Removed this round',
  stateItems: '{n} items',
  stateSelfHealed: 'self-healed',
  reconnected: 'Reconnected to the Iris host.',
  noticeRepeatAria: 'repeated {n} times',

  /** Settings drawer. */
  drawerAria: 'Settings',
  defaultsForNew: 'Defaults for new conversations',
  thisConversation: 'This conversation',
  close: 'Close',
  settingsNotLoaded: 'Settings have not loaded.',
  sectionConnection: 'Connection',
  sectionRoute: 'Route',
  sectionSampling: 'Sampling',
  sectionReplies: 'Replies',
  sectionReading: 'Reading',
  sectionLanguage: 'Language',
  sectionAbout: 'General & about',

  /** Card summaries — what a folded card says in its head. */
  noActiveConnection: 'no active connection',
  presetNoneActive: 'no preset active',
  worldbookSummary: '{count} of {total} selected',
  scriptSummary: '{count} scripts',
  samplingDefault: 'host defaults',
  samplingSet: '{count} set',
  repliesTrim: 'trim',
  repliesSquash: 'merge',
  repliesContinue: 'continue: {word}',
  aboutSummary: 'startup · backup · credentials',

  /** World books panel. */
  sectionWorldbooks: 'World books',
  worldbooksNotLoaded: 'World book settings have not loaded.',
  worldbooksEmpty: 'No world books in this installation.',
  worldbookGlobalSelect: 'Injected into every chat',
  /** The card's *extra* bindings, which is the only half this panel writes. */
  worldbookCharBind: "This card's extra books",
  worldbookCharBindCount: '{count} bound of {total} on disk',
  worldbookCharPrimary: 'The card itself binds: {name}',
  worldbookCharPrimaryNone: 'The card itself binds no book.',
  worldbookCharNote: 'Extra books join the scan on the next chat open; stored with the profile, never written into the card.',

  /**
   * This card's own book — the panel's first section.
   *
   * `worldbookCardRule` is the mechanism said in words, which is what the user
   * asked for: a chat plays its own card's book and nothing else's, plus
   * whatever is globally on. It is not a promise the panel makes — it is what
   * `worldbooks.ts` already does ("choose, never combine") — but the panel was
   * silent about it, and a reader with nine flat book names had no way to know.
   */
  worldbookThisCard: "This card's world book",
  /** The book has a file. */
  worldbookCardSourceNamed: 'a book on disk',
  /** The card carries the entries and no file holds them yet. */
  worldbookCardSourceEmbedded: 'embedded in the card, not written out yet',
  /** Embedded, and the card binds no name for it either. */
  worldbookCardEmbeddedUnnamed: 'the card’s own book, unnamed',
  worldbookCardNone: 'This card has no world book.',
  /** Said only when the name on screen is not the name on the card. */
  worldbookCardMinted: 'Iris wrote it out under a name of its own, because the one the card asked for ({wanted}) was taken.',
  worldbookCardRule: 'This conversation plays this card’s book, plus whatever is switched on globally below. No other card’s book reaches it.',
  worldbookCardNotLoaded: 'This host keeps no world books, so there is nothing to say about this card’s.',
  worldbookNoChat: 'Open a conversation to see which book its card plays.',

  /** The global section — folded by default, so a long book list cannot crowd. */
  worldbookGlobalHead: 'Switched on for every chat',
  worldbookGlobalCount: '{count} on of {total} on disk',
  worldbookGlobalNone: 'None — every conversation plays only its own card’s book.',
  worldbookGlobalExpand: 'Show all {total} books',
  worldbookGlobalCollapse: 'Hide the full list',
  /** Beside a book some card claims, so a list of strangers becomes a list of names. */
  worldbookFromCard: 'from {name}',
  worldbookEntryCount: '{count} entries',
  worldbookScanDepth: 'Scan depth',
  worldbookScanDepthNote: 'How many messages back a keyword scan reads.',
  worldbookBudget: 'Token budget (% of context)',
  worldbookBudgetNote: 'The share of the context window entries may spend.',
  worldbookBudgetCap: 'Budget cap (tokens)',
  worldbookBudgetCapNote: 'Absolute ceiling; 0 means the percentage alone applies.',
  worldbookMinActivations: 'Minimum activations',
  worldbookMinActivationsNote: 'Keep widening the scan until this many entries fire; 0 disables.',
  worldbookMinActivationsDepthMax: 'Widening ceiling',
  worldbookMinActivationsDepthMaxNote: 'How far minimum activations may widen; 0 means the chat length.',
  worldbookMaxRecursionSteps: 'Recursion step cap',
  worldbookMaxRecursionStepsNote: 'Hard limit on scan iterations; 0 disables recursion control.',
  worldbookStrategy: 'Insertion order',
  strategyEvenly: 'Sorted together',
  strategyCharacterFirst: 'Character first',
  strategyGlobalFirst: 'Global first',
  worldbookRecursive: 'Recursive scanning',
  worldbookRecursiveNote: 'Activated entries are scanned for further matches.',
  worldbookCaseSensitive: 'Case sensitive',
  worldbookMatchWholeWords: 'Whole-word matching',
  worldbookMatchWholeWordsNote: 'Off matches substrings — what most community books are tuned against.',
  worldbookUseGroupScoring: 'Group scoring',
  worldbookUseGroupScoringNote: 'Resolve inclusion groups by key hits instead of weighted draw.',
  switchOn: 'On',
  switchOff: 'Off',

  /** World book entry editor. Field wording follows upstream's own editor. */
  wiEditorTitle: 'Entry editor',
  wiPickBook: 'Pick a book to edit…',
  wiEditorNote: 'Saving rewrites the whole book file through the host (worldbook.replace); entries keep their uids. The bindings above are not touched.',
  wiSaved: 'Saved “{name}”.',
  wiBackupExported: 'Backed up “{name}” to your downloads.',
  wiUnsavedNamed: '“{name}” has {count} unsaved entries.',
  wiUnsavedTitle: 'Unsaved changes',
  wiUnsavedAsk: '“{name}” has {count} unsaved entries. Save before leaving?',
  wiUnsavedSave: 'Save and continue',
  wiUnsavedDiscard: 'Discard changes',
  wiUnsavedResume: 'Keep editing',
  wiFilterPlaceholder: 'Filter by title, key, or content…',
  wiFilterEmpty: 'No entry matches the filter.',
  wiSort: 'Sort',
  wiShownCount: '{shown} / {total} entries',
  wiSave: 'Save',
  wiDiscard: 'Discard',
  wiBackup: 'Download backup',
  wiClose: 'Close editor',
  wiExpand: 'Edit “{title}”',
  wiUntitled: '(untitled #{uid})',
  wiBadgeOrder: 'order {order}',
  wiBadgeProbability: '{probability}%',
  wiBadgeDisabled: 'disabled',
  wiBadgeConstant: 'constant',
  wiBadgeChanged: 'changed',
  wiEnabledShort: 'On',
  wiKeyPlaceholder: 'Type a key, Enter to add…',
  wiKeyRemove: 'Remove key “{key}”',
  wiKeysPrimary: 'Primary keys',
  wiKeysSecondary: 'Secondary keys',
  wiLogic: 'Logic',
  wiLogicNote: 'How the secondary keys qualify a primary hit: AND ANY — any one matches; AND ALL — all match; NOT ALL — not every one matches; NOT ANY — none matches.',
  wiLogicAndAny: 'AND ANY',
  wiLogicAndAll: 'AND ALL',
  wiLogicNotAll: 'NOT ALL',
  wiLogicNotAny: 'NOT ANY',
  wiStrategy: 'Status',
  wiStrategyConstant: '🔵 Constant',
  wiStrategyNormal: '🟢 Normal',
  wiStrategyVectorized: '🔗 Vectorized',
  wiPosition: 'Position',
  wiPosBeforeChar: '↑Char — before character definitions',
  wiPosAfterChar: '↓Char — after character definitions',
  wiPosBeforeEm: '↑EM — before example messages',
  wiPosAfterEm: '↓EM — after example messages',
  wiPosBeforeAn: '↑AN — before author’s note',
  wiPosAfterAn: '↓AN — after author’s note',
  wiPosAtDepth: '@D — at depth',
  wiPosOutlet: 'Outlet — into a named outlet',
  wiRole: 'Role',
  wiRoleSystem: 'System',
  wiRoleUser: 'User',
  wiRoleAssistant: 'Assistant',
  wiDepth: 'Depth',
  wiOrder: 'Order',
  wiProbability: 'Trigger %',
  wiUseProbability: 'Roll probability',
  wiContent: 'Content',
  wiContentPlaceholder: 'What this entry means to the AI, sent verbatim',
  wiContentLength: '{count} chars',
  wiTitle: 'Title / memo',
  wiTitlePlaceholder: 'Shown here only; never reaches the prompt',
  wiEnabled: 'Enabled',
  wiAddMemo: 'Show memo',
  wiIgnoreBudget: 'Ignore budget',
  wiExcludeRecursion: 'Non-recursable',
  wiExcludeRecursionNote: 'Other entries cannot activate this one during a recursive pass.',
  wiPreventRecursion: 'Prevent further recursion',
  wiPreventRecursionNote: 'This entry’s own content cannot activate further entries.',
  wiDelayUntilRecursion: 'Delay until recursion (level)',
  wiDelayUntilRecursionNote: 'Held back until the scan reaches this recursion level; empty fires immediately.',
  wiTimedEffects: 'Timed effects',
  wiSticky: 'Sticky',
  wiStickyNote: 'Stays active for N messages after firing.',
  wiCooldown: 'Cooldown',
  wiCooldownNote: 'Cannot re-fire for N messages after firing.',
  wiDelay: 'Delay',
  wiDelayNote: 'Cannot fire until the chat has N messages.',
  wiGroup: 'Inclusion group',
  wiGroupPlaceholder: 'One entry per label survives a scan',
  wiGroupWeight: 'Group weight',
  wiGroupOverride: 'Prioritize',
  wiOverrides: 'Per-entry overrides',
  wiScanDepthOverride: 'Scan depth override',
  wiAutomationId: 'Automation ID',
  wiAutomationIdPlaceholder: '(none)',
  wiOutletName: 'Outlet name',
  wiOutletNamePlaceholder: 'Rendered where {{outlet::name}} is asked for',
  wiCaseSensitiveOverride: 'Case-sensitive',
  wiWholeWordsOverride: 'Whole words',
  wiGroupScoringOverride: 'Group scoring',
  wiOverrideGlobal: 'Use global',
  wiOverrideYes: 'Yes',
  wiOverrideNo: 'No',
  wiNumUnset: 'off',
  wiTriggers: 'Generation triggers',
  wiTriggersNote: 'Empty means the entry may fire on any generation type.',
  wiTrigger_normal: 'Normal',
  wiTrigger_continue: 'Continue',
  wiTrigger_impersonate: 'Impersonate',
  wiTrigger_swipe: 'Swipe',
  wiTrigger_regenerate: 'Regenerate',
  wiTrigger_quiet: 'Quiet',
  wiFilterNames: 'Filter: character names',
  wiFilterTags: 'Filter: character tags',
  wiFilterListPlaceholder: 'Comma separated',
  wiFilterExclude: 'Exclude',
  wiFilterExcludeNote: 'Reverses the filter: the listed characters and tags are the ones this entry is hidden from.',
  wiMatchSources: 'Additional matching sources',
  wiMatch_matchCharacterDescription: 'Character description',
  wiMatch_matchCharacterPersonality: 'Character personality',
  wiMatch_matchScenario: 'Scenario',
  wiMatch_matchPersonaDescription: 'Persona description',
  wiMatch_matchCharacterDepthPrompt: 'Character’s note',
  wiMatch_matchCreatorNotes: 'Creator’s notes',
  wiSort_priority: 'Priority',
  wiSort_custom: 'Custom',
  wiSort_title_asc: 'Title A-Z',
  wiSort_title_desc: 'Title Z-A',
  wiSort_tokens_asc: 'Tokens ↗',
  wiSort_tokens_desc: 'Tokens ↘',
  wiSort_depth_asc: 'Depth ↗',
  wiSort_depth_desc: 'Depth ↘',
  wiSort_order_asc: 'Order ↗',
  wiSort_order_desc: 'Order ↘',
  wiSort_uid_asc: 'UID ↗',
  wiSort_uid_desc: 'UID ↘',
  wiSort_probability_asc: 'Trigger% ↗',
  wiSort_probability_desc: 'Trigger% ↘',
  wiSort_search: 'Search relevance',

  /** Persona panel. Position words are upstream's own (`parsePersonaPosition`). */
  sectionPersona: 'User persona',
  personasNotLoaded: 'Personas have not loaded.',
  personasEmpty: 'No personas yet. Write one and the model is told who you are.',
  personaActiveNote: 'Tap a persona to make it the one in play.',
  personaNew: 'New persona',
  personaEditing: 'Editing “{name}”',
  personaName: 'Name',
  personaNamePlaceholder: 'what you are called',
  personaDescription: 'Description',
  personaDescriptionNote: 'What the model is told about you. It also joins the world-info scan, whatever the position below says.',
  personaPosition: 'Position',
  positionInprompt: 'In prompt',
  positionAtdepth: 'At depth',
  positionNone: 'Not in prompt',
  personaDepth: 'Depth (messages from the end)',
  personaRole: 'Role',
  personaSave: 'Save persona',
  personaDelete: 'Delete',
  provider: 'Provider',
  model: 'Model',
  modelPlaceholder: 'e.g. local/qwen3-8b',
  temperature: 'Temperature',
  temperatureNote: 'How far the model strays from its likeliest next word.',
  replyLengthCap: 'Reply length cap',
  replyLengthCapNote: 'Tokens, not words. A long scene needs a high cap.',
  topP: 'Top-p',
  topPNote: 'Keeps only the likeliest words that add up to this much probability.',
  repetitionPenalty: 'Repetition penalty',
  repetitionPenaltyNote: 'Raise it when the model starts repeating a phrase.',
  fewerParameters: 'Fewer parameters',
  moreParameters: 'More parameters',
  topK: 'Top-k',
  minP: 'Min-p',
  frequencyPenalty: 'Frequency penalty',
  presencePenalty: 'Presence penalty',
  seed: 'Seed',
  seedNote: 'Fix it to make a regenerate reproducible.',
  stopAt: 'Stop at',
  stopPlaceholder: 'separate with |',
  trimSentences: 'Trim incomplete sentences',
  trimSentencesNote: 'Cut a finished reply back to its last complete sentence, before it is stored.',
  continuePostfix: 'Continue separator',
  continuePostfixNote: 'What joins a continued reply to the text it writes on — sent to the model, and part of what paints while it streams.',
  postfixNone: 'nothing',
  postfixSpace: 'a space',
  postfixNewline: 'a newline',
  postfixDouble: 'a blank line',
  squashSystemMessages: 'Merge adjacent injections',
  squashSystemMessagesNote: 'Send consecutive system-placed injections as one message instead of several.',
  showFloorNumbers: 'Show floor numbers',
  showFloorNumbersNote: 'Number each message in the margin, as the chat search’s floor references do.',
  autoOpenChat: 'Open the most recent conversation on start',
  autoOpenChatNote: 'Turn this off to land on the library instead of the last read.',
  exportSettings: 'Export settings (JSON)',
  importSettings: 'Import settings',
  settingsExported: 'Exported "{name}".',
  settingsImportBadJson: 'That file is not valid JSON — nothing was applied.',
  settingsImportBadFormat: 'That file is not an Iris settings export — nothing was applied.',
  settingsImportedDevice: 'Restored the device choices (theme, reading, language, startup).',
  settingsImportedGeneration: 'Restored the generation settings.',
  settingsImportedWorldbook: 'Restored the world books ({count} selected).',
  settingsImportedConnections: 'Added {count} connection profiles — without keys; type each key again.',
  settingsTransferNote: 'The file carries the generation and world-book settings, the connection profiles (never their keys), and this device’s choices.',
  credentialHead: 'Credentials',
  credentialBody: 'API keys live in connection profiles on the host, and no RPC ever returns one: this interface only ever learns whether a key exists and, at most, its last four characters. A typed key is kept by this page no longer than it takes to save it.',
  credentialBodyTransport: 'Requests to the provider are sent by the host; this page never holds a credential nor talks to the endpoint itself. The transport boundary is pinned by the host’s rpc-transport tests.',
  theme: 'Theme',
  themeSystem: 'System',
  /* The three built-ins' names, 「梅花」. The **ids** stay `light`/`dark`/
     `parchment` — they are what readers have in `localStorage`, and renaming
     them would silently reset every stored choice (`theme/presets.ts`). 宣 is
     宣纸, the paper; it has no one-word English name, so it keeps the
     transliteration rather than being flattened back to "Parchment". */
  themeLight: 'Snow',
  themeDark: 'Ink',
  themeParchment: 'Xuan paper',

  /** Appearance card — themes as swatches, the user.css slot, the theme package. */
  sectionAppearance: 'Appearance',
  appearanceUserCssOn: 'user.css on',
  appearanceUserCssOff: 'user.css off',
  appearanceThemes: 'Built-in themes',
  appearanceThemesNote: 'A theme is a palette of Iris tokens. Picking one repaints the page on the spot.',
  appearanceThemeAria: 'Use the {name} theme',
  appearanceFollowSystem: 'Follow the system theme',
  appearanceFollowSystemNote: 'On: the OS answers, and keeps answering if it changes. Off: the last theme it named stays.',
  overridesInForce: 'Custom token overrides',
  overridesNote: 'A theme package left colours that differ from the built-ins; they sit on top of whichever theme is chosen.',
  overridesClear: 'Clear overrides',
  overridesCleared: 'Cleared the custom token overrides.',
  userCss: 'Custom CSS (user.css)',
  userCssNote: 'Runs after the theme, on this page only — a card frame is its own document and is not reached.',
  userCssEditorLabel: 'Stylesheet',
  userCssPlaceholder: '/* Write CSS here — every Iris colour is a --iris-* token. */',
  userCssImport: 'Import .css',
  userCssImported: 'Imported "{name}" and switched it on.',
  userCssTooLong: 'That stylesheet is over 512 KiB — nothing was applied.',
  themeExport: 'Export theme (JSON)',
  themeImport: 'Import theme',
  themeExported: 'Exported "{name}".',
  themeImportBadJson: 'That file is not valid JSON — nothing was applied.',
  themeImportBadFormat: 'That file is not an Iris theme package — nothing was applied.',
  themeImported: 'Restored the theme package (palette and user.css).',
  themeTransferNote: 'The file carries the theme’s full token palette and this device’s user.css.',
  proseSize: 'Prose size',
  hostDefault: 'host default',
  useHostDefault: 'use host default',
  /** Option labels are proper names and stay in their own language everywhere. */
  langEn: 'English',
  langZh: '中文',

  /** Preset panel. */
  sectionPresets: 'Presets',
  presetActive: 'Active preset',
  presetUse: 'Use',
  presetExport: 'Export',
  activeBadge: 'active',
  presetImportAll: 'Import all from the SillyTavern install ({n})',
  presetImportNote: 'Importing overwrites a preset of the same name already in the library.',
  presetImportNone: 'The configured SillyTavern install has no Chat Completion presets.',
  presetImportFailed: 'the install has none with this name',
  presetSaveAs: 'Save the current state as a preset',
  presetNamePlaceholder: 'Preset name',
  presetSaved: 'Saved as “{name}”.',
  presetDeleted: 'Deleted “{name}”.',
  presetExported: 'Exported “{name}”.',
  presetDeleteNamed: 'Delete the preset {name}',
  presetImportedOne: 'Imported 1 preset.',
  presetImported: 'Imported {n} presets.',
  presetImportFiles: 'Import preset files…',
  presetFileImported: 'imported',
  presetFileOverwrote: 'imported, overwriting the preset of the same name',
  presetFileSensitive: 'carries sensitive endpoint fields: {fields}',
  presetFileInvalidJson: 'refused: the file is not valid JSON',
  presetFileNotAPreset: 'refused: not a Chat Completion preset (no "prompts" list)',
  presetFileUnusableName: 'refused: the file name yields no usable preset name',
  presetPrompts: 'Prompt manager',
  promptMoveUp: 'Move up',
  promptMoveDown: 'Move down',
  promptRemove: 'Remove {name} from the preset',
  promptMarker: 'slot',
  promptSystem: 'system',
  promptRole: 'role: {role}',
  promptNoToggle: 'This slot has no toggle.',

  /** Backup panel — the snapshots the host takes before dangerous operations. */
  sectionBackups: 'Chat backups',
  backupsSummary: '{count} snapshots',
  backupsEmpty: 'No snapshots yet. Iris copies a conversation aside before a message is deleted from it, before a card rewrites it, and before a restore — those copies list here.',
  backupReasonCleanup: 'cleanup backup',
  backupReasonDeleteMessage: 'before a deletion',
  backupReasonDeleteMessages: 'before a batch deletion',
  backupReasonImportOverwrite: 'before an import overwrite',
  backupReasonPreRestore: 'before a restore',
  backupReasonRewriteMessages: 'before a card rewrite',
  backupUnknownReason: 'snapshot',
  backupFloors: '{n} floors',
  backupPreview: 'Preview',
  backupPreviewHead: 'First {n} of {total} floors',
  backupPreviewEmpty: 'This snapshot carries no floors.',
  backupPreviewClose: 'Close the preview',
  backupRestore: 'Restore',
  backupDelete: 'Delete',
  backupDeleteAria: 'Delete the snapshot from {time}',
  backupDeleteSure: 'Really delete',
  backupRestoreTitle: 'Restore “{title}” over the current conversation?',
  backupRestoreBody: 'The conversation’s current file is replaced by the snapshot — {floors}, {size}. The current version is snapshotted first, so even this restore can be undone.',
  backupRestoreType: 'Type “{name}” to confirm.',
  backupRestoreConfirmLabel: 'Confirmation',
  backupRestoreGo: 'Restore this snapshot',
  backupRestoreCancel: 'Keep the current version',
  backupRestored: 'Restored “{title}”. The version it replaced is kept as a snapshot.',
  backupRestoredClean: 'Restored “{title}”.',
  backupDeleted: 'Snapshot deleted.',
  backupFailed: 'The host refused: {detail}',

  /** Regex panel — the global tier, the user's own scripts. */
  sectionRegex: 'Global regex',
  regexSummary: '{count} scripts',
  regexNote: 'Scripts every conversation runs before anything the character ships. Display-only ones change what you read, prompt-only ones what the model reads, the rest rewrite the message as it is stored.',
  regexEmpty: 'No global scripts. Import a regex-*.json file exported from SillyTavern to add one.',
  regexImport: 'Import a regex export',
  regexImportNote: 'Accepts one script or a bulk export array. An imported script gets a fresh identity, so importing the same file twice adds it twice.',
  regexImportFailed: 'That file is not a SillyTavern regex export.',
  regexImportedOne: 'Imported 1 script.',
  regexImported: 'Imported {n} scripts.',
  regexExport: 'Export',
  regexDeleteNamed: 'Delete the script {name}',
  regexMoveUp: 'Move up',
  regexMoveDown: 'Move down',
  regexDisplayOnly: 'display only',
  regexPromptOnly: 'prompt only',
  regexPermanent: 'rewrites stored text',

  /** Reasoning and context window (sampling section, behind “more parameters”). */
  contextWindow: 'Context window',
  contextWindowNote: 'Tokens of conversation one request may carry. Switching a preset sets it.',
  reasoningEffort: 'Reasoning effort',
  reasoningEffortNote: 'How hard a reasoning model thinks. “auto” lets the provider decide.',

  /** Connection panel. */
  host: 'Host:',
  seededNotReal: '— seeded, not a real host',
  noSavedConnections: 'No saved connections.',
  deleteNamed: 'Delete {name}',
  activateForDefaults: 'Activating a connection sets the defaults for new conversations.',
  activateForThisChat: 'Activating a connection applies it to this conversation.',
  activationImmediate: 'Switching takes effect immediately — the host needs no restart.',
  nameThisConnection: 'Name this connection',
  connectionName: 'Connection name',
  saveConnection: 'Save the current settings as a connection',

  /** Connection editor: pick a provider, point it at an endpoint, give it a key. */
  editConnection: 'Edit this connection',
  cancelEdit: 'Cancel',
  providerPreset: 'Provider',
  presetCustom: 'Custom endpoint',
  presetNoKey: 'no key needed',
  endpointBaseURL: 'Base URL',
  apiKeyLabel: 'API key',
  apiKeyPlaceholder: 'Paste your key…',
  /** Shown in the key field once a key is stored — most providers show a key once. */
  apiKeyPlaceholderKeep: 'Leave blank to keep the saved key',
  apiKeyStored: 'Saved · last four {tail}. Leave blank to keep it.',
  apiKeyStoredNoTail: 'A key is saved. Leave blank to keep it, or type to replace it.',
  /** The key is not the profile's own — it comes from the host's environment. */
  apiKeyFromHost: 'Provided by the host environment ({env}). Leave blank to use it.',
  apiKeyFromHostNoName: 'Provided by the host environment. Leave blank to use it.',
  clearKey: 'Clear the saved key',
  keyWillClear: 'The saved key will be removed when you save.',
  modelLabel: 'Model',
  modelsListLabel: 'Models this endpoint offers',
  modelsFromEndpoint: '{count} models from the endpoint.',
  /** The list is stale by construction, so it says when it was taken. */
  modelsProbedAt: '{count} models, last checked {when}.',
  /** The current value is not in the list; kept as a row so picking never loses it. */
  modelCustomCurrent: '(custom) {model}',
  refreshModels: 'Refresh the model list',
  /** No list yet: the field falls back to typing, and says why. */
  modelsNoneYet: 'No model list yet — test the connection to fetch one, or type the name.',
  modelsEndpointOffersNone: 'The endpoint answered with an empty model list. Type the name by hand.',
  /** Non-blocking: the save goes through. */
  modelNotInList: '“{model}” was not in the last model list from this endpoint. Saved anyway.',
  testConnection: 'Test connection',
  testing: 'Testing…',
  testOk: '{latency} ms · {count} models',
  testOkOne: '{latency} ms · 1 model',
  /** Which key the probe used — a pass means different things for each. */
  testKeyTyped: 'Used the key you typed.',
  testKeyStored: 'Used the saved key — you did not have to re-enter it.',
  testKeyHost: 'Used the host’s own key from its environment.',
  testKeyNone: 'Sent no key.',

  /** The connection the host process was started with: a row, not a profile. */
  hostDefaultTitle: 'Host default (read-only)',
  hostDefaultNote: 'What this host was started with. It generates through this until you activate a connection.',
  hostDefaultKeyEnv: 'Key from the environment variable {env}',
  hostDefaultKeyAnon: 'Key from the host’s environment',
  hostDefaultNoKey: 'No key configured',
  hostDefaultEndpointRidden: 'the host’s configured endpoint',
  adoptHostConnection: 'Save as a connection',
  hostAdopted: 'Saved as a connection. The host copied its own key across — the browser never saw it.',
  testErrMissingKey: 'This endpoint needs an API key — paste one above, then test again.',
  testErrUnauthorized: 'The endpoint refused the key (401/403). Check it and try again.',
  testErrTimeout: 'The endpoint did not answer in time. Is the address right, and is it up?',
  testErrNetwork: 'Could not reach the endpoint. Check the address and the network.',
  testErrHttp: 'The endpoint answered with an error.',
  testErrBadResponse: 'The endpoint answered, but not with a model list. You can still type the model name.',
  testErrNoEndpoint: 'This profile rides the host’s configured endpoint and carries none of its own.',
  testRefused: 'The test did not run: {message}',
  saveThisConnection: 'Save this connection',
  updateConnection: 'Update this connection',
  savedTakesEffect: 'Saved. Select the connection below to apply it — it takes effect immediately, no restart.',

  /** Script panel. */
  sectionCardScripts: 'Card scripts',
  readingCard: 'Reading the card…',
  cardNoScripts: 'This card ships no scripts.',
  declinedSummary: 'Not running. You declined this card’s scripts — turn them on below if you change your mind.',
  allowScripts: 'Allow scripts',
  runThem: 'Run them',
  dontRunThem: 'Don’t run them',
  withdrawn: '· withdrawn — it arrived after all',
  fromEarlierRun: '· from an earlier run',
  pageAccess: 'Page access',
  granted: 'granted',
  off: 'off',
  grantedNote: 'This card can read and change anything on screen, including your other conversations. It stays this way until you turn it off.',
  offNote: 'This card’s scripts can only touch their own panel. They cannot read your other conversations.',
  onlyYouNote: 'Only you can turn this on. A card has no way to ask — if one tells you to enable something, that text came from the card.',
  turnOffPageAccess: 'Turn off page access',
  givePageAccess: 'Give this card page access…',
  grantDialogTitle: 'Let this card read and change the whole page?',
  grantDialogBody: 'Its scripts will be able to read and alter anything on screen — your other conversations, the text you are typing, your settings. Iris cannot limit what it does once this is on, and it stays on until you turn it off. Turn it on only for a card you trust and have a reason to.',
  grantDialogAck: 'I understand this card will be able to read my other conversations',
  grantDialogCancel: 'Keep it off',
  grantDialogConfirm: 'Grant page access',
  runsWithCard: 'Runs with this card',
  youTurnedThisOff: 'You turned this off',
  cardOffNote: 'Off in the card. Its author shipped it switched off, so Iris does not run it.',

  /** Consent question sentences (`describeConsentAsk`). */
  consentAll: 'This card runs {count} scripts ({size}).',
  consentOne: 'This card runs 1 script ({size}).',
  consentPart: '{running} of {total} scripts would run now ({size}).',
  consentCovered: 'Your answer covers all {total}, including {size} switched off today.',
  consentSandboxOne: 'It runs in an isolated sandbox and cannot read your other chats unless you also grant page access.',
  consentSandboxMany: 'They run in an isolated sandbox and cannot read your other chats unless you also grant page access.',

  /** Script run sentences (`describeRun` / `summariseRuns`). */
  runStarting: 'starting…',
  runRunning: 'running',
  runLateArrival: 'loaded, but only after {seconds}s — reported as failed before it arrived',
  runLoaded: 'loaded',
  runWaitingFor: 'waiting for {target}',
  runStillWaitingFor: 'still waiting for {target} ({seconds}s)',
  runRefused: 'refused {member}',
  runRefusedWhy: 'refused {member} — {hint}',
  runFailed: 'failed: {detail}',
  runNeverStarted: 'never started: {detail}',
  runAMember: 'a member',
  runSilent: 'started but never reported — it may still be running',
  runKilled: 'stopped when the chat closed',
  runsNone: 'No scripts are running.',
  runsFailed: '{failed} of {total} failed to run. The chat is unaffected.',
  runsWaiting: '{blocked} of {total} are waiting for {names}.',
  runsPartial: '{settled} of {total} loaded, {remaining} still starting.',
  runsAll: '{total} of {total} loaded and listening.',
  runAnotherScript: 'another script',

  /** Interface slot sentences (`describeInterface`). */
  ifaceStarting: 'starting…',
  ifaceLive: 'live ({kb} KB of markup)',
  ifaceNeverStarted: 'never started: {detail}',
  ifaceNeverStartedNoReason: 'never started: no reason given',
  ifaceClosed: 'closed with its message',
  ifaceOverBudget: 'interface not rendered — the reading view’s frame budget is spent ({kb} KB of markup)',

  /** Host reports panel. */
  hostReports: 'Host reports',
  reportsReading: 'Reading…',
  reportsRead: 'Read',
  reportsReadAgain: 'Read again',
  reportsNotRead: 'Not read yet.',
  reportsEmpty: 'The host has reported nothing.',
  reportsAllFiltered: 'Every fetched report is filtered out.',
  stackSummary: 'stack',
  reportsDroppedOne: '1 older report was dropped before the oldest shown.',
  reportsDropped: '{n} older reports were dropped before the oldest shown.',

  /** Notice log panel. */
  noticesHead: 'Notices',
  noticesEmpty: 'Nothing has been announced this session.',
  noticesDroppedOne: '1 older notice has been dropped; the last {n} are kept.',
  noticesDropped: '{n} older notices have been dropped; the last {n} are kept.',

  /** Prompt breakdown panel. */
  promptNextTitle: 'How the next request assembles',
  promptTurnTitle: 'How turn {turn} was assembled',
  counting: 'Counting…',
  promptExpired: 'The record for this turn was lost when the chat closed. This is how the request would assemble now.',
  promptMismatch: 'These parts add up to {sum}, not the reported {reported}. Treat the numbers below as unreliable.',
  promptEstimated: 'estimated',
  promptProviderCounted: 'provider counted',
  promptOfAvailable: 'of {n} available',
  promptShareAria: 'Share of the prompt by part',
  rowOrderAria: 'Row order',
  orderLargest: 'Largest first',
  orderAssembly: 'In assembly order',
  droppedToFit: '{n} earlier messages dropped to fit',
  overBudget: 'over budget',
  tokenEmpty: 'empty',

  /** Cleanup dialog. */
  cleanupTitle: '[MVU] Automatic cleanup',
  cleanupPrompt: 'Old variables can be removed from this chat to reduce its file size. Clean them now? (Creating a backup uses considerable memory; on mobile, close other background apps first or create the backup on a computer.)',
  cleanupBackupAndClean: 'Back up and clean',
  cleanupCleanOnly: 'Clean only',
  cleanupDoNotRemind: 'Do not remind me again',
  cleanupCounts: '{layers} of the messages between {from} and {to} still hold old variables ({lines} lines in the file).',
  cleanupDeferNote: 'Closing this without choosing asks again next time — it does not decline.',

  /**
   * A card's own popup (`CardPopup.tsx`).
   *
   * The six captions are upstream's own defaults, which it keeps as attributes
   * on its popup template (`[ST] public/index.html:6455`) for its i18n to
   * translate — so translating them here is what upstream does, not an
   * embellishment. Which caption a control falls back to is decided frame-side
   * in `sandbox/popup.ts`; this is only the wording.
   */
  popupCardAsks: 'A card is asking',
  popupOk: 'OK',
  popupYes: 'Yes',
  popupNo: 'No',
  popupCancel: 'Cancel',
  popupSave: 'Save',
  popupCrop: 'Crop',
  popupMarkupRefused: 'This card’s formatting was refused, so its words are shown as plain text.',

  /** Error copy (`describeError`) and the store's own notices. */
  errNotFound: 'That is not there any more. The sidebar may be out of date — reload to catch up.',
  errInvalidRequest: 'Iris would not send that.',
  errBusy: 'This chat is still generating. Stop it first.',
  errUnsupported: 'This build of Iris cannot do that yet.',
  errQuota: 'The cards’ shared storage is full. Its contents are shared across every card in this profile, so the one that ran out may not be the one that filled it.',
  errInternal: 'Something broke on the host side.',
  irisOwnFault: 'Iris hit a problem of its own: {detail}',
  cardCallFailed: 'A card’s call "{method}" failed: {detail}',
  cleanedOne: 'cleaned 1 message',
  cleanedMessages: 'cleaned {n} messages',
  backedUpTo: 'the chat was backed up to {path}',
  reportsUnreadable: 'could not read the host’s reports: {detail}',
  pageAccessGranted: 'Page access granted. It takes effect the next time the card runs.',
  pageAccessRevoked: 'Page access revoked. It stops at the next run.',

  /**
   * Token usage — the composer's session line and each reply's own reading.
   *
   * The units are the provider's, not an estimate: these numbers exist because
   * a generation was billed, which is why the words are 「用量」 and never
   * 「token 数」 (that name is taken, by the prompt panel's estimate).
   *
   * The three no-word rows below are the number formats themselves, and they
   * carry no Chinese on purpose — a grouped integer reads `12,345` in both
   * languages and a compact one `12.2K`. They are in the dictionary anyway
   * rather than hardcoded, because the separator is the first thing a third
   * language changes, and `tests/i18n.test.ts` allowlists them by key.
   */
  tokensThousand: '{value}K',
  tokensMillion: '{value}M',
  thousandsSeparator: ',',
  /** `{count}` arrives already grouped or already compacted. */
  usageCount: '{count} tok',
  /** The composer line's two groups; a group with no data drops out whole. */
  usageCacheHit: 'Cache hit {percent}%',
  usageTokens: 'Input {input} tok · Output {output} tok',
  /** The reading in a reply's action row, and the heading of its hover table. */
  usageTurn: 'Usage {total}',
  usageTurnTitle: 'Turn usage',
  /* The hover table's rows. "Uncached input" says what it says because the
     three prompt-side buckets are disjoint: what the cache served is not in
     it, and adding the two is how a reader gets the billed input. */
  usageDetailCacheHit: 'Cache hit',
  usageDetailInput: 'Uncached input',
  usageDetailCacheRead: 'Cached input',
  usageDetailCacheWrite: 'Cache write',
  usageDetailOutput: 'Output',
  /** Reasoning is part of the output it follows, not a fourth bucket beside it. */
  usageDetailReasoning: ' ({tokens} reasoning)',

  /*
   * The usage page: the whole profile's cost, cut by time and by model.
   *
   * Same wording rules as the rows above, which it extends rather than restates
   * — 「用量」 is the provider's bill and never the prompt panel's estimate, and
   * 「未缓存」 is not 「输入」 because the three prompt-side buckets are
   * disjoint. `usageCardPrompt` is the sum of all three and is the one that may
   * be called "input"; `usageCardCacheMiss` is `inputTokens` alone, which is
   * what a DeepSeek route reports as `prompt_cache_miss_tokens`.
   *
   * Two of these are caveats about the data rather than labels for it.
   * `usageUndated` says how many counted generations had their moment
   * reconstructed from their conversation's header — every record written
   * before the field existed, which is all 12 in the real corpus — and
   * `usageSkipped` says how many chat files could not be read at all. Both
   * have to read as caveats, because the figures above them otherwise look
   * like a complete total.
   */
  usageEntry: 'Usage',
  usageEntrySummary: 'Spending by model, over time',
  usageOpen: 'Open the usage page',
  usagePageTitle: 'Usage',
  usageCounting: 'Adding up every conversation…',
  usageEmpty: 'Nothing has been billed in this range.',
  /** The empty state's second line: what was looked at, so "nothing" reads as a reading rather than a failure. */
  usageScanned: '{chats} conversations scanned.',
  usageRangeAria: 'Time range',
  usageRangeToday: 'Today',
  usageRangeWeek: '7 days',
  usageRangeMonth: '30 days',
  usageRangeAll: 'All',
  usageMetricAria: 'Which figure the lines draw',
  usageMetricTotal: 'Total',
  usageMetricCacheRead: 'Cache hit',
  usageMetricCacheMiss: 'Uncached',
  usageMetricOutput: 'Output',
  /** The headline cards. `usageCardPrompt` is the three prompt buckets added; `usageCardCacheMiss` is the uncached one alone. */
  usageCardTotal: 'Total tokens',
  usageCardPrompt: 'Billed input',
  usageCardCacheRead: 'Cache hit',
  usageCardCacheMiss: 'Uncached input',
  usageCardOutput: 'Output',
  usageCardHitRate: 'Hit rate',
  usageCardTurns: 'Generations',
  /** The chart's own description, for a reader who cannot see it. */
  usageChartAria: '{metric} per time bucket, {lines} model lines',
  /** The line for records that name no model — not a model called "unknown". */
  usageUnknownModel: 'Unknown model',
  usageByChat: 'By conversation',
  usageTurnCount: '{n} generations',
  usageUndated: '{n} of {turns} generations carried no timestamp and are placed at their conversation’s last activity.',
  usageSkipped: '{n} conversation files could not be read and are not counted.',
} as const

/** The key union: every translation has to cover exactly these. */
export type StringKey = keyof typeof en

/**
 * The Chinese copy.
 *
 * Terminology is held consistent across the shell: a *reading* is 读法，a *turn*
 * is 回合，*page access* is 页面访问权，*card scripts* is 卡片脚本，*import* is
 * 导入. UI conventions follow Chinese norms (导入卡片 / 设置 / 发送).
 */
export const zh: Record<StringKey, string> = {
  /** 侧栏。 */
  sidebarAria: '对话与角色',
  tabReading: '阅读',
  tabCharacters: '角色库',
  chatsEmpty: '还没有对话。选一个角色即可开始。',
  libraryEmpty: '角色库是空的。把角色卡拖到页面任意位置即可导入。',
  importCard: '导入卡片',
  deleteConversation: '删除对话',
  removeFromLibrary: '从角色库移除',
  moreActionsFor: '{title} 的更多操作',
  noCreatorListed: '未署名作者',
  byCreator: '作者：{creator}',
  messageCount: '{count} 条消息',

  /** 侧栏内容搜索（`chat.search`）。 */
  chatSearchAria: '搜索对话内容',
  chatSearchPlaceholder: '搜索消息文本…',
  chatSearchEmpty: '没有对话包含「{query}」。',
  /** 命中楼层，按卡片脚本所见 0 起点的存储序号。 */
  chatSearchFloor: '第 {floor} 楼',
  chatSearchMore: '另有 {count} 楼命中',

  /** 聊天导入/导出——SillyTavern 迁移路径。 */
  importChats: '导入聊天（SillyTavern JSONL）',
  exportChat: '导出为 SillyTavern JSONL',
  openParentChat: '打开它分支自的对话',
  chatsImportedOne: '已导入 1 个聊天。',
  chatsImported: '已导入 {n} 个聊天。',
  chatExported: '已导出「{name}」。',

  /** 角色库——标签、收藏、排序与卡片管理。 */
  librarySearchAria: '搜索角色与标签',
  librarySearchPlaceholder: '搜索角色或标签',
  librarySearchEmpty: '没有角色匹配「{query}」。',
  sortByAria: '角色排序',
  sortByName: '名称',
  sortByUpdated: '最近',
  sortByFavorite: '收藏',
  characterPageAria: '角色',
  startNewChat: '开始新对话',
  faceConversations: '对话',
  faceNoConversations: '还没有',
  faceOneConversation: '1 个进行中',
  faceOpenCount: '{n} 个进行中',
  faceLatest: '最近 {when}',
  faceDescription: '简介',
  faceWorldbook: '世界书',
  faceBookEntries: '内嵌 {n} 条',
  faceBookEmpty: '内嵌了一本空书',
  faceScripts: '脚本',
  faceScriptCount: '{n} 个',
  faceScriptsAllowed: '你已允许它们运行',
  faceScriptsDeclined: '你已拒绝运行',
  faceCreator: '作者 {creator}',
  facePickHint: '在左边选一个角色，看它的卡片。',

  /* 角色页的三份列表：进角色页时按需拉取，不随角色库下发。 */
  faceOpenConversation: '打开「{title}」',
  faceBookFigures: '{n} 条 · {enabled} 启用 · {constant} 常驻',
  faceBookNoEntries: '这本书是空的',
  faceBookEmbedded: '在卡里，还没落成文件',
  faceBookMinted: '本机改过名',
  faceBookMissing: '已绑定，但本机没有这本书',
  faceBookExtra: '你自己绑上的',
  faceEntryConstant: '常驻',
  faceEntryKeys: '触发键：{keys}',
  faceEntryNoKeys: '没有触发键——永远不会触发',
  faceEntrySecondary: '另有 {n} 个副键',
  faceEntryOff: '已停用',
  facePlaceBeforeChar: '角色定义前',
  facePlaceAfterChar: '角色定义后',
  facePlaceBeforeExamples: '示例对话前',
  facePlaceAfterExamples: '示例对话后',
  facePlaceBeforeNote: '作者注前',
  facePlaceAfterNote: '作者注后',
  facePlaceAtDepth: '深度 {depth}',
  facePlaceOutlet: '插槽注入',
  faceScriptInCard: '卡内嵌',
  faceScriptOn: '启用',
  faceScriptOffByCard: '作者出厂就关着',
  faceScriptOffByYou: '你关掉了',
  faceScriptOnByYou: '你打开了',
  faceScriptButtons: '{n} 个按钮，{visible} 个可见',
  faceScriptSwitchNote: '开关在对话旁的卡片脚本面板里，这一页只报告。',
  favorite: '收藏',
  unfavorite: '取消收藏',
  duplicateCharacter: '复制角色',
  renameCharacterMenu: '重命名',
  editTags: '编辑标签',
  exportCardPng: '导出卡片 PNG',
  exportCardJson: '导出卡片 JSON',
  characterNameAria: '角色名',
  tagsInputAria: '标签（逗号分隔）',
  characterDuplicated: '已复制「{name}」。',
  characterRenamed: '已重命名为「{name}」。',
  characterExported: '已导出「{name}」。',

  /** 相对时间与大小。 */
  justNow: '刚刚',
  minutesAgo: '{n} 分钟前',
  hoursAgo: '{n} 小时前',
  daysAgo: '{n} 天前',
  sizeEmpty: '空',
  unknownSize: '大小未知',

  /** 顶栏。 */
  showConversations: '显示对话列表',
  settings: '设置',
  renameConversation: '重命名这个对话',
  conversationTitle: '对话标题',
  notStarted: '尚未开始',
  oneTurn: '1 回合',
  turns: '{n} 回合',
  writingNow: '正在写…',
  scriptsRunning: '{n} 个脚本在运行',
  seededNotice: '种子数据——本页面没有连接宿主。加上',
  seededNoticeSource: '来源：',

  /** 外壳。 */
  notConnected: '未连接到 Iris 宿主。你写下的内容不会被发送。',
  dismiss: '关闭',
  dropCard: '拖入角色卡——PNG、JPG 或 JSON——即可加入角色库。',

  /** 阅读区。 */
  openingLastChat: '正在打开你上次的对话…',
  nothingOpen: '还没有打开任何对话。',
  pickCharacterHint: '在侧栏选一个角色，开始一段对话。',
  showEarlier: '显示更早的 {n} 条',
  hiddenAbove: '上方还有 {n} 条',
  pageBlank: '这一页还是空白。',
  writeFirstLine: '写下第一句，{title} 就会回应。',

  /** 输入区。 */
  irisWriting: 'Iris 正在写…',
  writeYourPart: '写下你的部分…',
  yourMessage: '你的消息',
  promptButton: '提示词',
  composerHint: 'Enter 发送 · Shift+Enter 换行 · Alt+←/→ 切换读法',
  send: '发送',
  stop: '停止',

  /** 输入框下的模型胶囊与它打开的菜单。 */
  modelMenuOpen: '为本对话切换模型（当前 {model}）',
  modelMenuHeading: '本对话使用的模型',
  modelMenuFromConnection: '来自「{connection}」',
  /** 列表来自宿主启动时的那条连接（env 配置、还没存过 profile 时的常态）。只说变量名，不说值。 */
  modelMenuFromHost: '来自宿主默认连接',
  modelMenuFromHostEnv: '来自宿主默认连接（{keyEnv}）',
  modelRestoreConnectionDefault: '恢复连接默认（{model}）',
  /** 胶囊旁的小点：本对话没有跟随连接的模型。 */
  modelOverriddenHere: '本对话覆盖了模型',
  modelMenuNoList: '这个连接还没有模型列表。',
  modelMenuNoConnection: '没有活动连接，因此没有可选的模型列表。',
  /** 打开菜单已经去问端点要列表了，答案还没回来。 */
  modelMenuReading: '正在读取模型列表…',
  /** 回来的是「不行」。{reason} 原样转述宿主自己那句命名过的拒绝。 */
  modelMenuReadFailed: '读取模型列表失败——{reason}',

  /** 消息行。 */
  save: '保存',
  cancel: '取消',
  copy: '复制',
  edit: '编辑',
  regenerate: '重新生成',
  /** 从最新一条回复续写，结果并回原楼。 */
  continueWriting: '继续',
  /** 让模型替用户写下一条发言。 */
  speakForMe: '代我发言',
  delete: '删除',
  copied: '已复制。',
  generatingAria: '正在生成',

  /** 楼层动作菜单（`iris.message.actions`——provider 注册项折叠于此）。 */
  floorActions: '动作',
  /** 演示 provider（`DemoActionsSection`），B10 接缝的活样例。 */
  demoSection: '演示——楼层动作',
  demoProvider: '演示 provider',
  demoOn: '已装',
  demoOff: '未装',
  demoNote: '通过 iris.message.actions 接缝注册一个楼层动作（“复制为纯文本”），作为该扩展点的活样例。卸载后不留任何痕迹。',
  demoCopyPlain: '复制为纯文本',
  demoCopyPlainTitle: '复制本楼正文，不带 markdown 源码',
  copiedPlain: '已复制纯文本。',
  demoCopyFailed: '无法访问剪贴板。',

  /** 读法导轨。 */
  railReadings: '这条回复有 {count} 种读法',
  railRecord: '这条回复生成过 {count} 种读法，当前是第 {index} 种',
  railEarlier: '上一种读法',
  railLater: '下一种读法',
  railReadingOf: '第 {index} 种读法，共 {count} 种',

  /** 思维链折叠。 */
  thinking: '思考中',
  reasoningWords: '推理 · {n} 词',

  /** 消息界面槽位。 */
  renderThisOne: '渲染这一个',

  /** Body-tag scaffolding, folded away from the prose. */
  bodyLeakSummary: '正文标签外的模型脚手架',

  /** 卡片按钮栏。 */
  cardButtonsAria: '卡片脚本按钮',
  cardActionsToggle: '卡片操作（{n}）',

  /** 卡片界面收起钮。 */
  showCardUi: '显示卡片界面',
  hideCardUi: '收起卡片界面',
  showCardUiTitle: '显示卡片界面',
  hideCardUiTitle: '收起卡片界面——Iris 保持可用',

  /** 状态面板。 */
  stateAria: '对话状态',
  stateHead: '变量',
  stateCollapse: '收起变量栏',
  stateExpand: '展开变量栏',
  stateYielded: '设置面板暂时占用了这一栏——关掉它就回来',
  stateEmpty: '还没有跟踪任何内容。卡片写入变量（MVU 的 stat_data）后，会随剧情推进显示在这里。',
  booleanYes: '是',
  booleanNo: '否',
  stateSearchAria: '按名称筛选变量',
  stateSearchPlaceholder: '按名称筛选…',
  stateSearchEmpty: '没有变量名包含“{query}”。',
  stateNoChanges: '本轮没有变化。',
  stateCollapseAll: '全部折叠',
  stateExpandAll: '全部展开',
  stateOnlyChanges: '只看变化',
  stateOnlyChangesTitle: '只显示本轮变化过的条目',
  stateDiffSummaryAria: '本轮变化：新增 {added}，修改 {changed}，移除 {removed}',
  stateBadgeNew: '新',
  stateBadgeChanged: '改',
  stateRemovedHead: '本轮移除',
  stateItems: '{n} 项',
  stateSelfHealed: '已自愈',
  reconnected: '已重新连接到 Iris 宿主。',
  noticeRepeatAria: '重复 {n} 次',

  /** 设置抽屉。 */
  drawerAria: '设置',
  defaultsForNew: '新对话的默认值',
  thisConversation: '本对话',
  close: '关闭',
  settingsNotLoaded: '设置尚未加载。',
  sectionConnection: '连接',
  sectionRoute: '路由',
  sectionSampling: '采样',
  sectionReplies: '回复',
  sectionReading: '阅读',
  sectionLanguage: '语言',
  sectionAbout: '通用与关于',

  /** 折叠卡卡头摘要。 */
  noActiveConnection: '没有活动连接',
  presetNoneActive: '未启用预设',
  worldbookSummary: '已选 {count} / {total}',
  scriptSummary: '{count} 个脚本',
  samplingDefault: '宿主默认',
  samplingSet: '已设 {count} 项',
  repliesTrim: '裁剪',
  repliesSquash: '合并',
  repliesContinue: '续写：{word}',
  aboutSummary: '启动 · 备份 · 凭据',

  /** 世界书面板。 */
  sectionWorldbooks: '世界书',
  worldbooksNotLoaded: '世界书设置尚未加载。',
  worldbooksEmpty: '此安装还没有世界书。',
  worldbookGlobalSelect: '注入每个聊天',
  worldbookCharBind: '本卡的附加绑定',
  worldbookCharBindCount: '已绑定 {count} / 磁盘上 {total} 本',
  worldbookCharPrimary: '卡自带绑定：{name}',
  worldbookCharPrimaryNone: '卡未自带绑定。',
  worldbookCharNote: '附加书在下次打开聊天时参与扫描；随配置档保存，不写入卡文件。',

  worldbookThisCard: '本卡的世界书',
  worldbookCardSourceNamed: '磁盘上的一本书',
  worldbookCardSourceEmbedded: '卡内嵌，尚未写成文件',
  worldbookCardEmbeddedUnnamed: '卡自带的书，没有名字',
  worldbookCardNone: '这张卡没有世界书。',
  worldbookCardMinted: 'Iris 用自己起的名字把它写了出来，因为卡要的那个名字（{wanted}）已经被占用。',
  worldbookCardRule: '这个对话只用这张卡自己的书，再加下面全局启用的书。别的卡的书进不来。',
  worldbookCardNotLoaded: '这台宿主不保存世界书，所以说不出这张卡的书。',
  worldbookNoChat: '打开一个对话，才能看到它的卡在用哪本书。',

  worldbookGlobalHead: '对每个聊天都启用',
  worldbookGlobalCount: '已启用 {count} / 磁盘上 {total} 本',
  worldbookGlobalNone: '一本都没有——每个对话只用它自己那张卡的书。',
  worldbookGlobalExpand: '展开全部 {total} 本',
  worldbookGlobalCollapse: '收起完整列表',
  worldbookFromCard: '来自 {name} 卡',
  worldbookEntryCount: '{count} 条',
  worldbookScanDepth: '扫描深度',
  worldbookScanDepthNote: '关键词向回扫描多少条消息。',
  worldbookBudget: '令牌预算（上下文百分比）',
  worldbookBudgetNote: '世界书条目可占用的上下文份额。',
  worldbookBudgetCap: '预算上限（令牌）',
  worldbookBudgetCapNote: '绝对上限；0 表示只按百分比。',
  worldbookMinActivations: '最小激活数',
  worldbookMinActivationsNote: '不断扩窗直到激活这么多条目；0 为关闭。',
  worldbookMinActivationsDepthMax: '扩窗上限',
  worldbookMinActivationsDepthMaxNote: '最小激活最多扩到多深；0 表示到聊天末尾。',
  worldbookMaxRecursionSteps: '递归步数上限',
  worldbookMaxRecursionStepsNote: '扫描循环的硬上限；0 为不限制。',
  worldbookStrategy: '插入顺序',
  strategyEvenly: '混合排序',
  strategyCharacterFirst: '角色优先',
  strategyGlobalFirst: '全局优先',
  worldbookRecursive: '递归扫描',
  worldbookRecursiveNote: '已激活条目会再被扫描以触发更多条目。',
  worldbookCaseSensitive: '区分大小写',
  worldbookMatchWholeWords: '整词匹配',
  worldbookMatchWholeWordsNote: '关闭即子串匹配——多数社区世界书按此调校。',
  worldbookUseGroupScoring: '分组计分',
  worldbookUseGroupScoringNote: '包含组按关键词命中数而非权重抽取来决出。',
  switchOn: '开',
  switchOff: '关',

  /** 世界书条目编辑器。字段措辞对照上游编辑器与 ST 中文社区惯例。 */
  wiEditorTitle: '条目编辑器',
  wiPickBook: '选择要编辑的书…',
  wiEditorNote: '保存经宿主整书重写（worldbook.replace），条目 uid 保持不变；上方的绑定不受影响。',
  wiSaved: '已保存「{name}」。',
  wiBackupExported: '已将「{name}」备份到下载目录。',
  wiUnsavedNamed: '「{name}」有 {count} 条未保存的修改。',
  wiUnsavedTitle: '未保存的修改',
  wiUnsavedAsk: '「{name}」有 {count} 条未保存的修改。离开前要保存吗？',
  wiUnsavedSave: '保存并继续',
  wiUnsavedDiscard: '放弃修改',
  wiUnsavedResume: '继续编辑',
  wiFilterPlaceholder: '按标题、关键词或内容过滤…',
  wiFilterEmpty: '没有条目符合过滤条件。',
  wiSort: '排序',
  wiShownCount: '{shown} / {total} 条',
  wiSave: '保存',
  wiDiscard: '还原',
  wiBackup: '下载备份',
  wiClose: '关闭编辑器',
  wiExpand: '编辑「{title}」',
  wiUntitled: '（未命名 #{uid}）',
  wiBadgeOrder: '顺序 {order}',
  wiBadgeProbability: '触发率 {probability}%',
  wiBadgeDisabled: '已禁用',
  wiBadgeConstant: '常驻',
  wiBadgeChanged: '已修改',
  wiEnabledShort: '启用',
  wiKeyPlaceholder: '输入关键词，回车添加…',
  wiKeyRemove: '删除关键词「{key}」',
  wiKeysPrimary: '主关键词',
  wiKeysSecondary: '次要关键词',
  wiLogic: '逻辑',
  wiLogicNote: '次要关键词如何修饰主关键词命中：AND ANY——任一命中；AND ALL——全部命中；NOT ALL——并非全部命中；NOT ANY——全未命中。',
  wiLogicAndAny: '与任意',
  wiLogicAndAll: '与全部',
  wiLogicNotAll: '非全部',
  wiLogicNotAny: '非任意',
  wiStrategy: '状态',
  wiStrategyConstant: '🔵 常驻',
  wiStrategyNormal: '🟢 普通',
  wiStrategyVectorized: '🔗 向量化',
  wiPosition: '插入位置',
  wiPosBeforeChar: '↑角色——角色定义之前',
  wiPosAfterChar: '↓角色——角色定义之后',
  wiPosBeforeEm: '↑示例——示例消息之前',
  wiPosAfterEm: '↓示例——示例消息之后',
  wiPosBeforeAn: '↑作者注释——作者注释之前',
  wiPosAfterAn: '↓作者注释——作者注释之后',
  wiPosAtDepth: '@D——按深度注入',
  wiPosOutlet: '输出口——注入具名输出口',
  wiRole: '角色',
  wiRoleSystem: '系统',
  wiRoleUser: '用户',
  wiRoleAssistant: '助手',
  wiDepth: '深度',
  wiOrder: '顺序',
  wiProbability: '触发概率',
  wiUseProbability: '启用概率判定',
  wiContent: '内容',
  wiContentPlaceholder: '这条内容会原样发给模型',
  wiContentLength: '{count} 字',
  wiTitle: '标题 / 批注',
  wiTitlePlaceholder: '仅编辑器显示，不进入提示',
  wiEnabled: '启用',
  wiAddMemo: '显示批注',
  wiIgnoreBudget: '忽略预算',
  wiExcludeRecursion: '不可被递归激活',
  wiExcludeRecursionNote: '递归扫描时其他条目无法激活本条。',
  wiPreventRecursion: '阻止继续递归',
  wiPreventRecursionNote: '本条内容不会再去激活其他条目。',
  wiDelayUntilRecursion: '延迟至递归（层级）',
  wiDelayUntilRecursionNote: '扫描递归到该层级后才会激活；留空表示立即。',
  wiTimedEffects: '计时效果',
  wiSticky: '黏滞',
  wiStickyNote: '触发后再保持激活 N 条消息。',
  wiCooldown: '冷却',
  wiCooldownNote: '触发后 N 条消息内不能再触发。',
  wiDelay: '延迟',
  wiDelayNote: '聊天不足 N 条消息时不触发。',
  wiGroup: '包含分组',
  wiGroupPlaceholder: '同名标签一次扫描只激活一条',
  wiGroupWeight: '分组权重',
  wiGroupOverride: '优先',
  wiOverrides: '逐条覆盖',
  wiScanDepthOverride: '覆盖扫描深度',
  wiAutomationId: '自动化 ID',
  wiAutomationIdPlaceholder: '（无）',
  wiOutletName: '输出口名称',
  wiOutletNamePlaceholder: '渲染在 {{outlet::name}} 的位置',
  wiCaseSensitiveOverride: '区分大小写',
  wiWholeWordsOverride: '整词匹配',
  wiGroupScoringOverride: '分组计分',
  wiOverrideGlobal: '跟随全局',
  wiOverrideYes: '是',
  wiOverrideNo: '否',
  wiNumUnset: '关',
  wiTriggers: '生成类型过滤',
  wiTriggersNote: '留空表示可在任何生成类型下触发。',
  wiTrigger_normal: '普通',
  wiTrigger_continue: '续写',
  wiTrigger_impersonate: '代写',
  wiTrigger_swipe: '切换',
  wiTrigger_regenerate: '重新生成',
  wiTrigger_quiet: '后台',
  wiFilterNames: '限定角色名',
  wiFilterTags: '限定角色标签',
  wiFilterListPlaceholder: '逗号分隔',
  wiFilterExclude: '排除',
  wiFilterExcludeNote: '反转过滤：列出的角色与标签反而看不到本条。',
  wiMatchSources: '额外匹配来源',
  wiMatch_matchCharacterDescription: '角色描述',
  wiMatch_matchCharacterPersonality: '角色性格',
  wiMatch_matchScenario: '情景',
  wiMatch_matchPersonaDescription: '用户人格描述',
  wiMatch_matchCharacterDepthPrompt: '角色小贴士',
  wiMatch_matchCreatorNotes: '创作者注释',
  wiSort_priority: '优先级',
  wiSort_custom: '自定义',
  wiSort_title_asc: '标题 A-Z',
  wiSort_title_desc: '标题 Z-A',
  wiSort_tokens_asc: '字数 ↗',
  wiSort_tokens_desc: '字数 ↘',
  wiSort_depth_asc: '深度 ↗',
  wiSort_depth_desc: '深度 ↘',
  wiSort_order_asc: '顺序 ↗',
  wiSort_order_desc: '顺序 ↘',
  wiSort_uid_asc: 'UID 升序',
  wiSort_uid_desc: 'UID 降序',
  wiSort_probability_asc: '触发% ↗',
  wiSort_probability_desc: '触发% ↘',
  wiSort_search: '搜索相关度',

  /** 人格面板。位置词沿用上游（parsePersonaPosition）。 */
  sectionPersona: '用户人格',
  personasNotLoaded: '人格尚未加载。',
  personasEmpty: '还没有人格。写一个，让模型知道你是谁。',
  personaActiveNote: '点击人格即可切换为当前人格。',
  personaNew: '新建人格',
  personaEditing: '正在编辑「{name}」',
  personaName: '名称',
  personaNamePlaceholder: '你被如何称呼',
  personaDescription: '描述',
  personaDescriptionNote: '模型被告知的关于你的内容。无论下方位置如何，它都会参与世界书扫描。',
  personaPosition: '位置',
  positionInprompt: '提示中',
  positionAtdepth: '按深度',
  positionNone: '不进提示',
  personaDepth: '深度（距末尾消息数）',
  personaRole: '角色',
  personaSave: '保存人格',
  personaDelete: '删除',
  provider: '提供方',
  model: '模型',
  modelPlaceholder: '例如 local/qwen3-8b',
  temperature: '温度',
  temperatureNote: '模型偏离最可能的下一个词的程度。',
  replyLengthCap: '回复长度上限',
  replyLengthCapNote: '按 token 计，不是按词。长场景需要更高的上限。',
  topP: 'Top-p',
  topPNote: '只保留累计概率到此为止的最高概率词。',
  repetitionPenalty: '重复惩罚',
  repetitionPenaltyNote: '当模型开始重复某句话时调高它。',
  fewerParameters: '收起参数',
  moreParameters: '更多参数',
  topK: 'Top-k',
  minP: 'Min-p',
  frequencyPenalty: '频率惩罚',
  presencePenalty: '存在惩罚',
  seed: '种子',
  seedNote: '固定后可让重新生成可复现。',
  stopAt: '停止序列',
  stopPlaceholder: '用 | 分隔',
  trimSentences: '裁剪未完成的句子',
  trimSentencesNote: '把完成的回复裁回到最后一个完整句，然后才入库。',
  continuePostfix: '续写分隔符',
  continuePostfixNote: '把被续写的文本和模型续写的内容连起来的那一段——会发给模型，也是流式期间显示的一部分。',
  postfixNone: '不加',
  postfixSpace: '一个空格',
  postfixNewline: '一个换行',
  postfixDouble: '一个空行',
  squashSystemMessages: '合并相邻注入',
  squashSystemMessagesNote: '把连续多条系统位注入合并成一条消息发给模型。',
  showFloorNumbers: '显示楼层号',
  showFloorNumbersNote: '在页边给每条消息编号，与聊天搜索里的楼层引用一致。',
  autoOpenChat: '启动时打开最近的对话',
  autoOpenChatNote: '关掉它，启动时停在书架页而不是上次读的地方。',
  exportSettings: '导出设置（JSON）',
  importSettings: '导入设置',
  settingsExported: '已导出“{name}”。',
  settingsImportBadJson: '该文件不是合法 JSON——未应用任何内容。',
  settingsImportBadFormat: '该文件不是 Iris 设置导出文件——未应用任何内容。',
  settingsImportedDevice: '已恢复本机选择（主题、阅读、语言、启动）。',
  settingsImportedGeneration: '已恢复生成设置。',
  settingsImportedWorldbook: '已恢复世界书（选中 {count} 本）。',
  settingsImportedConnections: '已添加 {count} 个连接配置档——不含密钥，请逐个重新输入。',
  settingsTransferNote: '该文件携带生成与世界书设置、连接配置档（永不携带密钥）以及本机的选择。',
  credentialHead: '凭据',
  credentialBody: 'API 密钥只存在宿主侧的连接配置档里，任何 RPC 都不会回显：界面至多知道“是否已存密钥”和密钥末四位。你输入的密钥只在这个页面上停留到保存那一刻。',
  credentialBodyTransport: '对提供方的请求由宿主发出；本页面不持有凭据，也不直接访问端点。传输边界由宿主的 rpc-transport 测试钉住。',
  theme: '主题',
  themeSystem: '跟随系统',
  themeLight: '雪',
  themeDark: '墨',
  themeParchment: '宣',

  /** 外观卡——主题缩略块、user.css 插槽、主题包。 */
  sectionAppearance: '外观',
  appearanceUserCssOn: 'user.css 开',
  appearanceUserCssOff: 'user.css 关',
  appearanceThemes: '内置主题',
  appearanceThemesNote: '主题就是一组 Iris token 配色；选中即整页重绘，无需刷新。',
  appearanceThemeAria: '使用「{name}」主题',
  appearanceFollowSystem: '跟随系统主题',
  appearanceFollowSystemNote: '开启：由系统作答，系统变了也跟着变。关闭：停在系统最后一次说的那套。',
  overridesInForce: '自定义 token 覆盖',
  overridesNote: '某个主题包带来了与内置不同的颜色；无论选哪套主题，它们都盖在上面。',
  overridesClear: '清除覆盖',
  overridesCleared: '已清除自定义 token 覆盖。',
  userCss: '自定义 CSS（user.css）',
  userCssNote: '在主题之后生效，只作用于本页——卡片框架是独立文档，触及不到。',
  userCssEditorLabel: '样式表',
  userCssPlaceholder: '/* 在这里写 CSS——Iris 的每个颜色都是 --iris-* token。 */',
  userCssImport: '导入 .css',
  userCssImported: '已导入“{name}”并开启。',
  userCssTooLong: '该样式表超过 512 KiB——未应用。',
  themeExport: '导出主题（JSON）',
  themeImport: '导入主题',
  themeExported: '已导出“{name}”。',
  themeImportBadJson: '该文件不是合法 JSON——未应用任何内容。',
  themeImportBadFormat: '该文件不是 Iris 主题包——未应用任何内容。',
  themeImported: '已恢复主题包（配色与 user.css）。',
  themeTransferNote: '该文件携带主题的完整 token 配色表与本机的 user.css。',
  proseSize: '正文字号',
  hostDefault: '宿主默认',
  useHostDefault: '使用宿主默认',
  langEn: 'English',
  langZh: '中文',

  /** 预设面板。 */
  sectionPresets: '预设',
  presetActive: '当前预设',
  presetUse: '使用',
  presetExport: '导出',
  activeBadge: '使用中',
  presetImportAll: '从 SillyTavern 装置导入全部（{n} 个）',
  presetImportNote: '导入会覆盖库中同名的预设。',
  presetImportNone: '已配置的 SillyTavern 装置没有聊天补全预设。',
  presetImportFailed: '装置中没有同名的预设',
  presetSaveAs: '把当前状态存为预设',
  presetNamePlaceholder: '预设名称',
  presetSaved: '已保存为「{name}」。',
  presetDeleted: '已删除「{name}」。',
  presetExported: '已导出「{name}」。',
  presetDeleteNamed: '删除预设 {name}',
  presetImportedOne: '已导入 1 个预设。',
  presetImported: '已导入 {n} 个预设。',
  presetImportFiles: '导入预设文件…',
  presetFileImported: '已导入',
  presetFileOverwrote: '已导入，覆盖同名预设',
  presetFileSensitive: '携带敏感的端点字段：{fields}',
  presetFileInvalidJson: '已拒绝：文件不是有效的 JSON',
  presetFileNotAPreset: '已拒绝：不是聊天补全预设（缺少 prompts 列表）',
  presetFileUnusableName: '已拒绝：文件名得不出可用的预设名',
  presetPrompts: '提示词管理器',
  promptMoveUp: '上移',
  promptMoveDown: '下移',
  promptRemove: '从预设中移除 {name}',
  promptMarker: '槽位',
  promptSystem: '系统',
  promptRole: '角色：{role}',
  promptNoToggle: '此槽位没有开关。',

  /** 备份面板——宿主在危险操作前留下的快照。 */
  sectionBackups: '聊天备份',
  backupsSummary: '{count} 份快照',
  backupsEmpty: '还没有快照。Iris 会在删除消息、卡片改写文件和恢复之前自动把对话复制一份，那些副本会列在这里。',
  backupReasonCleanup: '清理备份',
  backupReasonDeleteMessage: '删除消息前',
  backupReasonDeleteMessages: '批量删除前',
  backupReasonImportOverwrite: '导入覆盖前',
  backupReasonPreRestore: '恢复前',
  backupReasonRewriteMessages: '卡片改写前',
  backupUnknownReason: '快照',
  backupFloors: '{n} 楼',
  backupPreview: '预览',
  backupPreviewHead: '前 {n} / 共 {total} 楼',
  backupPreviewEmpty: '这份快照没有任何楼层。',
  backupPreviewClose: '收起预览',
  backupRestore: '恢复',
  backupDelete: '删除',
  backupDeleteAria: '删除 {time} 的快照',
  backupDeleteSure: '确认删除',
  backupRestoreTitle: '用「{title}」的快照覆盖当前对话？',
  backupRestoreBody: '对话当前的文件会被这份快照整体替换——{floors}，{size}。恢复前会先把当前版本存为快照，恢复本身也可以撤销。',
  backupRestoreType: '输入「{name}」以确认。',
  backupRestoreConfirmLabel: '确认输入',
  backupRestoreGo: '恢复这份快照',
  backupRestoreCancel: '保留当前版本',
  backupRestored: '已恢复「{title}」。被替换的版本已先存为快照。',
  backupRestoredClean: '已恢复「{title}」。',
  backupDeleted: '快照已删除。',
  backupFailed: '宿主拒绝了：{detail}',

  /** 正则面板——全局层，用户自己的脚本。 */
  sectionRegex: '全局正则',
  regexSummary: '{count} 个脚本',
  regexNote: '每段对话都会先于角色自带脚本运行的正则。仅显示的改变你看到的文本，仅提示词的改变模型读到的文本，其余的直接改写存盘的消息。',
  regexEmpty: '还没有全局脚本。导入从 SillyTavern 导出的 regex-*.json 文件即可添加。',
  regexImport: '导入正则导出文件',
  regexImportNote: '接受单个脚本或批量导出的数组。导入的脚本会获得全新标识，同一文件导入两次就会添加两份。',
  regexImportFailed: '该文件不是 SillyTavern 的正则导出文件。',
  regexImportedOne: '已导入 1 个脚本。',
  regexImported: '已导入 {n} 个脚本。',
  regexExport: '导出',
  regexDeleteNamed: '删除脚本 {name}',
  regexMoveUp: '上移',
  regexMoveDown: '下移',
  regexDisplayOnly: '仅显示',
  regexPromptOnly: '仅提示词',
  regexPermanent: '改写存盘文本',

  /** 推理与上下文窗口（采样区，收在“更多参数”里）。 */
  contextWindow: '上下文窗口',
  contextWindowNote: '单个请求可携带的对话 token 数。切换预设时会随之设置。',
  reasoningEffort: '推理力度',
  reasoningEffortNote: '推理模型回答前的思考投入。“auto”由提供方自行决定。',

  /** 连接面板。 */
  host: '宿主：',
  seededNotReal: '——种子数据，不是真实宿主',
  noSavedConnections: '暂无已保存的连接。',
  deleteNamed: '删除 {name}',
  activateForDefaults: '启用一个连接会把它设为新对话的默认值。',
  activateForThisChat: '启用一个连接会把它应用到当前对话。',
  activationImmediate: '切换立即生效——无需重启宿主。',
  nameThisConnection: '为这个连接命名',
  connectionName: '连接名称',
  saveConnection: '把当前设置存为一个连接',

  /** 连接编辑表单：选提供方、填端点、给密钥。 */
  editConnection: '编辑这个连接',
  cancelEdit: '取消',
  providerPreset: '提供方',
  presetCustom: '自定义端点',
  presetNoKey: '无需密钥',
  endpointBaseURL: '端点地址',
  apiKeyLabel: 'API 密钥',
  apiKeyPlaceholder: '粘贴密钥…',
  /** 已存有密钥时的输入框提示——多数平台的密钥只显示一次。 */
  apiKeyPlaceholderKeep: '留空即沿用已保存的密钥',
  apiKeyStored: '已保存 · 末四位 {tail}。留空即沿用。',
  apiKeyStoredNoTail: '已保存密钥。留空即沿用，输入则替换。',
  /** 密钥不属于这个连接，而是宿主环境提供的。 */
  apiKeyFromHost: '由宿主环境提供（{env}）。留空即使用它。',
  apiKeyFromHostNoName: '由宿主环境提供。留空即使用它。',
  clearKey: '清除已保存的密钥',
  keyWillClear: '保存后将移除已保存的密钥。',
  modelLabel: '模型',
  modelsListLabel: '该端点提供的模型',
  modelsFromEndpoint: '来自端点的 {count} 个模型。',
  /** 列表天生会过期，所以要说清是什么时候取的。 */
  modelsProbedAt: '{count} 个模型，上次探测于{when}。',
  /** 当前值不在列表里；保留成一项，选择时就不会把它丢掉。 */
  modelCustomCurrent: '（自定义）{model}',
  refreshModels: '刷新模型列表',
  /** 还没有列表：退回文本框，并说明原因。 */
  modelsNoneYet: '还没有模型列表——测试一次连接即可获取，也可以手填。',
  modelsEndpointOffersNone: '端点返回的模型列表是空的。请手动填写模型名。',
  /** 非阻塞：保存照常完成。 */
  modelNotInList: '「{model}」不在最近一次从该端点取到的列表里。已照常保存。',
  testConnection: '测试连接',
  testing: '正在测试…',
  testOk: '{latency} 毫秒 · {count} 个模型',
  testOkOne: '{latency} 毫秒 · 1 个模型',
  /** 用的是哪把密钥——同样的“通过”，含义并不相同。 */
  testKeyTyped: '使用了你刚填的密钥。',
  testKeyStored: '使用了已保存的密钥——无需重填。',
  testKeyHost: '使用了宿主环境里的密钥。',
  testKeyNone: '没有发送密钥。',

  /** 宿主启动时所用的那条连接：它是一行只读记录，不是一个 profile。 */
  hostDefaultTitle: '宿主默认（只读）',
  hostDefaultNote: '这是宿主启动时配置的连接。在你启用某个连接之前，回复都由它生成。',
  hostDefaultKeyEnv: '密钥来自环境变量 {env}',
  hostDefaultKeyAnon: '密钥来自宿主环境',
  hostDefaultNoKey: '未配置密钥',
  hostDefaultEndpointRidden: '宿主配置的端点',
  adoptHostConnection: '存为连接',
  hostAdopted: '已存为连接。密钥由宿主自行复制，浏览器全程没有经手。',
  testErrMissingKey: '该端点需要 API 密钥——请在上方粘贴后重新测试。',
  testErrUnauthorized: '端点拒绝了这个密钥（401/403）。请检查后重试。',
  testErrTimeout: '端点未在时限内应答。地址是否正确？服务是否在运行？',
  testErrNetwork: '无法连接到端点。请检查地址与网络。',
  testErrHttp: '端点返回了错误。',
  testErrBadResponse: '端点有应答，但不是模型列表。仍可手动填写模型名。',
  testErrNoEndpoint: '这个连接使用宿主配置的端点，自身不带端点地址。',
  testRefused: '测试未能执行：{message}',
  saveThisConnection: '保存这个连接',
  updateConnection: '更新这个连接',
  savedTakesEffect: '已保存。在下方点选该连接即可启用——立即生效，无需重启宿主。',

  /** 脚本面板。 */
  sectionCardScripts: '卡片脚本',
  readingCard: '正在读取卡片…',
  cardNoScripts: '这张卡没有自带脚本。',
  declinedSummary: '未在运行。你已拒绝这张卡的脚本——如果想改主意，可在下方打开。',
  allowScripts: '允许脚本',
  runThem: '运行它们',
  dontRunThem: '不运行',
  withdrawn: '· 已撤回——它最终还是到了',
  fromEarlierRun: '· 来自上一次运行',
  pageAccess: '页面访问权',
  granted: '已授予',
  off: '关闭',
  grantedNote: '这张卡能读取并修改屏幕上的一切，包括你的其他对话。在你关闭之前一直如此。',
  offNote: '这张卡的脚本只能触达自己的面板，无法读取你的其他对话。',
  onlyYouNote: '只有你能打开它。卡片无从请求——如果有卡让你启用什么，那段文字来自卡片本身。',
  turnOffPageAccess: '关闭页面访问权',
  givePageAccess: '授予这张卡页面访问权…',
  grantDialogTitle: '让这张卡读取并修改整个页面？',
  grantDialogBody: '它的脚本将能读取并修改屏幕上的一切——你的其他对话、你正在输入的文字、你的设置。开启后 Iris 无法限制它的行为，且在你关闭之前一直有效。只对你信任且有理由信任的卡片开启。',
  grantDialogAck: '我知道这张卡将能读取我的其他对话',
  grantDialogCancel: '保持关闭',
  grantDialogConfirm: '授予页面访问权',
  runsWithCard: '随这张卡运行',
  youTurnedThisOff: '你已关闭此项',
  cardOffNote: '卡片内已关闭。作者随卡发布时即为关闭状态，因此 Iris 不运行它。',

  /** 脚本授权问句。 */
  consentAll: '这张卡运行 {count} 个脚本（{size}）。',
  consentOne: '这张卡运行 1 个脚本（{size}）。',
  consentPart: '{total} 个脚本中有 {running} 个会立即运行（{size}）。',
  consentCovered: '你的回答覆盖全部 {total} 个，包括当前关闭的 {size}。',
  consentSandboxOne: '它在隔离子沙箱中运行，除非你另外授予页面访问权，否则无法读取你的其他对话。',
  consentSandboxMany: '它们在隔离子沙箱中运行，除非你另外授予页面访问权，否则无法读取你的其他对话。',

  /** 脚本运行状态句。 */
  runStarting: '启动中…',
  runRunning: '运行中',
  runLateArrival: '已加载，但晚了 {seconds} 秒——到货前曾被误报为失败',
  runLoaded: '已加载',
  runWaitingFor: '等待 {target}',
  runStillWaitingFor: '仍在等待 {target}（{seconds} 秒）',
  runRefused: '已拒绝 {member}',
  runRefusedWhy: '已拒绝 {member}——{hint}',
  runFailed: '失败：{detail}',
  runNeverStarted: '从未启动：{detail}',
  runAMember: '某个成员',
  runSilent: '已启动但从未回报——可能仍在运行',
  runKilled: '随对话关闭而停止',
  runsNone: '没有脚本在运行。',
  runsFailed: '{total} 个中 {failed} 个运行失败。对话不受影响。',
  runsWaiting: '{total} 个中 {blocked} 个在等待 {names}。',
  runsPartial: '{total} 个中 {settled} 个已加载，{remaining} 个仍在启动。',
  runsAll: '{total} 个全部加载并开始监听。',
  runAnotherScript: '另一个脚本',

  /** 界面槽位状态句。 */
  ifaceStarting: '启动中…',
  ifaceLive: '运行中（{kb} KB 标记）',
  ifaceNeverStarted: '从未启动：{detail}',
  ifaceNeverStartedNoReason: '从未启动：没有给出原因',
  ifaceClosed: '已随消息关闭',
  ifaceOverBudget: '界面未渲染——阅读视图的帧预算已用完（{kb} KB 标记）',

  /** 宿主报告面板。 */
  hostReports: '宿主报告',
  reportsReading: '读取中…',
  reportsRead: '读取',
  reportsReadAgain: '重新读取',
  reportsNotRead: '尚未读取。',
  reportsEmpty: '宿主没有报告任何内容。',
  reportsAllFiltered: '拉取到的报告全部被过滤了。',
  stackSummary: '堆栈',
  reportsDroppedOne: '在所显示最旧记录之前，已有 1 条报告被丢弃。',
  reportsDropped: '在所显示最旧记录之前，已有 {n} 条报告被丢弃。',

  /** 通知记录面板。 */
  noticesHead: '通知',
  noticesEmpty: '本次会话没有发过任何通知。',
  noticesDroppedOne: '已有 1 条更早的通知被丢弃；只保留最后 {n} 条。',
  noticesDropped: '已有 {n} 条更早的通知被丢弃；只保留最后 {n} 条。',

  /** 提示词装配面板。 */
  promptNextTitle: '下一条请求是如何装配的',
  promptTurnTitle: '回合 {turn} 是如何装配的',
  counting: '正在统计…',
  promptExpired: '这一回合的记录随对话关闭丢失了。这是该请求现在会如何装配。',
  promptMismatch: '这些部分合计为 {sum}，与报告的 {reported} 不符。下面的数字不可尽信。',
  promptEstimated: '估计',
  promptProviderCounted: '提供方统计',
  promptOfAvailable: '占可用 {n}',
  promptShareAria: '提示词各部分占比',
  rowOrderAria: '行排序',
  orderLargest: '从大到小',
  orderAssembly: '按装配顺序',
  droppedToFit: '为装下这些，已丢弃更早的 {n} 条消息',
  overBudget: '超出预算',
  tokenEmpty: '空',

  /** 清理对话框。 */
  cleanupTitle: '[MVU] 自动清理',
  cleanupPrompt: '可以从这个对话中移除旧变量以减小文件体积。现在清理吗？（创建备份会占用较多内存；在手机上请先关闭其他后台应用，或改在电脑上创建备份。）',
  cleanupBackupAndClean: '备份并清理',
  cleanupCleanOnly: '仅清理',
  cleanupDoNotRemind: '不再提醒',
  cleanupCounts: '第 {from} 到 {to} 条消息中，有 {layers} 条仍保留旧变量（文件中共 {lines} 行）。',
  cleanupDeferNote: '不做选择直接关闭，下次还会询问——这不算拒绝。',

  /**
   * 卡片自己的弹窗（`CardPopup.tsx`）。
   *
   * 六个默认按钮文案取自上游 popup 模板上的属性（`[ST]
   * public/index.html:6455`）——上游本来就把它们交给自己的 i18n 翻译，
   * 所以这里翻译它们是照抄机制，不是加戏。哪个控件回落到哪个文案由帧侧的
   * `sandbox/popup.ts` 决定，这里只管措辞。
   */
  popupCardAsks: '卡片正在询问',
  popupOk: '确定',
  popupYes: '是',
  popupNo: '否',
  popupCancel: '取消',
  popupSave: '保存',
  popupCrop: '裁剪',
  popupMarkupRefused: '这张卡片的格式被拒绝了，因此只显示它的文字。',

  /** 错误文案与仓库自己的通知。 */
  errNotFound: '它已经不在了。侧栏可能过期了——刷新页面即可跟上。',
  errInvalidRequest: 'Iris 不会发送这个请求。',
  errBusy: '这个对话还在生成中。请先停止。',
  errUnsupported: '这一版 Iris 还做不到。',
  errQuota: '卡片的共享存储已满。它在整个配置中由所有卡片共用，所以用满的未必是正在运行的那张卡。',
  errInternal: '宿主侧出了点问题。',
  irisOwnFault: 'Iris 自身出了问题：{detail}',
  cardCallFailed: '卡片调用 "{method}" 失败：{detail}',
  cleanedOne: '已清理 1 条消息',
  cleanedMessages: '已清理 {n} 条消息',
  backedUpTo: '对话已备份到 {path}',
  reportsUnreadable: '无法读取宿主报告：{detail}',
  pageAccessGranted: '页面访问权已授予。将在卡片下次运行时生效。',
  pageAccessRevoked: '页面访问权已撤销。将在下次运行时停止。',

  /** 用量。数字格式三行不含中文，见 en 一侧的说明。 */
  tokensThousand: '{value}K',
  tokensMillion: '{value}M',
  thousandsSeparator: ',',
  usageCount: '{count} tok',
  usageCacheHit: '缓存命中 {percent}%',
  usageTokens: '输入 {input} tok · 输出 {output} tok',
  usageTurn: '用量 {total}',
  usageTurnTitle: '本轮用量',
  usageDetailCacheHit: '缓存命中',
  usageDetailInput: '未缓存输入',
  usageDetailCacheRead: '缓存读取',
  usageDetailCacheWrite: '缓存写入',
  usageDetailOutput: '输出',
  usageDetailReasoning: '（其中推理 {tokens}）',

  /** 用量页。口径见 en 一侧：「用量」只指提供方计费，「未缓存输入」不是「计费输入」。 */
  usageEntry: '用量',
  usageEntrySummary: '按模型看花费随时间的变化',
  usageOpen: '打开用量页',
  usagePageTitle: '用量',
  usageCounting: '正在合计所有对话……',
  usageEmpty: '这段时间内没有产生计费。',
  usageScanned: '已扫描 {chats} 个对话。',
  usageRangeAria: '时间范围',
  usageRangeToday: '今天',
  usageRangeWeek: '7 天',
  usageRangeMonth: '30 天',
  usageRangeAll: '全部',
  usageMetricAria: '折线画哪个指标',
  usageMetricTotal: '总量',
  usageMetricCacheRead: '缓存命中',
  usageMetricCacheMiss: '未缓存',
  usageMetricOutput: '输出',
  usageCardTotal: '总 token',
  usageCardPrompt: '计费输入',
  usageCardCacheRead: '缓存命中',
  usageCardCacheMiss: '未缓存输入',
  usageCardOutput: '输出',
  usageCardHitRate: '命中率',
  usageCardTurns: '生成次数',
  usageChartAria: '每个时间桶的{metric}，共 {lines} 条模型折线',
  usageUnknownModel: '未知模型',
  usageByChat: '按对话',
  usageTurnCount: '{n} 次生成',
  usageUndated: '{turns} 次生成中有 {n} 次没有时间戳，被记在其对话最后活动的时间上。',
  usageSkipped: '有 {n} 个对话文件读不出来，未计入。',
}

/** Both dictionaries, keyed by language. */
export const DICTIONARIES: Record<Language, Record<StringKey, string>> = { en, zh }

/**
 * Fill a template's `{name}` slots.
 *
 * Kept dumb on purpose: the only interpolation the shell needs is numbers,
 * names and sizes, and a real formatter would invite grammar machinery the
 * copy has so far avoided by being written whole.
 * @param template - the string with `{name}` slots.
 * @param params - the values to fill, keyed by slot name.
 * @returns the filled string.
 */
export function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  )
}

/**
 * Look a string up in one language. The pure core `t()` is built on.
 * @param lang - the language to read.
 * @param key - the string's key.
 * @param params - values for the string's `{slots}`, if it has any.
 * @returns the copy in the requested language.
 */
export function translate(
  lang: Language,
  key: StringKey,
  params?: Record<string, string | number>,
): string {
  const template = DICTIONARIES[lang][key] ?? en[key]
  return params === undefined ? template : interpolate(template, params)
}
