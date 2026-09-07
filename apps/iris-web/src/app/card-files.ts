/**
 * Which files the shell offers to import as character cards.
 *
 * **The decision is the host's, not the shell's.** `character.import` stores
 * exactly what `packages/iris-app-service/src/library.ts` `EXTENSIONS` lists
 * and refuses `.charx` by name (a V3 zip, and no zip reader is bundled —
 * `DEVIATIONS.md` §18 of that package for where the JPEG half came from). The
 * shell used to carry that list by hand in four places — two copy strings, the
 * file picker's `accept`, and the fake client's filename fallback — and they had
 * drifted: all four still offered `.charx`, which the host had stopped taking.
 * A picker that offers a format the host refuses is a promise the drop target
 * cannot keep, and the reader learns of it only from the refusal notice.
 *
 * So the list lives here once, and everything the shell shows derives from it.
 * The host's constant is not exported and lives in a Node package the browser
 * bundle cannot import, so the two copies are held together by a test instead
 * (`tests/card-files.test.ts` reads the host's source), which is the same
 * arrangement `theme-presets.test.ts` uses for the token tables.
 *
 * @module iris-web/app/card-files
 */

/**
 * Extension → the label the copy shows for it.
 *
 * A `Record` rather than a list so an alias can say what it is an alias of:
 * `.jpeg` and `.jpg` are one format and one label, and the test checks that the
 * two values agree so a future edit cannot split them into "JPG or JPEG".
 */
export const CARD_FILE_EXTENSIONS = {
  '.png': 'PNG',
  '.jpg': 'JPG',
  '.jpeg': 'JPG',
  '.json': 'JSON',
} as const satisfies Record<`.${string}`, string>

/** One of the extensions the host stores. */
export type CardFileExtension = keyof typeof CARD_FILE_EXTENSIONS

/** The file picker's `accept` attribute, derived so it cannot disagree with the table. */
export const CARD_FILE_ACCEPT: string = Object.keys(CARD_FILE_EXTENSIONS).join(',')

/**
 * The distinct labels, in table order — `PNG`, `JPG`, `JSON`.
 *
 * What the copy strings must each mention; the i18n table cannot interpolate a
 * list grammatically in two languages, so the strings are written by hand and
 * the test holds them to this.
 */
export const CARD_FILE_LABELS: readonly string[] = [...new Set<string>(Object.values(CARD_FILE_EXTENSIONS))]
