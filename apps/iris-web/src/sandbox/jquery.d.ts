/**
 * A minimal declaration for jQuery, which ships none at 3.5.1.
 *
 * `@types/jquery` is deliberately not installed. Nothing in Iris calls jQuery —
 * it is loaded, assigned to a global, and used only by card scripts, which are
 * untyped by nature. Pulling in the full API surface would suggest Iris has an
 * opinion about how cards use it, and would have to be kept in step with a
 * version that is pinned to whatever SillyTavern serves.
 *
 * @module iris-web/sandbox/jquery
 */
declare module 'jquery' {
  /** The jQuery factory, opaque here on purpose. */
  const jquery: unknown
  export default jquery
}
