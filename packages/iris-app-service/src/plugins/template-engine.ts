/**
 * Iris's own EJS prompt-template engine, as a builtin system plugin.
 *
 * Until 2026-09-26 the engine (`@iris/compat-prompt-template`, run by
 * `templates.ts` in a forked child) was a composition option switched by the
 * operator's `IRIS_TEMPLATES=1`, and the plugin center could not see it. The
 * owner's ruling 7 (2026-09-25) moves the switch into the catalog: one row, off
 * by default, enabled through a risk confirmation that says it runs the card
 * author's JavaScript on this machine.
 *
 * **What the row is.** Presence of its capability is the switch the service
 * reads per request (`service.ts`, `#templateEngine`). The substance — the
 * child process, its empty environment, the heap ceiling, the recorded fences
 * — is unchanged and stays in `templates.ts` / `template.ts`; this activation
 * publishes only the engine's tuning. That is the same shape Tavern Helper and
 * MVU have today (their activations only `provide`), and deliberately so:
 * moving the evaluator into the activation would move the containment, and the
 * ruling keeps the containment exactly where it is.
 *
 * **What the row is not.** It is not the adopted upstream ST-Prompt-Template
 * extension (the ST plane, `origin: 'st-extension'`). Both expand `<%` tags,
 * which is why the owner mistook one for the other; the name and description
 * here say "Iris's own", and the combination of both enabled has one answer,
 * recorded in `service.ts` beside `#applyTemplates` and in the host DEVIATIONS
 * ledger: while the ST plane serves an enabled extension, that plane is the
 * prompt's template engine and this one does not evaluate prompts.
 *
 * @module @iris/app-service/plugins/template-engine
 */

import type { SystemPluginDefinition } from '../system-plugins.ts'

/** The catalog id. A plain string, like the other two builtin ids. */
export const TEMPLATE_ENGINE_PLUGIN_ID = 'iris-templates'

/** Service name the builtin publishes while it is active. */
export const TEMPLATE_ENGINE_CAPABILITY = 'template-engine'

/** What an active engine row publishes: the evaluator's tuning. */
export interface TemplateEngineCapability {
  /** Wall clock for one prompt's whole batch; the evaluator's default when absent. */
  readonly deadlineMs?: number
}

/**
 * The engine's catalog definition.
 * @param options - the composition's tuning (`templateDeadlineMs`).
 * @returns the definition the runtime registers as a builtin.
 */
export function createTemplateEngineDefinition(options: TemplateEngineCapability = {}): SystemPluginDefinition {
  // Frozen once, so every activation publishes the same value and nothing a
  // caller holds can retune a running engine.
  const capability: TemplateEngineCapability = Object.freeze(
    options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs },
  )
  return {
    id: TEMPLATE_ENGINE_PLUGIN_ID,
    name: 'Iris EJS templates',
    description: 'Iris’s own ST-Prompt-Template-compatible EJS engine. Runs the card author’s JavaScript '
      + 'on this machine, in a contained child process. Not the ST-Prompt-Template extension.',
    version: '0.0.0',
    apiVersion: 1,
    activate(scope) {
      return scope.provide(TEMPLATE_ENGINE_CAPABILITY, capability)
    },
  }
}

/**
 * The retired operator switch, and what a boot does about it.
 *
 * **The choice (ruling 7, "decide how an existing operator is migrated").** An
 * operator who ran with `IRIS_TEMPLATES=1` had the engine on; the first boot of
 * this build must not quietly turn it off. So when the variable is `1` **and
 * the catalog file holds no row for the engine yet**, the row is seeded
 * enabled, exactly as if the operator had confirmed it in the plugin center.
 * From then on the row is the switch: a stored row — enabled or disabled by
 * someone in the UI — is never overridden by the environment, because a
 * variable that could flip a row back on at every boot would make the UI's
 * off a preference the host forgets.
 *
 * The notice is logged on **every** boot the variable is still set, not only
 * the seeding one. A variable that is read and silently ignored is the failure
 * this host keeps paying for (a clean zero from a key nobody reads); the line
 * is what tells the operator to delete it. The seeding boot's sentence says
 * the row was turned on; later boots' say what the row currently is.
 */
export interface RetiredTemplatesEnv {
  /** `IRIS_TEMPLATES` as the composition read it; undefined when unset. */
  readonly value: string | undefined
}

/**
 * Whether this boot should seed the engine row enabled when it has no row.
 * @param env - the retired variable.
 * @returns true exactly for the value that used to turn the engine on.
 */
export function seedsTemplateEngine(env: RetiredTemplatesEnv): boolean {
  return env.value === '1'
}

/**
 * The one-line operator notice for a boot that still sees the variable.
 * @param env - the retired variable.
 * @param state.seeded - whether this boot found no stored row and took the default.
 * @param state.enabled - whether the engine row is enabled after boot.
 * @returns the sentence to log, or undefined when the variable is unset.
 */
export function retiredTemplatesEnvNotice(
  env: RetiredTemplatesEnv,
  state: { seeded: boolean, enabled: boolean },
): string | undefined {
  if (env.value === undefined) return undefined
  const retired = 'IRIS_TEMPLATES is retired: Iris’s EJS template engine is now the "Iris EJS templates" row '
    + 'in the plugin center, and that row is the switch.'
  if (state.seeded && seedsTemplateEngine(env)) {
    return `${retired} Because IRIS_TEMPLATES=1 was set and the catalog had no row for it yet, the row was `
      + `turned on once, as if confirmed there (now ${state.enabled ? 'enabled' : 'not enabled'}). `
      + 'Remove the variable; it switches nothing from now on.'
  }
  return `${retired} The row's stored state stands (${state.enabled ? 'enabled' : 'disabled'}) and the variable `
    + `(IRIS_TEMPLATES=${JSON.stringify(env.value)}) was ignored. Remove it.`
}
