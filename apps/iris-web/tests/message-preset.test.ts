/**
 * The message frame's library bundle, checked for properties rather than sizes.
 *
 * Every assertion here pins something that would otherwise fail *silently*. A
 * missing font renders an icon as blank space; a floating version pin drifts a
 * major release under a card that was tested against another; an unwrapped
 * bundle throws into a cross-origin void. None of those produce an error anyone
 * would see.
 *
 * @module iris-web/tests/message-preset
 */
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const SANDBOX = join(here, '..', 'public', 'sandbox')

/**
 * The built message preset, or undefined when this checkout has no build.
 *
 * Skipped aloud rather than passing quietly, for the reason recorded in
 * `sandbox-assets.test.ts`: `public/sandbox/` is gitignored, and an early return
 * reports as a pass — so assertions about the build would read as green while
 * checking nothing.
 * @param t - the test context.
 * @returns the bundle source, or undefined after skipping.
 */
function bundle(t: { skip: (reason: string) => void }): string | undefined {
  const manifestPath = join(SANDBOX, 'manifest.json')
  if (!existsSync(manifestPath)) {
    t.skip('no sandbox build in this checkout — run "npm run build:sandbox"')
    return undefined
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, string>
  const name = manifest['message-preset']
  if (name === undefined) {
    t.skip('this build has no message preset')
    return undefined
  }
  return readFileSync(join(SANDBOX, name), 'utf8')
}

test('no url() in the bundle points outside itself', t => {
  const source = bundle(t)
  if (source === undefined) return

  /*
   * The property the whole inlining decision exists for.
   *
   * A frame that fetches its fonts separately has a state where the CSS arrived
   * and the fonts did not — and that state draws every icon as blank space with
   * no error anywhere, in any console, at any layer. Detecting it would need an
   * instrument watching for something invisible. Inlining removes the state.
   *
   * Asserted on the output rather than on the build flag that produces it: a
   * later change to the fonts could outgrow a literal limit, and this would
   * still be the thing that matters.
   */
  /*
   * Searched for **font file paths**, not for `url(`.
   *
   * The first version of this scanned every `url(` in the bundle and reported
   * two offenders, both named `e` — matches inside minified JavaScript that
   * builds a CSS url from a variable at run time. A caliper with false positives
   * on its own subject is worse than none: the obvious way to quiet it is to
   * loosen it until it stops complaining.
   *
   * A path is the precise thing that would cause a fetch, and an inlined face
   * has none: it appears as `data:font/woff2;base64,...`, where the format sits
   * after a slash rather than a dot.
   */
  const EXTENSIONS = ['.woff2', '.woff', '.ttf', '.eot']
  const offenders = EXTENSIONS.filter(extension => source.includes(extension))

  assert.deepEqual(
    offenders,
    [],
    'a font referenced by path is fetched at render time, so the frame has a state where the'
      + ' stylesheet arrived and the glyphs did not — and that state draws blank space silently',
  )

  // And the faces really are present, so the assertion above cannot be satisfied
  // by a bundle that simply has no fonts at all.
  assert.ok(source.includes('data:font'), 'no inlined face found; the check above would pass empty')
})

test('the TrueType duplicates are gone, and woff2 remains', t => {
  const source = bundle(t)
  if (source === undefined) return

  const count = (needle: string): number => source.split(needle).length - 1

  /*
   * Measured, not assumed. Inlining FontAwesome's `all.min.css` as shipped
   * produced 20 data URIs and 4.0 MB, because that file concatenates four
   * sub-sheets and each redeclares every `@font-face` in both woff2 and
   * TrueType. Dropping TrueType and importing the split sheets took the bundle
   * from 5.49 MB to 2.29 MB with identical icon coverage.
   */
  assert.equal(count('format("truetype")'), 0, 'TrueType buys nothing a woff2 browser needs')
  assert.ok(count('format("woff2")') > 0, 'the faces must still be declared')
  assert.ok(
    count('data:font') <= 8,
    `each face should be inlined about once; found ${String(count('data:font'))} data URIs`,
  )
})

test('the bundle records its own throw, like the script preset', t => {
  const source = bundle(t)
  if (source === undefined) return

  // A frame is an opaque origin, so an exception in here reaches
  // `window.onerror` redacted to `Script error.`. Recorded on the frame's own
  // window it is a value the frame can report verbatim.
  assert.ok(source.startsWith('try{'), 'the bundle is no longer wrapped')
  assert.ok(source.includes('__iris_preset_error__'), 'a throw would leave no name')
})

test('a message frame can tell it got the message preset, not the script one', t => {
  const source = bundle(t)
  if (source === undefined) return

  /*
   * The message bundle imports the script bundle's entry, so the script marker
   * being present proves only that the shared half ran. Without a second marker,
   * a frame served `preset.js` where it needed `message-preset.js` would look
   * correctly equipped right up to the first missing icon.
   */
  assert.ok(source.includes('__iris_message_preset_loaded__'))
  assert.ok(source.includes('__iris_preset_loaded__'), 'the shared half runs too')
})

test('every message-frame library is pinned to an exact version', () => {
  /*
   * These pins are claims about what is installed on the user's machine — the
   * jQuery pair from SillyTavern's own page, FontAwesome from its CSS banner,
   * Tailwind from the extension's local copy. A range would let a major drift
   * under a card that was tested against the pinned one, which is the failure
   * the jQuery 3.5.1-over-4.0.0 ruling exists to avoid.
   */
  const manifest = JSON.parse(
    readFileSync(join(here, '..', 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string> }
  const deps = manifest.dependencies ?? {}

  const expected: Record<string, string> = {
    jquery: '3.5.1',
    'jquery-ui': '1.13.2',
    'jquery-ui-touch-punch': '0.2.3',
    '@fortawesome/fontawesome-free': '6.5.2',
    '@tailwindcss/browser': '4.1.12',
  }

  for (const [name, version] of Object.entries(expected)) {
    assert.equal(deps[name], version, `${name} must stay pinned to what the user's install has`)
  }
})
