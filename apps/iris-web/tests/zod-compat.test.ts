/**
 * The prefault-chaining compatibility layer, against the real zod it ships with.
 *
 * The break this exists for is a *library-shape* break, so the tests import the
 * same `zod` the bundle bundles rather than describing it: a chain of
 * `z.coerce.number().prefault(0).min(0)` either runs or it does not. The
 * measured caller is 全职高手's variable-structure script — 158 `prefault`
 * sites, five of them chained — whose schema never loaded under the bare 4.x
 * namespace.
 *
 * Chained calls are typed through a local `Chained` helper rather than through
 * zod's own types: the pre-install type has no `.min` — that absence **is** the
 * bug being fixed — so asserting on the runtime surface through the installed
 * type would both fail typecheck before the install and prove nothing after it.
 *
 * @module iris-web/tests/zod-compat
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'

import { z } from 'zod'

import { installPrefaultCompat } from '../src/sandbox/zod-compat.ts'

/**
 * The chain surface a card sees at runtime after the install.
 *
 * Deliberately `unknown`-typed at the seam: what the tests assert is that the
 * *runtime* object carries these members, which zod's own types say it does
 * not.
 */
interface Chained {
  min: (v: number) => Chained
  max: (v: number) => Chained
  int: () => Chained
  parse: (input: unknown) => number
  safeParse: (input: unknown, opts?: unknown) => { success: boolean, data: number }
  _zod: { def: { type: string } }
  unwrap: unknown
}

const prefaultNumber = (value: number): Chained =>
  z.coerce.number().prefault(value) as unknown as Chained

test('the break reproduces on the bare namespace, and the install fixes it', () => {
  /*
   * Guarding the premise first. If a future zod upgrade makes this assertion
   * fail, the chain works unaided — and the compat layer must be removed in the
   * same change that removes this test, because a forwarding layer over a
   * schema that already chains is a second idea of the same semantics.
   */
  const bare = z.coerce.number().prefault(0) as unknown as Record<string, unknown>
  assert.equal(
    typeof bare['min'],
    'undefined',
    'the bare namespace now chains — remove the compat layer and this file together',
  )

  installPrefaultCompat(z as unknown as object)

  const chained = prefaultNumber(0).min(0).max(100)
  assert.equal(chained.parse('55'), 55, 'a present input coerces and passes the constraints')
  assert.equal(chained.parse(undefined), 0, 'the absent input yields the prefault value')
})

test('the composed schema answers the prefault inside objects, records and arrays', () => {
  // The card's schema nests chained prefaults three levels deep; a compat view
  // that did not survive embedding would pass the one-line test above and still
  // break the card.
  const schema = z.object({
    状态: z
      .object({
        疲劳度: prefaultNumber(0).min(0).max(100),
        心态值: prefaultNumber(100).min(0).max(100),
      })
      .prefault(() => ({}) as { 疲劳度: unknown; 心态值: unknown }),
    装备: z
      .record(z.string(), z.object({ 等级需求: prefaultNumber(1) }))
      .prefault({} as Record<string, never>),
    标签: z.array(z.string().prefault('无')).prefault([] as never),
  })

  assert.deepEqual(
    schema.parse({}),
    { 状态: { 疲劳度: 0, 心态值: 100 }, 装备: {}, 标签: [] },
    'a parse-time read of an empty input must draw the whole prefault tree',
  )
})

test('chaining continues past one hop and each hop re-applies the same prefault', () => {
  // All five measured chains are two-hop (min then max). A first hop that
  // returned a bare constrained schema would parse present inputs correctly and
  // lose the prefault for absent ones — the quiet half of the break.
  const twoHop = prefaultNumber(0).min(0).max(100)
  assert.equal(twoHop.parse(undefined), 0, 'the prefault was lost after the second hop')

  const threeHop = prefaultNumber(7).int().min(1).max(100)
  assert.equal(threeHop.parse(undefined), 7, 'the prefault was lost after the third hop')
  assert.equal(threeHop.parse('55'), 55, 'coerce is still in effect after chaining')
})

test('a contradictory chain is refused, not clamped', () => {
  /*
   * The semantics the layer composes, asserted on the case the corpus does not
   * carry: a prefault value that fails its own constraint. `prefault` feeds the
   * value into the constrained schema, so the absent case throws — exactly as
   * the same chain does upstream. Returning the prefault anyway would be an
   * approximate answer invented to make a broken card look whole.
   */
  const contradictory = prefaultNumber(0).min(1)
  assert.throws(() => contradictory.parse(undefined), (error: unknown) => {
    const issues = (error as { issues?: { code: string }[] }).issues
    return Array.isArray(issues) && issues[0]?.code === 'too_small'
  })
})

test('the tail-of-chain idiom and the un-prefaulted path are untouched', () => {
  // Four of the five prefault-using cards call it at the end of a chain, and
  // every MVU card builds un-prefaulted schemas. A compat layer that altered
  // either shape would be a regression across the corpus this was written to
  // serve.
  assert.equal(z.string().prefault('待初始化').parse(undefined), '待初始化')
  assert.equal(z.string().prefault('待初始化').parse('x'), 'x')
  assert.equal(z.coerce.number().min(1).parse('3'), 3)
  assert.equal(z.object({ a: z.string() }).parse({ a: 'x' }).a, 'x')
})

test('the wrapper answers the members the helpers reach for', () => {
  /*
   * `mvu_zod` (the module every zod-schema card imports) reads
   * `z.object({stat_data: …})` around the card's schema, `safeParse`s it, and
   * `instanceof z.ZodObject`s the top level. The wrapper sits *inside* that
   * object, so the checks pass through — but `safeParse` and `parse` on the
   * wrapper itself are the calls a card makes directly, and the introspection
   * bag is what structure walks.
   */
  const chained = prefaultNumber(0).min(0)
  const result = chained.safeParse(undefined, { reportInput: true })
  assert.equal(result.success, true)
  assert.deepEqual(result.data, 0)
  assert.equal(chained._zod.def.type, 'prefault', 'the introspection bag must stay the wrapper’s')
  assert.equal(typeof chained.unwrap, 'function', 'the wrapper’s own members stay reachable')
})

test('the install is idempotent by prototype, not by luck', () => {
  // z.number() and z.coerce.number() share one prototype; a second pass over an
  // already-patched descriptor would build a proxy over a proxy over a getter —
  // the shape that cost this fix its debugging round. The install deduplicates
  // by prototype identity, and the install itself runs exactly once per page in
  // production (the preset bundle evaluates once per origin).
  installPrefaultCompat(z as unknown as object)
  installPrefaultCompat(z as unknown as object)
  assert.equal(prefaultNumber(0).min(1).parse('5'), 5)
})
