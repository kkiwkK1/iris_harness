/**
 * Facade for `scripts/slash-commands/SlashCommandParser.js`. Registrations are
 * accepted and recorded (the extension registers two commands at init), but
 * nothing executes them — the pilot has no host-side execution surface for
 * extension-registered commands. The report's deviation table carries this.
 */

const registered: Array<Record<string, unknown>> = []

export const SlashCommandParser = {
  addCommandObject(command: Record<string, unknown>): Record<string, unknown> {
    registered.push(command)
    console.info(`[iris-st-compat] slash command "/${String(command['name'] ?? '?')}" registered inertly (pilot has no execution surface)`)
    return command
  },
  /** Exposed for tests and diagnostics only. */
  registeredCommands(): ReadonlyArray<Record<string, unknown>> {
    return registered
  },
}
