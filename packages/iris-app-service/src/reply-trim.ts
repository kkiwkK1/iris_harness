/**
 * Cutting a finished reply back to its last complete sentence.
 *
 * A verbatim port of upstream's `trimToEndSentence` (`utils.js:883`), because
 * the rule is behavioural: the punctuation set — including the CJK closers and
 * the emoji clause — decides where real users' replies are cut, and a
 * hand-rolled "nicer" rule would cut different replies than the ones users of
 * the setting expect. Called only when `trimSentences` is on, only on a reply
 * that ran to completion.
 *
 * @module @iris/app-service/reply-trim
 */

/** The punctuation upstream cuts after, verbatim (`utils.js:887`). */
const SENTENCE_PUNCTUATION = new Set([
  '.', '!', '?', '*', '"', ')', '}', '`', ']', '$',
  '。', '！', '？', '”', '）', '】', '’', '」', '_',
])

/** Upstream's emoji test (`utils.js:884`), which also ends a sentence. */
function isEmoji(character: string): boolean {
  return /(\p{Emoji_Presentation}|\p{Extended_Pictographic})/u.test(character)
}

/**
 * Trim the text after its last sentence-ending character.
 *
 * A character ending a sentence ends it only when it is not itself preceded by
 * whitespace — upstream's `… .` rule, which keeps a lone `…` in a list from
 * swallowing the rest. Text with no cut point at all keeps its tail trimmed of
 * whitespace, and nothing more.
 * @param input - the reply as generated.
 * @returns the reply, cut back to its last complete sentence.
 */
export function trimToEndSentence(input: string): string {
  if (input.length === 0) return ''

  const characters = Array.from(input)
  let last = -1

  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index] as string
    if (SENTENCE_PUNCTUATION.has(character) || isEmoji(character)) {
      if (!isEmoji(character) && index > 0 && /[\s\n]/.test(characters[index - 1] as string)) {
        last = index - 1
      } else {
        last = index
      }
      break
    }
  }

  if (last === -1) return input.trimEnd()
  return characters.slice(0, last + 1).join('').trimEnd()
}
