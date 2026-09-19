/**
 * What the authoring row's two controls hold after a provider is chosen.
 *
 * The row (`docs/SANDBOX-PLUGINS.md` §11.1) is a provider `<select>`, a model
 * control and one button, and its model control is **controlled**: what the
 * browser shows is whatever React state says. A `<select>` whose options do not
 * contain its `value` is the one place that stops being true — the browser has
 * to display *something*, so it displays the first option, while the state it
 * was given stays what it was. That is the defect this module exists to remove
 * (owner, 2026-09-19): the row showed a model name and 「用它写插件」 stayed
 * disabled, because `disabled` was reading the state and the reader was reading
 * the screen, and the two disagreed until the selection was moved away and back.
 *
 * The fix is on the **state** rather than on the `disabled` check, which is the
 * ruling and also the only version that is true in both directions: relaxing
 * `disabled` to "a provider is chosen" would enable the button while the model
 * sent to the host was still `''`. So choosing a provider now also chooses a
 * model — the first one it advertises — and the screen and the state say the
 * same thing from the first render.
 *
 * No `<option value="">` placeholder is added beside it. The ruling allows one
 * only against a demonstrated case where defaulting to the first model is the
 * wrong answer, and there is none: every model in the list is a model this
 * endpoint advertises, the row's button is 「用它写插件」 rather than a
 * destructive act, and the row prints what is stored underneath it. Two
 * controls spelling "nothing chosen" two different ways — a blank option here
 * and the 「不设置」 row in the provider control — would be the worse shape.
 *
 * A `.ts` module rather than a closure inside `ConnectionPanel.tsx` for the
 * reason `model-menu.ts` gives at length: node's test runner strips types but
 * does not transform JSX, so a decision that lives in a `.tsx` file cannot be
 * reached by a unit test at all. This one had already been wrong once.
 *
 * @module iris-web/app/authoring-pick
 */

/** The pair the authoring row's controls hold before the button is pressed. */
export interface AuthoringDraft {
  /** The chosen provider's id, or `''` while 「不设置」 is selected. */
  id: string
  /** The model name, as the control shows it. */
  model: string
}

/** The one thing this decision needs to know about a saved provider. */
export interface AuthoringProfile {
  id: string
  /**
   * The provider's last probed model list. Absent means no probe of it ever
   * succeeded, which is a different fact from an empty one — and both of them
   * put the row on its hand-typed path, so this decision treats them alike.
   */
  models?: readonly string[] | undefined
}

/**
 * The draft after the provider control moves to `id`.
 *
 * Three cases, and the third is the fix:
 *
 * - **Hand-typing.** The model control is a text field, so what is on screen is
 *   already what is in the state and there is nothing to reconcile. Whatever
 *   the reader typed survives the provider changing under it: they typed it
 *   because no list offered it, and a name like that is usually a model in
 *   closed testing that several endpoints front (owner, 2026-09-10).
 * - **The provider advertises nothing** (no probe, or a probe that returned an
 *   empty list). The row falls back to the text field, and the model it was
 *   holding is dropped — it came out of the *previous* provider's list, and
 *   carrying it across would arm the button over exactly the mismatched pair
 *   the draft exists to prevent. The button goes back to disabled, which is
 *   honest: the state is empty and so is the field.
 * - **The provider advertises models.** Keep the current model if the new
 *   provider also advertises it, so switching between two endpoints that both
 *   serve `gpt-4o-mini` does not silently re-point the setting; otherwise take
 *   the first model, which is what the `<select>` is about to display.
 *
 * `typing` is what tells the first case from the second, and it is the right
 * discriminator rather than a convenience: with the field showing, the model in
 * the draft is one a person wrote, and with a dropdown showing it is one some
 * provider's list supplied.
 * @param profiles - the saved providers, as the panel lists them.
 * @param id - the provider id the control just moved to.
 * @param model - the model the draft holds now.
 * @param typing - whether the model control is the hand-typed field.
 * @returns the draft to store, with `id` always set to the new provider.
 */
export function authoringPick(
  profiles: readonly AuthoringProfile[],
  id: string,
  model: string,
  typing: boolean,
): AuthoringDraft {
  if (typing) return { id, model }
  const models = profiles.find(profile => profile.id === id)?.models ?? []
  if (models.length === 0) return { id, model: '' }
  if (models.includes(model)) return { id, model }
  // Non-null by the length check above; `models[0]` is typed as possibly
  // undefined under noUncheckedIndexedAccess and `?? model` is the honest way
  // to say it rather than an assertion.
  return { id, model: models[0] ?? model }
}
