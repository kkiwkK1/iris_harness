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
  seededNotice: 'Seeded data — this page is not talking to a host. Add',
  seededNoticeSource: 'Source:',

  /** App shell. */
  notConnected: 'Not connected to the Iris host. Nothing you write will be sent.',
  dismiss: 'Dismiss',
  dropCard: 'Drop a character card — PNG, JSON or .charx — to add it to the library.',

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

  /** Message row. */
  save: 'Save',
  cancel: 'Cancel',
  copy: 'Copy',
  edit: 'Edit',
  regenerate: 'Regenerate',
  delete: 'Delete',
  copied: 'Copied.',
  generatingAria: 'Generating',

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
  stateHead: 'State',
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
  sectionReading: 'Reading',
  sectionLanguage: 'Language',

  /** World books panel. */
  sectionWorldbooks: 'World books',
  worldbooksNotLoaded: 'World book settings have not loaded.',
  worldbooksEmpty: 'No world books in this installation.',
  worldbookGlobalSelect: 'Injected into every chat',
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
  theme: 'Theme',
  themeSystem: 'System',
  themeLight: 'Light',
  themeDark: 'Dark',
  proseSize: 'Prose size',
  lineLength: 'Line length',
  lineLengthNote: 'Characters per line. Around 66 is what a book uses.',
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
  presetPrompts: 'Prompt manager',
  promptMoveUp: 'Move up',
  promptMoveDown: 'Move down',
  promptRemove: 'Remove {name} from the preset',
  promptMarker: 'slot',
  promptSystem: 'system',
  promptRole: 'role: {role}',
  promptNoToggle: 'This slot has no toggle.',

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
  nameThisConnection: 'Name this connection',
  connectionName: 'Connection name',
  saveConnection: 'Save the current settings as a connection',

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

  /** Error copy (`describeError`) and the store's own notices. */
  errNotFound: 'That is not there any more. The sidebar may be out of date — reload to catch up.',
  errInvalidRequest: 'Iris would not send that.',
  errBusy: 'This chat is still generating. Stop it first.',
  errUnsupported: 'This build of Iris cannot do that yet.',
  errQuota: 'The cards’ shared storage is full. Its contents are shared across every card in this profile, so the one that ran out may not be the one that filled it.',
  errInternal: 'Something broke on the host side.',
  irisOwnFault: 'Iris hit a problem of its own: {detail}',
  cleanedOne: 'cleaned 1 message',
  cleanedMessages: 'cleaned {n} messages',
  backedUpTo: 'the chat was backed up to {path}',
  reportsUnreadable: 'could not read the host’s reports: {detail}',
  pageAccessGranted: 'Page access granted. It takes effect the next time the card runs.',
  pageAccessRevoked: 'Page access revoked. It stops at the next run.',
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
  seededNotice: '种子数据——本页面没有连接宿主。加上',
  seededNoticeSource: '来源：',

  /** 外壳。 */
  notConnected: '未连接到 Iris 宿主。你写下的内容不会被发送。',
  dismiss: '关闭',
  dropCard: '拖入角色卡——PNG、JSON 或 .charx——即可加入角色库。',

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

  /** 消息行。 */
  save: '保存',
  cancel: '取消',
  copy: '复制',
  edit: '编辑',
  regenerate: '重新生成',
  delete: '删除',
  copied: '已复制。',
  generatingAria: '正在生成',

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
  stateHead: '状态',
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
  sectionReading: '阅读',
  sectionLanguage: '语言',

  /** 世界书面板。 */
  sectionWorldbooks: '世界书',
  worldbooksNotLoaded: '世界书设置尚未加载。',
  worldbooksEmpty: '此安装还没有世界书。',
  worldbookGlobalSelect: '注入每个聊天',
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
  theme: '主题',
  themeSystem: '跟随系统',
  themeLight: '浅色',
  themeDark: '深色',
  proseSize: '正文字号',
  lineLength: '每行长度',
  lineLengthNote: '每行字符数。书籍排版约 66。',
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
  presetPrompts: '提示词管理器',
  promptMoveUp: '上移',
  promptMoveDown: '下移',
  promptRemove: '从预设中移除 {name}',
  promptMarker: '槽位',
  promptSystem: '系统',
  promptRole: '角色：{role}',
  promptNoToggle: '此槽位没有开关。',

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
  nameThisConnection: '为这个连接命名',
  connectionName: '连接名称',
  saveConnection: '把当前设置存为一个连接',

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

  /** 错误文案与仓库自己的通知。 */
  errNotFound: '它已经不在了。侧栏可能过期了——刷新页面即可跟上。',
  errInvalidRequest: 'Iris 不会发送这个请求。',
  errBusy: '这个对话还在生成中。请先停止。',
  errUnsupported: '这一版 Iris 还做不到。',
  errQuota: '卡片的共享存储已满。它在整个配置中由所有卡片共用，所以用满的未必是正在运行的那张卡。',
  errInternal: '宿主侧出了点问题。',
  irisOwnFault: 'Iris 自身出了问题：{detail}',
  cleanedOne: '已清理 1 条消息',
  cleanedMessages: '已清理 {n} 条消息',
  backedUpTo: '对话已备份到 {path}',
  reportsUnreadable: '无法读取宿主报告：{detail}',
  pageAccessGranted: '页面访问权已授予。将在卡片下次运行时生效。',
  pageAccessRevoked: '页面访问权已撤销。将在下次运行时停止。',
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
