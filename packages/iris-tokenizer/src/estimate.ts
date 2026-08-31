/**
 * Token estimation for context budgeting.
 *
 * Iris does not ship a real tokenizer. Every provider uses a different
 * vocabulary, the WASM builds are large, and a budget does not need exactness —
 * it needs a bound it will not quietly exceed. What it does need is to be right
 * about *Chinese*, because a naive `length / 4` under-counts CJK by a factor of
 * four and an under-count is the one failure mode that matters: the request gets
 * refused by the provider after the user has already waited.
 *
 * The model is per-character-class, chosen because measurement said the ratio is
 * almost entirely a function of script. Measured against `deepseek-v4-flash` by
 * difference (two requests differing only by the sample, so the chat template
 * cancels):
 *
 * | sample              | chars | tokens | chars/token |
 * |---------------------|-------|--------|-------------|
 * | Latin prose         |    95 |     19 |        5.00 |
 * | Chinese prose       |    31 |     25 |        1.24 |
 * | mixed CN/EN         |    46 |     15 |        3.07 |
 * | TypeScript          |   143 |     30 |        4.77 |
 * | JSON                |    97 |     28 |        3.46 |
 * | whitespace-heavy    |    34 |     13 |        2.62 |
 * | CJK with punctuation|    35 |     20 |        1.75 |
 *
 * Chinese held at 1.240 chars/token at both 31 and 248 characters, so the
 * relationship is linear and a per-character model is the right shape rather
 * than a convenient one.
 *
 * @module @iris/tokenizer/estimate
 */

/**
 * Tokens per character, by class.
 *
 * Biased slightly high on purpose. For budgeting, over-estimating costs a few
 * dropped history turns; under-estimating costs a rejected request.
 */
export interface ClassWeights {
  /** Han, kana and hangul — roughly one token per character. */
  cjk: number
  /**
   * Full-width punctuation and quotation marks.
   *
   * Separated from `cjk` because measurement forced it: the CJK-with-quotes
   * sample came in at 1.75 chars/token against 1.24 for plain prose, and
   * charging `「」？——，` a full token each over-estimated it by 45%.
   */
  cjkPunct: number
  /** ASCII letters and digits, which merge into word-pieces. */
  alnum: number
  /** ASCII punctuation, symbols and whitespace, which break word-pieces. */
  other: number
  /** Astral code points — emoji and rare ideographs cost more than one token. */
  astral: number
}

/**
 * Weights fitted to the measurements in this module's documentation.
 *
 * Accurate to roughly ±30%, and no tighter is available from a per-character
 * model: a common Chinese word merges into one token while an uncommon one
 * splits, so the same script class ran between 0.74 and 0.93 tokens per
 * ideograph across the samples. When a budget needs to be tighter than that,
 * use {@link createCalibratingCounter}, which converges on the real ratio from
 * the counts the provider reports.
 */
export const DEFAULT_WEIGHTS: ClassWeights = {
  cjk: 0.88,
  cjkPunct: 0.25,
  alnum: 0.21,
  other: 0.42,
  astral: 2,
}

/** Tokens a chat turn costs beyond its text, measured at ~3 for DeepSeek. */
export const DEFAULT_MESSAGE_OVERHEAD = 3

/** Whether a BMP code point is a CJK script character. */
function isCjk(code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) // kana
    || (code >= 0x3400 && code <= 0x4dbf) // extension A
    || (code >= 0x4e00 && code <= 0x9fff) // unified ideographs
    || (code >= 0xac00 && code <= 0xd7af) // hangul syllables
    || (code >= 0xf900 && code <= 0xfaff) // compatibility ideographs
  )
}

/** Whether a BMP code point is full-width punctuation rather than a script character. */
function isCjkPunctuation(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x303f) // 　、。〈〉《》「」『』【】〜…
    || (code >= 0xff01 && code <= 0xff20) // ！＂＃…＠, excluding full-width digits
    || (code >= 0xff3b && code <= 0xff40) // ［＼］＾＿｀
    || (code >= 0xff5b && code <= 0xff65) // ｛｜｝～｡｢｣､･
  )
}

/** Whether a code point is an ASCII letter or digit. */
function isAlnum(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
  )
}

/**
 * Estimate the tokens a string occupies.
 *
 * Iterates code points, not UTF-16 units, so a surrogate pair is one item
 * rather than two half-characters attributed to the wrong class.
 * @param text - the text to measure.
 * @param weights - per-class weights; defaults to the fitted set.
 * @returns a token count, rounded up. Empty text costs nothing.
 */
export function estimateTokens(text: string, weights: ClassWeights = DEFAULT_WEIGHTS): number {
  if (text.length === 0) return 0

  let total = 0
  for (const character of text) {
    const code = character.codePointAt(0) as number
    if (code > 0xffff) total += weights.astral
    else if (isCjk(code)) total += weights.cjk
    else if (isCjkPunctuation(code)) total += weights.cjkPunct
    else if (isAlnum(code)) total += weights.alnum
    else total += weights.other
  }
  return Math.ceil(total)
}

/** One message, for counting purposes. */
export interface CountableMessage {
  text: string
}

/**
 * Estimate a whole request.
 *
 * The per-message overhead is the part a text-only counter misses: every turn
 * carries role framing, and a long conversation of short messages is mostly
 * framing. Measured at ~3 tokens per message on DeepSeek.
 * @param messages - the conversation.
 * @param options - overhead per message and a fixed template cost.
 * @returns the estimated prompt size.
 */
export function estimateRequest(
  messages: readonly CountableMessage[],
  options: { messageOverhead?: number, templateOverhead?: number, weights?: ClassWeights } = {},
): number {
  const perMessage = options.messageOverhead ?? DEFAULT_MESSAGE_OVERHEAD
  const weights = options.weights ?? DEFAULT_WEIGHTS
  const text = messages.reduce((total, message) => total + estimateTokens(message.text, weights), 0)
  return text + messages.length * perMessage + (options.templateOverhead ?? 0)
}
