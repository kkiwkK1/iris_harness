/**
 * A character's portrait, at the two sizes the library uses.
 *
 * One component for both, because the interesting half is the fallback and a
 * second copy of it would be a second policy. `CharacterSummary.avatarUrl` is
 * **optional** and is served only by the real host
 * (`iris-app-service/src/library.ts` sets it; the fake transport never does), so
 * "no avatar" is the ordinary case rather than an error — and a broken-image
 * glyph in the column where every other row has a face reads as a load that
 * failed. The fallback is the name's first character on the touched ground,
 * which is legible for CJK and Latin alike.
 *
 * The image is not made accessible: the name is beside it in every use, and an
 * `alt` carrying the same name would have a screen reader say it twice. An empty
 * `alt` is the correct spelling of "decorative duplicate".
 *
 * @module iris-web/app/Portrait
 */

import type { ReactElement } from 'react'

import type { CharacterSummary } from '@iris/protocol'

/**
 * Render a portrait.
 * @param props.character - whose portrait, for the URL and the fallback letter.
 * @param props.size - `row` is the library list's 34px; `page` the character
 *   page's 116px. The geometry lives in CSS, so this only picks the class.
 * @returns the portrait.
 */
export function Portrait({
  character,
  size,
}: {
  character: CharacterSummary
  size: 'row' | 'page'
}): ReactElement {
  const shape = size === 'page' ? 'iris-avatar iris-face__portrait' : 'iris-avatar'

  if (character.avatarUrl !== undefined && character.avatarUrl !== '') {
    return <img className={shape} src={character.avatarUrl} alt="" aria-hidden="true" />
  }

  /*
   * `[...name][0]` rather than `name[0]`: a name beginning with an astral
   * character — an emoji, or a rarer CJK ideograph above the BMP — is two code
   * units, and taking one of them draws a replacement box. Spreading iterates
   * code points.
   */
  const initial = [...character.name.trim()][0] ?? '·'
  return (
    <span className={`${shape} iris-avatar--letter`} aria-hidden="true">
      {initial}
    </span>
  )
}
