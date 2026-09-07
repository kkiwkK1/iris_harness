/**
 * A one-pixel edge is the hairline token, in every stylesheet that draws one.
 *
 * `--iris-hairline` exists because 「梅花」 carries structure on 1px rules and
 * almost nothing else (`tokens.css` — "structure is carried by 1px rules"). The
 * value being 1 today is not the point: the point is that it is **one**
 * decision. Four panels rewritten to the token while three kept `1px` is the
 * state this suite found, and it is invisible — the two render identically until
 * somebody wants a half-pixel edge on a 2× display or a heavier rule in one
 * theme, at which point the literals stay behind and nothing says which.
 *
 * **Scoped to 1px on purpose.** A 2px or 4px border in these files is a
 * deliberate weight, not a hairline — the sidebar's selected-row bar, the
 * itemization table's indent, the drop target's dashed frame — and folding them
 * into this token would make a rename change three unrelated marks at once.
 * What is asserted is only that nobody draws *the* hairline by hand.
 *
 * Border **radius** is not covered, and three literals survive it: a 6px
 * theme-preview cell and a 2px proportion bar in `panels.css`, and the variant
 * rail's 1px tick in `reading.css`. The corner ruler's smallest step is 8px, so
 * none of the three has an equivalent token — rounding a 10px bar or a 2px tick
 * to 8px is a visual decision for whoever owns the artboards, not a
 * substitution, which is why this test refuses to have an opinion about radius.
 *
 * @module iris-web/tests/hairline
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'app')

/** The stylesheets the shell loads, all three of them. */
const SHEETS = ['panels.css', 'shell.css', 'reading.css'] as const

/**
 * Every border declaration in one stylesheet, as `property: value` pairs.
 *
 * `border-radius` is dropped here rather than filtered later, so a radius
 * literal can never be reported by a test whose message talks about edges.
 * @param css - the stylesheet text.
 * @returns the declarations, without their trailing semicolons.
 */
function borders(css: string): { property: string, value: string }[] {
  const found: { property: string, value: string }[] = []
  for (const match of css.matchAll(/(border[a-z-]*)\s*:\s*([^;{}]+);/g)) {
    const property = match[1] ?? ''
    if (property.startsWith('border-radius')) continue
    found.push({ property, value: (match[2] ?? '').trim() })
  }
  return found
}

for (const sheet of SHEETS) {
  test(`${sheet} draws no 1px border by hand`, () => {
    const declarations = borders(readFileSync(join(APP, sheet), 'utf8'))
    /*
     * A floor on the sample, because the scan is a pattern over text: a
     * stylesheet that stopped matching — renamed, moved, restructured — would
     * otherwise pass this with an empty list and report "no literals" about a
     * file it never read. Every one of these sheets draws dozens of edges.
     */
    assert.ok(
      declarations.length >= 10,
      `only ${String(declarations.length)} border declaration(s) found in ${sheet}; the scan is no longer reading it`,
    )
    const literal = declarations.filter(one => /(^|\s)1px(\s|$)/.test(one.value))
    assert.deepEqual(
      literal,
      [],
      `${sheet} writes 1px where var(--iris-hairline) belongs: `
        + literal.map(one => `${one.property}: ${one.value}`).join(' | '),
    )
  })

  test(`${sheet} takes the hairline from the token at least once`, () => {
    /*
     * The other direction, and not decoration: the check above is satisfied by a
     * stylesheet with no hairlines at all — including one where every `1px` was
     * "fixed" by deleting the edge instead of tokenising it. This pins that the
     * token is what these files actually draw with.
     */
    const css = readFileSync(join(APP, sheet), 'utf8')
    assert.ok(
      css.includes('var(--iris-hairline)'),
      `${sheet} no longer uses --iris-hairline, so nothing here reads the shared edge width`,
    )
  })
}

test('the token is declared once, structurally, and not per theme', () => {
  /*
   * A theme redefining the hairline would make the edge width a palette
   * decision, which is what the token exists to prevent — and it would do it
   * silently, since only one of the three themes would look wrong.
   */
  const tokens = readFileSync(join(APP, '..', 'theme', 'tokens.css'), 'utf8')
  const declarations = [...tokens.matchAll(/--iris-hairline:\s*([^;]+);/g)].map(match => (match[1] ?? '').trim())
  assert.deepEqual(declarations, ['1px'], 'the hairline is declared more than once, or is no longer 1px')
})
