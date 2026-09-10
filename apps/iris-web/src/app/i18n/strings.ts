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
  /* The row's own count, and it is short on purpose: a 272px line already
     implies the noun, and the long spelling above still serves the character
     page, where the column is wide enough to say it. `format.ts` builds the
     whole stamp from this and `since`. */
  messageCountShort: '{count} msg',

  /* Folding the sidebar away. Two controls, one state (`Sidebar.tsx`): the
     head's collapses and the rail's brings it back, and each is only visible in
     the state whose label it carries. */
  collapseSidebar: 'Collapse the sidebar',
  expandSidebar: 'Expand the sidebar',

  /* The conversation list's two orders, offered only once a row has been
     dragged — before that the two are the same list. 「Arranged」 rather than
     「Custom」: it names what the reader did, and 「Custom」 is the word a
     settings panel uses for a value it does not understand. */
  chatOrderAria: 'Order conversations',
  chatOrderManual: 'Arranged',
  chatOrderRecent: 'Recent',

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
  /** The other two sources a script row can name, once the user has a library. */
  faceScriptGlobal: 'yours, everywhere',
  faceScriptCharacter: 'yours, this character',
  faceScriptOn: 'enabled',
  /** The two switches, said as the reason rather than as the result. */
  faceScriptOffByCard: 'the author shipped it off',
  faceScriptOffByYou: 'you switched it off',
  faceScriptOnByYou: 'you switched it on',
  /** Both numbers, always: 58 of the corpus's 89 buttons are hidden by their author. */
  faceScriptButtons: '{n} buttons, {visible} shown',
  /** The switch lives beside the conversation, not here — this page only reports. */
  faceScriptSwitchNote: 'Switch a script off in the card panel, beside the conversation it runs in.',
  faceScriptsOfYours: '{n} of these are yours, not the card’s.',
  faceAddScript: 'Write a script for this character',
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

  /**
   * The bar's 「+」 and the two acts behind it.
   *
   * `composerMore` is the button's only name — it is a 32px disc with a cross
   * in it — so it says what the list holds rather than what the mark looks
   * like.
   */
  composerMore: 'Prompt and commands',
  composerSlash: 'Slash commands',

  /** The bar's preset control and the menu behind it. */
  presetMenuHead: 'Preset in force',
  presetMenuOpen: 'Switch the preset ({preset} now)',
  /** The host refused `preset.list`: this build has no preset library at all. */
  presetLibraryAbsent: 'This host has no preset library.',
  /** It has one, and nothing is in it. */
  presetLibraryEmpty: 'No presets saved yet.',
  /**
   * The scope, said because the control beside it has the other one: a model
   * chosen in this bar moves one conversation, a preset moves the host.
   */
  presetGlobalNote: 'A preset switch applies to every conversation.',

  /** The composer's model control and the menu behind it. */
  modelMenuOpen: 'Change the model for this conversation ({model})',
  modelMenuHeading: 'Model for this conversation',
  modelMenuFromConnection: 'From {connection}',
  /*
   * `modelMenuFromHost` / `modelMenuFromHostEnv` stood here: the heading when
   * the list belonged to the host's own startup connection, which is where a
   * host configured from its environment stayed until a profile was saved. The
   * capsule has one model source now — the provider in use — because the
   * environment is not a connection (web §79).
   */
  modelRestoreConnectionDefault: 'Back to the connection’s model ({model})',
  /** The dot beside the capsule: this chat is not on the connection's model. */
  modelOverriddenHere: 'This conversation overrides the model',
  modelMenuNoList: 'No model list for this connection yet.',
  /**
   * No provider is in use — which now means nothing will generate either, so
   * this row is where a reader first meets that and has to be told where to go.
   */
  modelMenuNoConnection: 'No provider is in use. Add one under Settings → Connection, and press Use.',
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
  sectionSampling: 'Sampling',
  sectionReplies: 'Replies',
  sectionReading: 'Reading',
  sectionLanguage: 'Language',
  sectionAbout: 'General & about',

  /** Card summaries — what a folded card says in its head. */
  presetNoneActive: 'no preset active',
  worldbookSummary: '{count} of {total} selected',
  scriptSummary: '{count} scripts',
  samplingDefault: 'host defaults',
  samplingSet: '{count} set',
  repliesTrim: 'trim',
  repliesSquash: 'merge',
  /** Named only when off: this one is on by default (see `cacheFriendly`). */
  repliesCacheOff: 'cache order off',
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
  cacheFriendly: 'Cache-friendly order',
  cacheFriendlyNote: 'Send the parts that change every turn after the conversation instead of at the top, so the provider’s prefix cache keeps serving everything in front of them. On by default; turning it off restores SillyTavern’s order exactly.',
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
  regexNew: 'Write a rule',

  /**
   * The rule editor. Field labels follow SillyTavern's `editor.html`, except
   * where its name is the stored field rather than the thing being chosen:
   * "Only Format Display" becomes what it does to the chat file.
   */
  regexFieldName: 'Name',
  regexFieldFind: 'Find',
  regexFieldFindNote: 'A pattern, bare or as /pattern/flags.',
  regexFieldReplace: 'Replace with',
  regexFieldReplacePlaceholder: '{{match}} for the whole match, $1 $2 for groups, $<name> for a named group.',
  regexFieldTrim: 'Trim out',
  regexFieldTrimPlaceholder: 'One per line. Removed from each captured group before it is substituted in.',
  regexFieldAffects: 'Affects',
  regexPlaceUser: 'What you send',
  regexPlaceAi: 'What the model replies',
  regexPlaceSlash: 'Slash commands',
  regexPlaceWorldInfo: 'World book entries',
  regexPlaceReasoning: 'Reasoning blocks',
  regexFieldWhere: 'What it changes',
  regexAlterDisplay: 'What you read',
  regexAlterPrompt: 'What the model reads',
  regexEphemeralNote: 'The stored conversation is left alone.',
  regexPermanentNote: 'With neither ticked, the rule rewrites the stored conversation, and that cannot be undone.',
  regexFieldOther: 'Also',
  regexRunOnEdit: 'Run when you edit a message by hand',
  regexDisabledField: 'Switched off',
  regexFieldMacros: 'Macros in the pattern',
  regexMacroNone: 'Leave them alone',
  regexMacroRaw: 'Expand them as pattern syntax',
  regexMacroEscaped: 'Expand them as literal text',
  regexFieldMinDepth: 'From depth',
  regexFieldMaxDepth: 'To depth',
  regexDepthUnlimited: 'unlimited',
  regexDepthNote: 'Counted back from the end: 0 is the last message, 1 the one before it. Leave both blank for every message.',
  regexNameRequired: 'A rule needs a name.',
  /** What a rule would fail to do — see `regexDraftProblems` for the derivation. */
  regexProblemNoPlacement: 'Nothing is ticked under “Affects”, so this rule will never match anything.',
  regexProblemNoPattern: 'There is no pattern, so this rule will never match anything.',
  regexProblemWorldInfo: 'World book entries are only ever scanned on the way to the model, so a rule that affects them needs “What the model reads” ticked.',
  regexProblemSlash: 'Slash command text is rewritten in place, so a rule that affects it must have neither “What you read” nor “What the model reads” ticked.',

  /** The card's own regex tier — upstream's scoped scripts. */
  sectionScopedRegex: 'This character’s regex',
  scopedRegexSummary: '{running} of {count} running',
  scopedRegexRefusedSummary: '{count} rules, refused',
  scopedRegexNote: 'Rules this card ships. They run after your global ones and rewrite this conversation only. The card’s author wrote them, so they are listed here rather than edited — export one to keep your own copy.',
  scopedRegexAllowLabel: 'Let them run',
  scopedRegexAllowedNote: 'This card’s rules run in its conversations.',
  scopedRegexRefusedNote: 'None of them run. Some cards depend on their own rules to hide the bookkeeping blocks they write, so refusing may make those blocks visible.',
  scopedRegexAllow: 'Let them run',
  scopedRegexRefuse: 'Stop them running',
  scopedRegexOffByCard: 'off by the card',
  scopedRegexUnaddressable: 'no identity, cannot be switched',

  /**
   * The active preset's own regex tier — upstream's third tier, the one that
   * arrives off. `presetRegexRefusedNote` names the cost of the default in the
   * same breath as the default, because "refused" here is not a warning about
   * something broken: it is the state a fresh import is in.
   */
  sectionPresetRegex: 'This preset’s regex',
  presetRegexSummary: '{running} of {count} running',
  presetRegexRefusedSummary: '{count} rules, not enabled',
  presetRegexNote: 'Rules the preset “{name}” ships. They run after your global ones and before the card’s own, and they rewrite every conversation this preset is active in. The preset’s author wrote them, so they are listed here rather than edited — export one to keep your own copy.',
  presetRegexUnnamed: 'The preset running now is the one this host was configured with, and it has no library name — so there is nothing to put on the allow list, and its rules cannot be enabled. Save it to the preset library first.',
  presetRegexMalformed: '{n} more row(s) in this preset are not rules — no pattern, or an empty one, which would match at every position — so they are skipped.',
  presetRegexAllowLabel: 'Let them run',
  presetRegexAllowedNote: 'This preset’s rules run wherever it is active.',
  presetRegexRefusedNote: 'None of them run yet. A preset is a settings file people pass around, and some of these rules rewrite what the model is sent, not just what you read — so they stay off until you say. SillyTavern asks for the same thing: a preset only runs its regex once its name is on `preset_allowed_regex`.',
  presetRegexAllow: 'Let them run',
  presetRegexRefuse: 'Stop them running',
  presetRegexOffByPreset: 'off by the preset',
  presetRegexHeldBack: 'waiting on the switch above',

  /** The script library — the user's own scripts, TavernHelper's 脚本库. */
  sectionScriptLibrary: 'Your scripts',
  librarySummary: '{count} scripts',
  libraryNote: 'Scripts you wrote or imported. They run in the same sandbox as a card’s, under the same one-time permission for the conversation they are in, and may fetch code from the same two hosts and no others.',
  libraryGlobalHeading: 'Every conversation',
  libraryGlobalNote: 'These run wherever you are.',
  libraryCharacterHeading: 'This character only',
  libraryCharacterNote: 'These run only in this character’s conversations.',
  libraryCharacterNeedsChat: 'Open a conversation to see and add scripts for that character — or add them from the character’s own page.',
  libraryNoScripts: 'None yet.',
  libraryNew: 'Write a script',
  libraryImport: 'Import a script',
  libraryImportNote: 'Accepts one 酒馆助手 script file. An imported script arrives switched off and gets a fresh identity, so importing the same file twice adds it twice.',
  libraryImportFailed: 'That file is not a script export. A folder export cannot be imported here.',
  libraryImported: 'Imported “{name}”, switched off.',
  libraryReadFailed: 'The host would not hand over “{name}”.',
  libraryDeleteNamed: 'Delete the script {name}',
  libraryButtonCount: '{n} buttons, {visible} shown',

  /** The script editor. */
  libraryFieldName: 'Name',
  libraryFieldInfo: 'Note',
  libraryFieldInfoPlaceholder: 'What it does, for when you come back to it.',
  libraryFieldContent: 'Body',
  libraryFieldContentPlaceholder: 'JavaScript. It runs in the sandbox, with the same API a card script gets.',
  libraryBodyBytes: '{n} bytes',
  libraryFieldButtons: 'Buttons',
  libraryButtonsEnabled: 'Show this script’s buttons',
  libraryButtonName: 'Button {n}, its name',
  libraryButtonVisible: 'shown',
  libraryButtonRemove: 'Remove button {n}',
  libraryAddButton: 'Add a button',
  libraryButtonsNote: 'A button appears under the conversation and fires an event your script can listen for. A hidden one still fires — scripts use them as commands they call themselves.',
  libraryNameRequired: 'A script needs a name.',
  libraryArrivesOff: 'A new script is saved switched off.',

  /** Reasoning and context window (sampling section, behind “more parameters”). */
  contextWindow: 'Context window',
  contextWindowNote: 'Tokens of conversation one request may carry. Switching a preset sets it.',
  contextUnlocked: 'Unlock the window',
  contextUnlockedNote: 'Off, the window above is capped at what the model is known to accept. On, the number stands as written — SillyTavern’s “unlocked context size”.',
  reasoningEffort: 'Reasoning effort',
  reasoningEffortNote: 'How hard a reasoning model thinks. “auto” lets the provider decide.',

  /** Connection panel: a provider list, an add button, and a test. */
  host: 'Host:',
  seededNotReal: '— seeded, not a real host',
  /**
   * The empty state, which is now the *only* thing a host with no providers
   * shows: the environment is not a row any more, so there is nothing else on
   * screen to explain why nothing generates.
   */
  noSavedConnections: 'No providers yet — add one to generate.',
  deleteNamed: 'Delete {name}',
  activationImmediate: 'Switching takes effect immediately — the host needs no restart.',
  /** The panel's one block heading; the other two blocks are a button each. */
  connBlockProviders: 'Providers',
  connAddProvider: 'Add a provider',
  /** Row markers and row actions. Saving a provider and using one are two acts. */
  connCurrent: 'current',
  connUse: 'Use',
  connUseNamed: 'Use {name}',
  connEditNamed: 'Edit {name}',
  connTestNamed: 'Test {name}',
  /** What a row says about its key — a state, never a credential. */
  connKeySaved: 'key ****{tail}',
  connKeySavedNoTail: 'key saved',
  /**
   * The profile has no key of its own, and the host's environment holds one for
   * this very origin — so it generates and probes anyway (host §58's ladder).
   * A fallback, not a route: nothing generates *through* the environment.
   */
  connKeyFromHost: 'key from the host environment',
  connKeyNone: 'no key',
  /** Display-only extras a row carries when anything already knows them. */
  connModelWindow: 'window {tokens}',
  connProbedAt: '{count} models · checked {when}',
  /**
   * The distinction the panel is arranged around — CC Switch's, and the user's
   * own words: the list is the saved providers, and "use" is which one generates.
   */
  connSaveVsUse: 'Saving a provider and using one are two things: saving writes it into this host’s provider list, using only decides which one generates.',
  connUseNote: 'Using a provider is a global switch — new conversations, and every conversation with no model of its own. To move one conversation only, press the model name under the composer.',
  /** Test: the third block, and the row action that reports into it. */
  connTestCurrent: 'Test the current provider',
  connTestedRow: 'Tested {name}.',
  /** Said after a save or a delete, about where the list now stands. */
  connSavedNote: 'Saved. It is in the list above — press Use to generate through it.',
  connSavedCurrent: 'Saved, and re-applied: this is the provider in use.',
  connDeleted: 'Deleted.',
  connDeletedWasCurrent: 'Deleted. No provider is selected now, so nothing will generate until you press Use on one.',

  /** Connection editor: pick a provider, point it at an endpoint, give it a key. */
  connEditorEditTitle: 'Edit provider',
  connProviderName: 'Name',
  connProviderNamePlaceholder: 'What you call it',
  connBoundPreset: 'Bound preset',
  connBoundPresetNone: 'No preset',
  connBoundPresetNote: 'Using this provider also switches to this preset.',
  connPresetsUnknown: 'The preset library has not been read — type the name.',
  editConnection: 'Edit',
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
  modelsFromEndpoint: '{count} models from the endpoint.',
  /** The list is stale by construction, so it says when it was taken. */
  modelsProbedAt: '{count} models, last checked {when}.',
  /** The current value is not in the list; kept as a row so picking never loses it. */
  modelCustomCurrent: '(custom) {model}',
  /**
   * The last row of the model dropdown, which turns it back into a field.
   *
   * The user's ruling, 2026-09-10: 「模型要支持添加自定义名称的模型，以防止用户无法
   * 使用到还在内测的模型」. A `/models` list is what the endpoint chooses to
   * advertise, and a model in closed testing is exactly the one it does not —
   * measured on `deepseek-v4.1-flash-expires-on-0910`, which generates and is
   * not listed. So the list is a shortcut, never a gate.
   */
  modelCustomOption: 'Custom…',
  modelCustomTyped: 'Type the model id, exactly as the provider spells it — a model in closed testing will not be in the list above.',
  modelCustomPlaceholder: 'e.g. deepseek-v4.1-flash-expires-on-0910',
  /** The way back out of the typed field, while a list exists to go back to. */
  modelFromList: 'Pick from the list',
  refreshModels: 'Refresh the model list',
  /** No list yet: the field falls back to typing, and says why. */
  modelsNoneYet: 'No model list yet — test the connection to fetch one, or type the name.',
  modelsEndpointOffersNone: 'The endpoint answered with an empty model list. Type the name by hand.',
  /** Non-blocking: the save goes through. */
  modelNotInList: '“{model}” was not in the last model list from this endpoint. Saved anyway.',
  /** The same disagreement, marked in the editor while it can still be changed. */
  modelOffListNote: 'Not in this endpoint’s list.',
  testConnection: 'Test connection',
  testing: 'Testing…',
  testOk: '{latency} ms · {count} models',
  testOkOne: '{latency} ms · 1 model',
  /** Which key the probe used — a pass means different things for each. */
  testKeyTyped: 'Used the key you typed.',
  testKeyStored: 'Used the saved key — you did not have to re-enter it.',
  testKeyHost: 'Used the host’s own key from its environment.',

  /**
   * A profile with no endpoint of its own rides the route the composition
   * registered. The one surviving 「宿主」 word in the panel, and it describes a
   * *profile's* endpoint field being empty — not a row of its own.
   */
  hostDefaultEndpointRidden: 'the host’s configured endpoint',
  /** The collapsed head, and the empty list's own heading, when nothing is in use. */
  connNoneSelected: 'no provider selected',
  testErrMissingKey: 'This endpoint needs an API key — paste one above, then test again.',
  testErrUnauthorized: 'The endpoint refused the key (401/403). Check it and try again.',
  testErrTimeout: 'The endpoint did not answer in time. Is the address right, and is it up?',
  testErrNetwork: 'Could not reach the endpoint. Check the address and the network.',
  testErrBadUrl: 'The address is not a URL a request can be sent to. It needs to start with https:// (or http://) and hold no full-width or stray characters.',
  testErrBadKey: 'The key holds a character a request header cannot carry — usually a full-width or non-Latin character that slipped in while pasting. Re-paste it.',
  testErrHttp: 'The endpoint answered with an error.',
  testErrBadResponse: 'The endpoint answered, but not with a model list. You can still type the model name.',
  testErrNoEndpoint: 'This profile rides the host’s configured endpoint and carries none of its own.',
  testRefused: 'The test did not run: {message}',
  saveThisConnection: 'Save this provider',
  updateConnection: 'Save changes',

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
  /**
   * A row the cache-friendly order moved. `{n}` / `{total}` are the position it
   * holds in the preset's own order, which is where the reader put it and where
   * they will look for it.
   */
  promptDeferred: 'moved back (cache-friendly)',
  /** The other direction: a depth injection observed unchanged, pulled into the prefix. */
  promptPromoted: 'moved forward (cache-friendly)',
  promptDeferredWhere: 'was #{n} of {total}',
  promptDeferredAria: 'Moved after the conversation for the prefix cache',
  promptPromotedAria: 'Moved before the conversation for the prefix cache, because it has not changed',

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
  /**
   * The refusal a generation with no provider in use produces (host §61).
   *
   * Written here rather than passed through from the host, because the host's
   * own sentence is about routes and this one has to be a next step: which card
   * to open, and which verb to press in it. The code is what carries the
   * distinction — `provider-error` would send the reader to the endpoint.
   */
  errNoProvider: 'No provider is in use, so there is nothing to generate through. Add one under Settings → Connection, then press Use.',
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
  /** The context card's cache-hit line. */
  usageCacheHit: 'Cache hit {percent}%',
  /** The reading in a reply's action row, and the heading of its hover table. */
  usageTurn: 'Usage {total}',
  /** The same reading once the host also measured how long the reply took. The
      word 「用量」 stays, because it is what says these are provider figures and
      not the prompt panel's estimate (`STRINGS.md` §三); the speed is appended
      to it rather than replacing it. `{rate}` arrives with its own unit on it,
      the way `usageCount`'s `{count}` arrives already grouped. */
  usageTurnRate: 'Usage {total} · {rate}',
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
  /* The same table's timing rows, in the order upstream's own message-timer
     tooltip states them (`public/script.js:2681`): how long, how long to the
     first token, how long thinking. The English words are upstream's own
     ("Time to generate", "Time to first token", "Time to think") so that a
     reader who knows SillyTavern meets the same names for the same numbers.

     `usageDetailRate` is upstream's `Token rate` — the provider's output count
     over the *whole* window, queue included, which is what makes the figure
     comparable with the one SillyTavern prints. `usageDetailDecodeRate` is
     Iris's own addition and a different number: the same tokens over the time
     after the first one arrived. Two labels that could not be read as each
     other, because the two rates can differ by a factor of two on a slow first
     connection and a reader comparing hosts must know which they are holding.
     `notes/apps/iris-web/DEVIATIONS.md` §92. */
  usageDetailDuration: 'Time to generate',
  usageDetailFirstToken: 'Time to first token',
  usageDetailThinking: 'Time to think',
  usageDetailRate: 'Token rate',
  usageDetailDecodeRate: 'Decode rate',
  /** Number formats, carrying no words in either column — the same rule the
      three token formats above live under. `tests/i18n.test.ts` allowlists
      them by key. */
  usageSeconds: '{value}s',
  usageRate: '{value} tok/s',
  /** The composer strip's hover table: its heading, and the row label for the
      three prompt buckets added. The table and the strip's own line are the
      same rows (`usageSummaryRows`), so this is the line's own word `Input`
      given a key of its own — not a second word for the billed sum. */
  usageSummaryTitle: 'Session usage',
  usageSummaryInput: 'Input',

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
  /**
   * The fifth line the chart can draw: what card scripts asked for.
   *
   * A **subset** of `usageMetricTotal` rather than another cut of it — the four
   * before it partition the spend, this one says how much of the same spend was
   * a card's doing.
   */
  usageMetricScript: 'Card scripts',
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
  /*
   * The caveat line and its hint. The **short** forms are what the page shows —
   * one line of small text under the chart — and the long forms above are what
   * the hint carries, unchanged. The count stays in the short form on purpose:
   * "some of this is reconstructed" is not a reading, and the whole reason
   * these two lines exist is that a reader can tell 12 of 12 from 1 of 400.
   */
  usageUndatedShort: '{n}/{turns} undated',
  usageSkippedShort: '{n} unreadable',
  usageBasisAria: 'What these figures cover',
  /*
   * The hit-rate card's hint, on the one number here whose denominator is not
   * the card beside it — `notes/apps/iris-web/DEVIATIONS.md` 60 records the
   * confusion this sentence exists to prevent.
   */
  usageHitRateBasis: 'The share of prompt tokens the cache served, over the generations whose provider reported a cache bucket. Routes silent about caching are not in the denominator, so this is not the cache hit over the billed input beside it.',
  /*
   * The card-script share: the line under the total, its hint, and the
   * per-conversation column.
   *
   * **「其中」 / "of which" carries the whole meaning.** These generations are
   * *inside* the figure above them, not beside it — they were billed on the
   * same route to the same account — and a phrasing that read as an addition
   * would make every total on the page look understated by its own footnote.
   */
  usageScriptShare: 'of which {n} card-script requests · {tokens} tok',
  usageScriptBasis: 'Requests a card’s own script made (TavernHelper.generate / generateRaw). They are billed like a turn, produce no reply, and are counted inside every figure on this page.',
  /**
   * The subtotal list's card column. Blank, never `0`, on a conversation with
   * none. `tok` carries the unit for the same reason the line above does: a
   * bare number after a count of requests reads as a second count.
   */
  usageScriptCell: '{n} card · {tokens} tok',
  /*
   * The compaction share: the same three places, the same 「其中」 framing, and a
   * **separate sentence rather than a widened one**.
   *
   * The two shares are independently absent — a profile can run card scripts
   * and never compact, or compact and run no cards — so one sentence covering
   * both would have to be assembled from clauses at four different
   * combinations, which is a sentence in neither language. Two sentences that
   * each appear only when their own share does say the same thing and read as
   * written copy in both columns.
   *
   * 「压缩摘要」 names the request, not the feature: what was billed is one
   * summary request, and a reader who has met the 「/compact」 command already
   * has the word.
   */
  usageCompactionShare: 'of which {n} compaction summaries · {tokens} tok',
  usageCompactionBasis: 'Requests Iris itself made to fold this range’s older history into summaries. They are billed like a turn, produce no reply, and are counted inside every figure on this page.',
  /**
   * The subtotal list's compaction column, sharing the card column's cell. Same
   * blank-never-zero rule, and the same reason `tok` is spelled out.
   */
  usageCompactionCell: '{n} compaction · {tokens} tok',
  /** Nothing to draw, because this figure was never billed — not a chart of zeros. */
  usageChartEmpty: 'Nothing was billed to this figure in this range.',
  /**
   * The capacity capsule and its card (`ContextMeter.tsx`).
   *
   * **This family is 「估算」 vocabulary, not 「用量」.** Everything on the card
   * except the cache-hit line is the host's own estimate of an assembly, where
   * `usage*` above is only ever what a provider said it charged — `STRINGS.md`
   * §三 pins that distinction, and this card is the one surface where the two
   * kinds of number sit together.
   */
  contextPill: 'Context {used}/{total} · {percent}%',
  /** When nothing has ever measured this conversation: the capacity alone. */
  contextPillCapacity: 'Context {total}',
  contextPillTitle: 'What is filling the context window',
  contextCardTitle: 'Context capacity',
  contextCardFigures: '{used} / {total} · {percent}%',
  contextCardLoading: 'Working out what the next request would contain…',
  contextCardFailed: 'Could not read the breakdown — {reason}',
  contextCategoryMessages: 'Messages',
  contextCategoryWorldbook: 'World books',
  contextCategoryPreset: 'Prompt and preset',
  contextCategoryCharacter: 'Character and persona',
  contextCategoryScript: 'Script injections',
  contextCategoryOther: 'Other',
  contextRemaining: '{tokens} left',
  contextReserve: '{tokens} held back for the reply',
  /**
   * The estimated ceiling, beside the provider's own `usageCacheHit` reading.
   * Worded as an estimate — 「估算」's vocabulary, `STRINGS.md` §三 — because it
   * is: the two lines sit together and must not read as the same kind of number.
   */
  contextStablePrefix: 'Stable prefix ~{percent}% ({tokens})',
  /** Which of the two answers this is: a record of a sent request, or a preview. */
  contextFromRecord: 'Measured on turn {turn}',
  contextFromPreview: 'A preview of the next request',
  /*
   * Where the window in force came from — the line the reported case needed.
   *
   * Four, because they are four different next steps: change model or unlock,
   * change the number, reconsider a decision already made, or set one at all.
   * Each names the figure, so the sentence is readable on its own in a hover
   * where nothing else is on screen.
   */
  contextWindowFromModel: 'Window {tokens}, the limit of {model}',
  contextWindowFromSettings: 'Window {tokens}, from the settings or a preset',
  contextWindowUnlocked: 'Window {tokens}, unclamped — {model} is known to take {modelTokens}',
  contextWindowFromHost: 'Window {tokens}, the host default',

  /*
   * Where this request stopped matching the last one (`divergence.ts`).
   *
   * **This family is neither 「估算」 nor 「用量」 — it compares two requests, in
   * bytes.** Everything else on the capacity card is tokens: the host's estimate
   * or the provider's count. These are bytes, because bytes are the unit a
   * prefix cache is decided in and the only unit the comparison is exact in. So
   * the wording never says "token", and where a byte figure sits beside a
   * provider's token figure the difference is stated rather than smoothed over.
   */
  divergenceLine: 'Diverges from the last request at {percent} · in {item}',
  /** Two requests that came out byte-identical. Rare, and worth saying plainly. */
  divergenceIdentical: 'Byte-identical to the last request',
  /** No pair: the first request of a conversation, or the record is switched off. */
  divergenceNone: 'No earlier request to compare with',
  divergenceOpen: 'See which parts changed',
  /** A conversation floor, whose part id is generated rather than authored. */
  divergenceFloor: 'Floor {n}',
  /**
   * **'The newest' rather than 'this turn's'.** The panel can be opened for an
   * older turn's itemization, while a comparison is always of the two newest
   * recorded requests — a turn can have sent several, since every swipe is one.
   * Saying which pair it is stops the block being read as a statement about the
   * turn above it.
   */
  divergenceHeading: 'The newest request ({kind}) against the one before it ({previousKind})',
  divergenceCeiling: '{percent} of these bytes could have come from cache',
  divergenceServed: 'the provider served {percent}',
  divergenceUnreported: 'the provider did not report caching',
  /**
   * The finding this record exists for: the prefix matched and the cache was
   * not served anyway. Worded as an observation, because that is all it is —
   * the cause is on the provider's side and nothing here can see it.
   */
  divergenceShortfall: 'far below what the bytes allowed',
  /**
   * The conditions under which serving nothing is expected, so a reader is not
   * sent hunting for a prompt defect that is not there. DeepSeek stores a prefix
   * only after seeing it twice, entries live hours to days, a cache belongs to
   * one model, and a reply that never completed was never billed.
   */
  divergenceColdStart: 'one of this conversation’s first two requests — a prefix has to be seen twice before it is stored',
  divergenceStale: 'more than half an hour since the previous request, so the cached prefix may have expired',
  divergenceRoute: 'a different model from the previous request ({from} → {to}), and a cache belongs to one model',
  divergenceInterrupted: 'the reply never completed (the provider closed it or never answered), so no usage was reported',
  /** The four terms of the loss, which add up exactly. */
  divergenceSplit: '{total} B unservable: {added} new, {changed} rewritten, {repeated} unchanged but out of reach, {structure} framing',
  divergenceStateSame: 'unchanged',
  divergenceStateChanged: 'rewritten',
  divergenceStateAdded: 'new',
  divergenceStateGone: 'gone',
  /** A part that did not change and still could not be served. */
  divergenceStranded: 'unchanged, re-sent in full',
  divergenceBytes: '{bytes} B',
  /** The offsets are sound and their attribution to parts is not. */
  divergenceUnattributed: 'Byte offsets are exact; which part they belong to is not — {reason}',

  /*
   * The composer's command line (`commands.ts`).
   *
   * `commandRow` is the completion menu's row — its `command` slot is
   * `commandLabel`'s output, so a command that takes an argument shows the
   * placeholder (`/rename <title>`) before the reader has to guess. `commandArgHeading`
   * names the command a value list belongs to, for the reason the model menu
   * has a heading: a bare column of model ids does not say whose they are.
   * `commandUnknown` is the refusal for a name neither Iris nor the host
   * recognised, and it carries the host's own words because only the host knows
   * which of the two refused.
   */
  commandRow: '{command} — {summary}',
  commandArgHeading: 'Values for {command}',
  commandUnknown: '/{name} is not a command here — {reason}',
  commandBusy: '/{name} cannot run while a reply is arriving',
  commandNeedsArgument: '/{name} needs something after it — {usage}',
  commandHelpHeading: 'Commands:',
  commandGroupChat: 'This conversation:',
  commandGroupContext: 'Model and context:',
  commandGroupApp: 'Settings and help:',
  commandHelpUpstream: 'Anything else starting with a slash goes to the host, which runs SillyTavern’s own commands.',
  commandHelpSummary: 'List the commands this composer knows',
  commandCompactSummary: 'Fold older history into a summary to free up context',
  commandCompactDone: 'Compacted {floors} floor(s): {before} tokens of history are now a {after}-token summary.',
  commandCompactNothing: 'There is nothing left to compact — the history is already a summary plus the newest floor.',
  commandCompactFailed: 'Compaction did not run — {reason}',

  /*
   * The second batch of commands (`commands.ts`, `DEVIATIONS.md` §61).
   *
   * Three of them carry the rename the yielding rule forced: `/chat-model` is
   * SillyTavern's `/model`, `/capacity` is its `/tokens` and `/context`. The
   * copy says "this conversation" wherever the scope is the divergence worth
   * stating — an override the reader thinks is global is one they will be
   * surprised by in the next scene.
   */
  commandNewSummary: 'Start a new conversation with this character',
  commandNewDone: 'Started a new conversation.',
  commandNewNoCharacter: 'This conversation does not say which character it belongs to, so there is nothing to start a new one with.',
  commandRenameSummary: 'Retitle this conversation',
  commandRenameUsage: '<title>',
  commandRenameDone: 'This conversation is now titled “{title}”.',
  commandExportSummary: 'Save this conversation to a file',
  commandModelSummary: 'Change the model for this conversation only',
  commandModelUsage: '<name>|default',
  commandModelCurrent: 'This conversation is on {model}. Available: {models}',
  commandModelSet: 'This conversation is now on {model}. Other conversations are unchanged.',
  commandModelCleared: 'This conversation is back on its connection’s model.',
  commandModelAlreadyDefault: 'This conversation was already on its connection’s model ({model}) — there is no override to clear.',
  commandModelUnknown: '{model} is not one of the models this connection offers: {models}',
  commandCapacitySummary: 'Open the card that says how full the context window is',
  commandCapacityNoBudget: 'The host has not reported this conversation’s context window, so there is no capacity to show yet.',
  commandConfigSummary: 'Open the settings drawer',

  /* The marker at the top of a compacted conversation (`CompactionNote.tsx`). */
  compactedTitle: '{floors} earlier floor(s) are sent as a summary',
  compactedFigures: '{before} → {after}',
  compactedKept: 'Nothing was deleted: every floor is still in this conversation and in its file. What changed is what the model is sent.',
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
  messageCountShort: '{count} 条',

  collapseSidebar: '收起侧边栏',
  expandSidebar: '展开侧边栏',

  chatOrderAria: '对话排序',
  chatOrderManual: '自定义',
  chatOrderRecent: '按时间',

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
  faceScriptGlobal: '你的·全局',
  faceScriptCharacter: '你的·本角色',
  faceScriptOn: '启用',
  faceScriptOffByCard: '作者出厂就关着',
  faceScriptOffByYou: '你关掉了',
  faceScriptOnByYou: '你打开了',
  faceScriptButtons: '{n} 个按钮，{visible} 个可见',
  faceScriptSwitchNote: '开关在对话旁的卡片脚本面板里，这一页只报告。',
  faceScriptsOfYours: '其中 {n} 个是你自己的，不是卡自带的。',
  faceAddScript: '为这个角色写一个脚本',
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

  /** 底栏的「+」与它打开的两件事。按钮本身只有一个 32px 的圆和一个十字，所以名字要说清里面有什么。 */
  composerMore: '提示词与命令',
  composerSlash: '斜杠命令',

  /** 底栏的预设控件与它打开的菜单。 */
  presetMenuHead: '生效的预设',
  presetMenuOpen: '切换预设（当前 {preset}）',
  /** 宿主拒绝了 `preset.list`：这个构建根本没有预设库。 */
  presetLibraryAbsent: '这个宿主没有预设库。',
  /** 有库，里面是空的。 */
  presetLibraryEmpty: '还没有保存过预设。',
  /** 说明作用范围——旁边那个控件是另一种：模型只动这一段对话，预设动整个宿主。 */
  presetGlobalNote: '切换预设会作用于所有对话。',

  /** 输入框底栏的模型控件与它打开的菜单。 */
  modelMenuOpen: '为本对话切换模型（当前 {model}）',
  modelMenuHeading: '本对话使用的模型',
  modelMenuFromConnection: '来自「{connection}」',
  modelRestoreConnectionDefault: '恢复连接默认（{model}）',
  /** 胶囊旁的小点：本对话没有跟随连接的模型。 */
  modelOverriddenHere: '本对话覆盖了模型',
  modelMenuNoList: '这个连接还没有模型列表。',
  /** 没有在用的供应商——如今这同时意味着不会有任何生成，所以这一句要指路。 */
  modelMenuNoConnection: '没有在用的供应商。到 设置 → 连接 添加一个，然后点「使用」。',
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
  sectionSampling: '采样',
  sectionReplies: '回复',
  sectionReading: '阅读',
  sectionLanguage: '语言',
  sectionAbout: '通用与关于',

  /** 折叠卡卡头摘要。 */
  presetNoneActive: '未启用预设',
  worldbookSummary: '已选 {count} / {total}',
  scriptSummary: '{count} 个脚本',
  samplingDefault: '宿主默认',
  samplingSet: '已设 {count} 项',
  repliesTrim: '裁剪',
  repliesSquash: '合并',
  repliesCacheOff: '缓存顺序已关',
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
  cacheFriendly: '缓存友好装配',
  cacheFriendlyNote: '把每回都变的部分从提示词开头挪到对话之后再发，让服务端的前缀缓存能一直命中它前面的全部内容。默认开启；关掉后逐字节回到 SillyTavern 的顺序。',
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
  regexNew: '新建正则',

  regexFieldName: '名称',
  regexFieldFind: '查找',
  regexFieldFindNote: '正则表达式，可以直接写，也可以写成 /正则/标志。',
  regexFieldReplace: '替换为',
  regexFieldReplacePlaceholder: '{{match}} 代表整段匹配，$1 $2 代表捕获组，$<名字> 代表具名组。',
  regexFieldTrim: '剔除',
  regexFieldTrimPlaceholder: '一行一条。每个捕获组在代入之前都会先去掉这些片段。',
  regexFieldAffects: '作用于',
  regexPlaceUser: '你发出的消息',
  regexPlaceAi: '模型回复的消息',
  regexPlaceSlash: '斜杠命令',
  regexPlaceWorldInfo: '世界书条目',
  regexPlaceReasoning: '思考块',
  regexFieldWhere: '改动的是',
  regexAlterDisplay: '你读到的文本',
  regexAlterPrompt: '模型读到的文本',
  regexEphemeralNote: '存盘的对话不会被改动。',
  regexPermanentNote: '两个都不勾，规则就直接改写存盘的对话，且不可撤销。',
  regexFieldOther: '还有',
  regexRunOnEdit: '你手动编辑消息时也运行',
  regexDisabledField: '已关闭',
  regexFieldMacros: '查找式里的宏',
  regexMacroNone: '原样保留',
  regexMacroRaw: '展开，展开结果按正则语法解析',
  regexMacroEscaped: '展开，展开结果按普通文本匹配',
  regexFieldMinDepth: '从第几层起',
  regexFieldMaxDepth: '到第几层止',
  regexDepthUnlimited: '不限',
  regexDepthNote: '从结尾往前数：0 是最后一条，1 是倒数第二条。两个都留空就是每条都算。',
  regexNameRequired: '正则需要一个名称。',
  regexProblemNoPlacement: '「作用于」一个都没勾，这条规则永远不会匹配到任何东西。',
  regexProblemNoPattern: '没有查找式，这条规则永远不会匹配到任何东西。',
  regexProblemWorldInfo: '世界书条目只在送往模型的路上被扫描，所以作用于世界书的规则必须勾上「模型读到的文本」。',
  regexProblemSlash: '斜杠命令的文本是就地改写的，所以作用于它的规则「你读到的文本」和「模型读到的文本」都不能勾。',

  sectionScopedRegex: '这张卡的正则',
  scopedRegexSummary: '{count} 条，{running} 条在跑',
  scopedRegexRefusedSummary: '{count} 条，已拒绝',
  scopedRegexNote: '角色卡自带的正则。它们在你的全局正则之后运行，只改写这张卡的对话。规则是卡作者写的，所以这里只列出、不编辑——想留一份自己的，导出一条即可。',
  scopedRegexAllowLabel: '允许运行',
  scopedRegexAllowedNote: '这张卡的正则会在它的对话里运行。',
  scopedRegexRefusedNote: '一条都不会运行。有些卡靠自带正则藏掉自己写的记账块，拒绝之后那些块可能会直接显示出来。',
  scopedRegexAllow: '允许运行',
  scopedRegexRefuse: '停止运行',
  scopedRegexOffByCard: '卡作者关掉的',
  scopedRegexUnaddressable: '没有标识，无法开关',

  sectionPresetRegex: '这份预设的正则',
  presetRegexSummary: '{count} 条，{running} 条在跑',
  presetRegexRefusedSummary: '{count} 条，未启用',
  presetRegexNote: '预设「{name}」自带的正则。它们在你的全局正则之后、角色卡自带的之前运行，只要这份预设在用，每一个对话都会被改写。规则是预设作者写的，所以这里只列出、不编辑——想留一份自己的，导出一条即可。',
  presetRegexUnnamed: '当前在跑的是本机配置里指定的预设文件，它没有库内名称——白名单没有可以登记的对象，所以这些正则无法启用。先把它另存进预设库。',
  presetRegexMalformed: '这份预设里还有 {n} 条不是规则——没有查找式，或者查找式是空的（空查找式会匹配到每一个位置）——已跳过。',
  presetRegexAllowLabel: '允许运行',
  presetRegexAllowedNote: '这份预设的正则会在它生效的所有对话里运行。',
  presetRegexRefusedNote: '目前一条都不会运行。预设是一份被到处传的设置文件，而这里有些规则改写的是送给模型的文本、不只是你读到的——所以要等你点头。SillyTavern 也是同样的要求：预设名进了 `preset_allowed_regex` 白名单，它自带的正则才会跑。',
  presetRegexAllow: '允许运行',
  presetRegexRefuse: '停止运行',
  presetRegexOffByPreset: '预设作者关掉的',
  presetRegexHeldBack: '等上面那个开关',

  sectionScriptLibrary: '你的脚本',
  librarySummary: '{count} 个脚本',
  libraryNote: '你自己写的或导入的脚本。它们和卡内嵌脚本跑在同一个沙箱里，受同一个对话级授权约束，能取远程代码的域名也是同样那两个、没有别的。',
  libraryGlobalHeading: '所有对话',
  libraryGlobalNote: '不管在哪都会运行。',
  libraryCharacterHeading: '只在这个角色',
  libraryCharacterNote: '只在这个角色的对话里运行。',
  libraryCharacterNeedsChat: '打开一段对话才能查看和添加该角色的脚本——也可以在角色页里添加。',
  libraryNoScripts: '还没有。',
  libraryNew: '新建脚本',
  libraryImport: '导入脚本',
  libraryImportNote: '接受单个酒馆助手脚本文件。导入的脚本默认是关闭的，并且会获得全新标识，同一文件导入两次就会添加两份。',
  libraryImportFailed: '该文件不是脚本导出文件。文件夹导出无法在这里导入。',
  libraryImported: '已导入「{name}」，默认关闭。',
  libraryReadFailed: '宿主拒绝交出「{name}」。',
  libraryDeleteNamed: '删除脚本 {name}',
  libraryButtonCount: '{n} 个按钮，显示 {visible} 个',

  libraryFieldName: '名称',
  libraryFieldInfo: '备注',
  libraryFieldInfoPlaceholder: '它做什么用的，方便你以后回来看。',
  libraryFieldContent: '内容',
  libraryFieldContentPlaceholder: 'JavaScript。在沙箱里运行，可用的接口和卡内嵌脚本完全一样。',
  libraryBodyBytes: '{n} 字节',
  libraryFieldButtons: '按钮',
  libraryButtonsEnabled: '显示这个脚本的按钮',
  libraryButtonName: '第 {n} 个按钮的名字',
  libraryButtonVisible: '显示',
  libraryButtonRemove: '删除第 {n} 个按钮',
  libraryAddButton: '添加按钮',
  libraryButtonsNote: '按钮会出现在对话下方，按下时发出一个事件供你的脚本监听。隐藏的按钮同样能发出事件——脚本常把它们当成自己调用的命令。',
  libraryNameRequired: '脚本需要一个名称。',
  libraryArrivesOff: '新建的脚本保存后默认是关闭的。',

  /** 推理与上下文窗口（采样区，收在“更多参数”里）。 */
  contextWindow: '上下文窗口',
  contextWindowNote: '单个请求可携带的对话 token 数。切换预设时会随之设置。',
  contextUnlocked: '解锁窗口上限',
  contextUnlockedNote: '关闭时，上面的窗口会被夹到「模型已知能接受的长度」。打开后按写的数值用 —— 对应 SillyTavern 的「解锁上下文长度」。',
  reasoningEffort: '推理力度',
  reasoningEffortNote: '推理模型回答前的思考投入。“auto”由提供方自行决定。',

  /** 连接面板：一份供应商列表、一个添加按钮、一次测试。 */
  host: '宿主：',
  seededNotReal: '——种子数据，不是真实宿主',
  /** 空态——如今宿主环境不再是一行，没有供应商时屏幕上就只剩这一句。 */
  noSavedConnections: '还没有供应商——添加一个来调用模型。',
  deleteNamed: '删除 {name}',
  activationImmediate: '切换立即生效——无需重启宿主。',
  /** 面板里唯一的分区标题；另外两块各自就是一个按钮。 */
  connBlockProviders: '供应商',
  connAddProvider: '添加供应商',
  /** 行上的标记与操作。保存供应商与使用供应商是两个动作。 */
  connCurrent: '当前',
  connUse: '使用',
  connUseNamed: '使用 {name}',
  connEditNamed: '编辑 {name}',
  connTestNamed: '测试 {name}',
  /** 一行对密钥的说法——只说状态，绝不带密钥本身。 */
  connKeySaved: '密钥 ****{tail}',
  connKeySavedNoTail: '已保存密钥',
  /** 这个供应商自己没有密钥，而宿主环境正好持有同源的一把（host §58 的兜底阶梯）。 */
  connKeyFromHost: '密钥由宿主环境提供',
  connKeyNone: '无密钥',
  /** 已经知道的额外展示信息，只展示，不影响判断。 */
  connModelWindow: '窗口 {tokens}',
  connProbedAt: '{count} 个模型 · 探测于{when}',
  /**
   * 整个面板围绕的那条区分——CC Switch 的做法，也是用户自己的原话：
   * 列表是「保存下来的供应商」，「使用」才是「由哪一个生成」。
   */
  connSaveVsUse: '保存供应商和使用供应商是两件事：保存是把它写进这台宿主的供应商列表，使用只决定当前由哪一个生成。',
  connUseNote: '「使用」是全局切换——影响新对话，以及所有没有自己模型的对话。只想改一个对话，请点输入框下方的模型名。',
  /** 测试：第三块，行上的测试按钮把结论报到这里。 */
  connTestCurrent: '测试当前供应商',
  connTestedRow: '测试的是「{name}」。',
  /** 保存或删除之后，说清列表现在的状态。 */
  connSavedNote: '已保存。它已在上方列表里——点「使用」才会由它生成。',
  connSavedCurrent: '已保存，并已重新应用：它就是当前在用的供应商。',
  connDeleted: '已删除。',
  connDeletedWasCurrent: '已删除。现在没有在用的供应商，在某一行点「使用」之前不会有任何生成。',

  /** 连接编辑表单：选提供方、填端点、给密钥。 */
  connEditorEditTitle: '编辑供应商',
  connProviderName: '名字',
  connProviderNamePlaceholder: '你怎么称呼它',
  connBoundPreset: '绑定预设',
  connBoundPresetNone: '不绑定预设',
  connBoundPresetNote: '使用这个供应商时会同时切到这个预设。',
  connPresetsUnknown: '还没读到预设库——请手填名称。',
  editConnection: '编辑',
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
  modelsFromEndpoint: '来自端点的 {count} 个模型。',
  /** 列表天生会过期，所以要说清是什么时候取的。 */
  modelsProbedAt: '{count} 个模型，上次探测于{when}。',
  /** 当前值不在列表里；保留成一项，选择时就不会把它丢掉。 */
  modelCustomCurrent: '（自定义）{model}',
  /**
   * 下拉框最后固定的一项，选中后它就变回一个输入框。
   *
   * 用户裁定 2026-09-10：「模型要支持添加自定义名称的模型，以防止用户无法使用到还在
   * 内测的模型」。`/models` 给出的是端点愿意公开的那些，而内测中的模型恰恰不在其中
   * ——`deepseek-v4.1-flash-expires-on-0910` 就是量到的例子：能生成，不在列表里。
   * 所以列表是捷径，不是关卡。
   */
  modelCustomOption: '自定义…',
  modelCustomTyped: '按供应商的写法手填模型 id——内测中的模型不会出现在上面的列表里。',
  modelCustomPlaceholder: '例如 deepseek-v4.1-flash-expires-on-0910',
  /** 手填状态下退回列表的出口，只在确实有列表可退时出现。 */
  modelFromList: '从列表选择',
  refreshModels: '刷新模型列表',
  /** 还没有列表：退回文本框，并说明原因。 */
  modelsNoneYet: '还没有模型列表——测试一次连接即可获取，也可以手填。',
  modelsEndpointOffersNone: '端点返回的模型列表是空的。请手动填写模型名。',
  /** 非阻塞：保存照常完成。 */
  modelNotInList: '「{model}」不在最近一次从该端点取到的列表里。已照常保存。',
  /** 同一处不一致，趁还能改的时候在编辑器里标出来。 */
  modelOffListNote: '不在这个端点的列表里。',
  testConnection: '测试连接',
  testing: '正在测试…',
  testOk: '{latency} 毫秒 · {count} 个模型',
  testOkOne: '{latency} 毫秒 · 1 个模型',
  /** 用的是哪把密钥——同样的“通过”，含义并不相同。 */
  testKeyTyped: '使用了你刚填的密钥。',
  testKeyStored: '使用了已保存的密钥——无需重填。',
  testKeyHost: '使用了宿主环境里的密钥。',

  /**
   * 一个自己没有端点的供应商，会走组合注册的那条路由。这是面板里仅剩的一个「宿主」
   * 字眼，而它说的是某个 *供应商* 的端点字段为空——不是一行自己的东西。
   */
  hostDefaultEndpointRidden: '宿主配置的端点',
  /** 没有在用的供应商时，卡头摘要与列表标题都读这一句。 */
  connNoneSelected: '未选择供应商',
  testErrMissingKey: '该端点需要 API 密钥——请在上方粘贴后重新测试。',
  testErrUnauthorized: '端点拒绝了这个密钥（401/403）。请检查后重试。',
  testErrTimeout: '端点未在时限内应答。地址是否正确？服务是否在运行？',
  testErrNetwork: '无法连接到端点。请检查地址与网络。',
  testErrBadUrl: '这个地址不是可以发送请求的 URL。需要以 https://（或 http://）开头，且不含全角字符或多余内容。',
  testErrBadKey: '密钥里有请求头无法携带的字符——多半是粘贴时混入的全角或非拉丁字符。请重新粘贴。',
  testErrHttp: '端点返回了错误。',
  testErrBadResponse: '端点有应答，但不是模型列表。仍可手动填写模型名。',
  testErrNoEndpoint: '这个连接使用宿主配置的端点，自身不带端点地址。',
  testRefused: '测试未能执行：{message}',
  saveThisConnection: '保存这个供应商',
  updateConnection: '保存修改',

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
  promptDeferred: '已后移（缓存友好）',
  promptPromoted: '已前移（缓存友好）',
  promptDeferredWhere: '原位置第 {n} / {total} 条',
  promptDeferredAria: '为前缀缓存移到了对话之后',
  promptPromotedAria: '这段跨轮逐字未变，为前缀缓存移到了对话之前',

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
  /** 没有在用的供应商时那次生成的拒绝（host §61）：说的是下一步，不是路由。 */
  errNoProvider: '没有在用的供应商，无从生成。请到 设置 → 连接 添加一个，然后点「使用」。',
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
  usageTurn: '用量 {total}',
  usageTurnRate: '用量 {total} · {rate}',
  usageTurnTitle: '本轮用量',
  usageDetailCacheHit: '缓存命中',
  usageDetailInput: '未缓存输入',
  usageDetailCacheRead: '缓存读取',
  usageDetailCacheWrite: '缓存写入',
  usageDetailOutput: '输出',
  usageDetailReasoning: '（其中推理 {tokens}）',
  /** 计时四行。口径见 en 一侧：「输出速度」是上游 `Token rate`，整段窗口（含排队）
      的输出量除以秒数，与 SillyTavern 打印的是同一个数；「纯输出」是 Iris 自己加的，
      去掉首字等待之后的速度。两者可以差一倍，所以词不相同。 */
  usageDetailDuration: '用时',
  usageDetailFirstToken: '首字',
  usageDetailThinking: '思考',
  usageDetailRate: '输出速度',
  usageDetailDecodeRate: '纯输出',
  usageSeconds: '{value}s',
  usageRate: '{value} tok/s',
  /** 输入框下用量行的悬浮卡：标题，与「输入」一栏的行标签。卡和行本是同一组行
      （`usageSummaryRows`），这里就是行上那个「输入」拿到了自己的键，不是给计费
      之和另起一个词。 */
  usageSummaryTitle: '会话用量',
  usageSummaryInput: '输入',

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
  usageMetricScript: '卡脚本',
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
  usageUndatedShort: '{n}/{turns} 次无时间戳',
  usageSkippedShort: '{n} 个文件未读',
  usageBasisAria: '这些数字的口径',
  usageHitRateBasis: '缓存替你省下的提示 token 占比，只在「提供方报告了缓存桶」的那些生成上计算。对缓存沉默的线路不进分母，所以这不是旁边那张「计费输入」的命中比例。',
  usageScriptShare: '其中卡脚本请求 {n} 次 · {tokens} tok',
  usageScriptBasis: '卡自己的脚本发起的请求（TavernHelper.generate / generateRaw）。它们和一次回合一样计费，但不产生任何回复，本页每个数字都已把它们算在内。',
  usageScriptCell: '卡脚本 {n} 次 · {tokens} tok',
  usageCompactionShare: '其中压缩摘要 {n} 次 · {tokens} tok',
  usageCompactionBasis: 'Iris 自己发起的请求，用来把这段时间较早的历史折成摘要。它们和一次回合一样计费，但不产生任何回复，本页每个数字都已把它们算在内。',
  usageCompactionCell: '压缩摘要 {n} 次 · {tokens} tok',
  usageChartEmpty: '这段时间这个指标没有产生计费。',
  contextPill: '上下文 {used}/{total} · {percent}%',
  contextPillCapacity: '上下文 {total}',
  contextPillTitle: '看上下文窗口被什么占满了',
  contextCardTitle: '上下文容量',
  contextCardFigures: '{used} / {total} · {percent}%',
  contextCardLoading: '正在算下一条请求会装配成什么……',
  contextCardFailed: '读不到明细 —— {reason}',
  contextCategoryMessages: '消息历史',
  contextCategoryWorldbook: '世界书',
  contextCategoryPreset: '主提示词与预设段',
  contextCategoryCharacter: '角色与人设',
  contextCategoryScript: '脚本注入',
  contextCategoryOther: '其他',
  contextRemaining: '还剩 {tokens}',
  contextReserve: '为回复留出 {tokens}',
  contextStablePrefix: '稳定前缀 约 {percent}%（{tokens}）',
  contextFromRecord: '第 {turn} 回实测',
  contextFromPreview: '下一条请求的预览',
  contextWindowFromModel: '窗口 {tokens}，按模型 {model} 的上限',
  contextWindowFromSettings: '窗口 {tokens}，来自设置或预设',
  contextWindowUnlocked: '窗口 {tokens}，未夹 —— {model} 已知只到 {modelTokens}',
  contextWindowFromHost: '窗口 {tokens}，宿主默认',

  divergenceLine: '与上一条请求在 {percent} 处分叉 · 落在〈{item}〉',
  divergenceIdentical: '与上一条请求逐字节相同',
  divergenceNone: '没有更早的请求可比',
  divergenceOpen: '看看是哪几段变了',
  divergenceFloor: '第 {n} 层',
  divergenceHeading: '最新那条请求（{kind}）与它前面那条（{previousKind}）相比',
  divergenceCeiling: '这些字节里有 {percent} 本可以由缓存供出',
  divergenceServed: '提供方实际给了 {percent}',
  divergenceUnreported: '提供方没报缓存',
  divergenceShortfall: '远低于字节允许的上限',
  divergenceColdStart: '这是本对话最前两条请求之一 —— 前缀要被看到两次才会存下来',
  divergenceStale: '距上一条请求超过半小时，缓存的前缀可能已经过期',
  divergenceRoute: '与上一条请求不是同一个模型（{from} → {to}），而缓存只属于一个模型',
  divergenceInterrupted: '这条回复没有走完（提供方中途断开，或一直没有应答），所以没有上报用量',
  divergenceSplit: '{total} 字节命不中：新增 {added}、改写 {changed}、逐字未变却落在前缀之后 {repeated}、框架 {structure}',
  divergenceStateSame: '未变',
  divergenceStateChanged: '改写',
  divergenceStateAdded: '新增',
  divergenceStateGone: '消失',
  divergenceStranded: '逐字未变，仍整段重发',
  divergenceBytes: '{bytes} 字节',
  divergenceUnattributed: '字节偏移是准的，落在哪一段不准 —— {reason}',

  commandRow: '{command} —— {summary}',
  commandArgHeading: '{command} 可以填的值',
  commandUnknown: '/{name} 在这里不是命令 —— {reason}',
  commandBusy: '正在出回复，/{name} 现在不能跑',
  commandNeedsArgument: '/{name} 后面得跟点东西 —— {usage}',
  commandHelpHeading: '命令：',
  commandGroupChat: '这个对话：',
  commandGroupContext: '模型与上下文：',
  commandGroupApp: '设置与帮助：',
  commandHelpUpstream: '其他以斜杠开头的都交给宿主，由它按 SillyTavern 的语义执行。',
  commandHelpSummary: '列出这个输入框认识的命令',
  commandCompactSummary: '把较早的历史折成摘要，腾出上下文',
  commandCompactDone: '已压缩 {floors} 条：{before} tok 的历史现在是一段 {after} tok 的摘要。',
  commandCompactNothing: '没有可压的了 —— 历史已经只剩一段摘要加最新一条。',
  commandCompactFailed: '压缩没有执行 —— {reason}',

  commandNewSummary: '用这个角色新开一段对话',
  commandNewDone: '已新开一段对话。',
  commandNewNoCharacter: '这个对话没说自己属于哪张卡，没法据此新开一段。',
  commandRenameSummary: '给这个对话改个标题',
  commandRenameUsage: '<标题>',
  commandRenameDone: '这个对话现在叫「{title}」。',
  commandExportSummary: '把这个对话存成文件',
  commandModelSummary: '只改这个对话用的模型',
  commandModelUsage: '<模型名>|default',
  commandModelCurrent: '这个对话在用 {model}。可选：{models}',
  commandModelSet: '这个对话现在用 {model}，其他对话不受影响。',
  commandModelCleared: '这个对话回到所属连接的模型了。',
  commandModelAlreadyDefault: '这个对话本来就在用所属连接的模型（{model}），没有覆盖可清。',
  commandModelUnknown: '{model} 不在这个连接给出的模型里：{models}',
  commandCapacitySummary: '打开那张说上下文占了多少的卡',
  commandCapacityNoBudget: '宿主还没报这个对话的上下文窗口，暂时没有容量可看。',
  commandConfigSummary: '打开设置抽屉',

  compactedTitle: '较早的 {floors} 条以摘要形式发送',
  compactedFigures: '{before} → {after}',
  compactedKept: '什么都没删：每一条都还在这个对话里、也还在它的文件里。变的只是发给模型的内容。',
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
