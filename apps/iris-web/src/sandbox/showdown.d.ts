/**
 * A minimal declaration for showdown, which ships none.
 *
 * `@types/showdown` is deliberately not installed, on the same reasoning as
 * `jquery.d.ts`: nothing in Iris calls showdown. It is bundled into the preset,
 * assigned to a global, and used only by card scripts — which are untyped by
 * nature and construct `new showdown.Converter()` for themselves. Declaring the
 * API surface here would suggest Iris has an opinion about how a card uses it,
 * and would add a second version to keep in step with the pinned one.
 *
 * The opacity is also a statement worth keeping: the preset **forwards** this
 * object and depends on no property of it, so a showdown upgrade cannot break
 * the preset in a way types would have caught.
 *
 * @module iris-web/sandbox/showdown
 */
declare module 'showdown' {
  /** The showdown namespace object, opaque here on purpose. */
  const showdown: unknown
  export default showdown
}
