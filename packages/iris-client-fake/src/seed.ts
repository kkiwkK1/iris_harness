/**
 * The library and conversations the fake starts with.
 *
 * A seeded store rather than an empty one: an interface developed against an
 * empty fake gets its empty states polished and its dense states discovered
 * late. These characters exist to give the reading surface real names, real
 * tag rows, and a chat with enough history to scroll.
 *
 * @module @iris/client-fake/seed
 */

import type { CharacterSummary, GenerationSettings, TurnUsage } from '@iris/protocol'

import type { FakeChat, FakeMessage } from './state.ts'

/**
 * Costs the seeded replies carry, and why they differ from one another.
 *
 * Four shapes, on purpose, because they are the four a real conversation mixes
 * and each is a different branch in whatever renders them:
 *
 * - {@link CACHED} is a DeepSeek-style reply with most of its prompt served
 *   from cache — a 76% hit rate, which is the ordinary case on a long chat and
 *   the number the feature exists to show.
 * - {@link UNCACHED} is the same provider on a cold prompt: it reports the
 *   bucket and it is `0`. A surface must show 0%, not "no cache".
 * - {@link SILENT_CACHE} is an endpoint that reports usage but **nothing about
 *   caching**, and carries no exact total either. Its buckets are missing, not
 *   zero, and a hit rate must not be computed for it at all — the distinction
 *   this whole convention exists to preserve.
 * - The greeting carries **nothing at all**: it was never generated through a
 *   provider (nor was any imported V1 history), and a row like that must show
 *   no figure rather than zeros — which is a fourth branch, not a variant of
 *   the others.
 */
const CACHED: TurnUsage = {
  inputTokens: 742,
  outputTokens: 218,
  cacheReadTokens: 2_368,
  totalTokens: 3_328,
}

/**
 * A cold prompt on a cache-reporting provider: reported, and zero.
 *
 * `reasoningTokens` is a **part of** `outputTokens` rather than a bucket
 * beside it — that is the wire convention this mirrors
 * (`completion_tokens_details.reasoning_tokens` is inside `completion_tokens`)
 * — so it is kept smaller than the output it belongs to. A fake carrying more
 * reasoning than output would look fine and would teach a reader that the two
 * add up.
 */
const UNCACHED: TurnUsage = {
  inputTokens: 1_904,
  outputTokens: 480,
  cacheReadTokens: 0,
  reasoningTokens: 311,
  totalTokens: 2_384,
}

/**
 * An endpoint that reports usage and says nothing about caching.
 *
 * The commonest OpenAI-compatible shape, and the one that makes the
 * absent-versus-zero rule matter: with no `cacheReadTokens`, there is no hit
 * rate to show for this generation, and folding it in as `0` would drag down a
 * conversation-wide rate with a provider that never claimed to have a cache.
 * It carries no `totalTokens` either, which is what makes this seed the case
 * for the ruling that a **conversation** reports no total at all: summed under
 * the optional-bucket rule, this chat's aggregate total would be 5712 while its
 * own buckets add to 6064 + 826 — a smaller number, wearing the name of the
 * larger one. See `ChatView.usage` and `conversationUsage`.
 */
const SILENT_CACHE: TurnUsage = {
  inputTokens: 1_050,
  outputTokens: 128,
}

/** Sampling the fake reports until something writes over it. */
export const DEFAULT_SETTINGS: GenerationSettings = {
  provider: 'openai-compat',
  model: 'local/qwen3-8b',
  temperature: 0.9,
  maxTokens: 1024,
  topP: 0.95,
  topK: 40,
  repetitionPenalty: 1.05,
}

/**
 * Scripts the fake reports for a card that carries any.
 *
 * Shaped after what the real corpus holds — one large webpack bundle, one small
 * hand-written script, one the card's own author disabled — so a list built
 * against this meets the cases that exist rather than three identical rows. The
 * byte sizes are real orders of magnitude: card scripts run to megabytes.
 *
 * It lives here, beside the library, because `CharacterSummary.scriptCount` and
 * `script.list` have to agree about one card: a page saying "3 scripts" over a
 * panel listing none is a contradiction the fake would be teaching the shell to
 * tolerate. `seedCharacters` takes the count from this array's length, and
 * `#scriptViews` answers with this array only for a card whose summary carries
 * a count — one source, two readings of it.
 */
export const FAKE_SCRIPTS: { id: string, name: string, info?: string, enabledByCard: boolean, bytes: number }[] = [
  { id: 'f0f993f6', name: 'ERA 核心', info: '状态栏与变量写入', enabledByCard: true, bytes: 1_792_316 },
  { id: 'acf69655', name: 'ERA 经验值系统', enabledByCard: true, bytes: 4_820 },
  { id: '3fc1e259', name: 'ERA 以上待修改', info: '', enabledByCard: false, bytes: 0 },
]

/**
 * The seeded character library.
 *
 * The three cards deliberately differ in **which optional fields they carry**,
 * not just in their values. Measured over the 19 real cards, the three facts a
 * character page shows are absent far more often than present — 15 of 19 have
 * no description, 2 embed no world book, 5 carry no scripts — so a fake whose
 * every card carried all three would leave the page's absent branches
 * unrendered, which is the half that a reviewer never sees and a card in the
 * wild usually takes.
 *
 * - 络络 carries all three, and is the card the seeded conversation is open on,
 *   so the dense form is what the dev server shows by default.
 * - Aria Vance carries a description and nothing else: the mixed row.
 * - The Archivist carries none of them, which is the shape of a plain V1 card:
 *   the page must drop all three columns rather than draw three empty ones, and
 *   fall back to the one fact it can always answer.
 */
export function seedCharacters(): CharacterSummary[] {
  return [
    {
      characterId: 'luoluo',
      name: '络络',
      tags: ['原创', '都市', '悬疑'],
      creator: '灯塔',
      // Under the host's 200 code-point clip on purpose: a fake that shipped a
      // pre-clipped 200 would hide whether the page can lay out a short one.
      description: '巷口修灯的人。工具箱里没有一把是买来的，问她价钱她只说「看你带什么来换」。城里断电的那三天，只有她那条巷子亮着。',
      bookEntryCount: 34,
      scriptCount: FAKE_SCRIPTS.length,
    },
    {
      characterId: 'aria-vance',
      name: 'Aria Vance',
      tags: ['original', 'nautical', 'slow burn'],
      creator: 'saltmarsh',
      description: 'Harbour pilot, third generation. Knows every sandbar between the light and the river mouth by the sound the hull makes over it.',
    },
    {
      characterId: 'the-archivist',
      name: 'The Archivist',
      tags: ['original', 'mystery', 'non-human'],
    },
  ]
}

/**
 * One exchange, both halves sharing a turn.
 *
 * `usage` is positional over `replies`, so a turn with two readings can have
 * one that reported a cost and one that did not — which is what a real turn
 * looks like after a provider switch, and what the conversation total has to
 * add up correctly over.
 */
function exchange(
  turn: number,
  name: string,
  ask: string,
  replies: readonly string[],
  usage: readonly (TurnUsage | undefined)[] = [],
): FakeMessage[] {
  return [
    { role: 'user', name: 'You', candidates: [{ text: ask }], index: 0, turn },
    {
      role: 'assistant',
      name,
      candidates: replies.map((text, at) => {
        const cost = usage[at]
        return { text, ...cost === undefined ? {} : { usage: cost } }
      }),
      index: 0,
      turn,
    },
  ]
}

/** The seeded conversations. */
export function seedChats(): FakeChat[] {
  const lamplighter: FakeMessage[] = [
    {
      role: 'assistant',
      name: '络络',
      candidates: [
        {
          text: `雨从傍晚下到现在，巷口那盏灯还是没亮。\n\n她蹲在灯柱底下，手里捏着一把细口钳，听见脚步声也没回头。"你迟了两刻钟，"她说，"灯芯已经吸饱水了。"`,
        },
      ],
      index: 0,
      // Turn 0 is the greeting: it has no user half, which is exactly the
      // asymmetry a chat UI has to survive at the top of the log. It also
      // carries no `usage`, because a greeting is copied from the card rather
      // than generated — nobody was ever billed for it, and no amount of
      // arithmetic can produce a figure for it later.
      turn: 0,
    },
    // Turn 1 has two readings, and the one the reader is **not** looking at
    // cost money too: swipe 0 is showing, swipe 1 was generated earlier
    // through a different endpoint. So this conversation's total is strictly
    // larger than what its visible rows add up to — which is the property a
    // surface summing the rows instead of the candidates would get wrong, and
    // would get wrong by an amount that looks like a rounding difference.
    ...exchange(1, '络络', '我走的是水渠那条路。桥上有人。', [
      `钳子合上，发出一声很轻的金属响。\n\n"桥上永远有人。"她终于抬头，"你是说有人在等你，还是有人在数人？"`,
      `"水渠。"她重复了一遍这两个字，像在称它的重量。\n\n"那你现在鞋里有半个城的水。坐下，别站在我灯下滴。"`,
    ], [UNCACHED, SILENT_CACHE]),
    ...exchange(2, '络络', '在数人。第三次了。', [
      `她把钳子插回围裙的皮套，动作比刚才慢了半拍——这是她唯一泄露出来的东西。\n\n"第三次。"她说，"那就不是巡检了。巡检只数一次，数完就填表。数三次的人是在等一个对不上的数。"`,
    ], [CACHED]),
  ]

  /**
   * The second conversation carries **no costs anywhere**, deliberately.
   *
   * This is what a chat imported from SillyTavern looks like, and what every
   * chat played before the host recorded usage looks like: the requests were
   * made and answered, and nothing wrote down what they cost. So `ChatView`
   * here has no `usage` at all, and a surface that renders a total must drop
   * the whole line rather than show zeros — an empty state that only exists if
   * something in the fake actually takes it.
   */
  const survey: FakeMessage[] = [
    {
      role: 'assistant',
      name: 'Aria Vance',
      candidates: [
        {
          text: `The chart room smells of wet paper and lamp oil, and Aria Vance has the northern survey pinned open with four brass weights and, for want of a fifth, her own elbow.\n\n"You're the one they sent." She does not make it a question. "Good. Hold this corner and don't be clever about the tide tables."`,
        },
      ],
      index: 0,
      turn: 0,
    },
    ...exchange(1, 'Aria Vance', 'Which part of the coast are they lying about?', [
      `She turns the map ninety degrees, which does not help, and then ninety again, which does.\n\n"Here." Her finger stops where the surveyors gave up. "They draw it straight because the truth costs a season."`,
    ]),
  ]

  const now = Date.now()
  return [
    {
      chatId: 'chat-lamplighter',
      title: '雨夜的第三次点数',
      characterId: 'luoluo',
      messages: lamplighter,
      updatedAt: now - 4 * 60 * 1000,
      settings: { ...DEFAULT_SETTINGS },
      variables: { 好感度: 32, 地点: '巷口灯柱下', 时间: '子时前后' },
    },
    {
      chatId: 'chat-survey',
      title: 'The northern survey',
      characterId: 'aria-vance',
      messages: survey,
      updatedAt: now - 3 * 60 * 60 * 1000,
      settings: { ...DEFAULT_SETTINGS, temperature: 0.7 },
      variables: { trust: 11, location: 'chart room' },
    },
  ]
}
