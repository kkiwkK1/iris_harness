/**
 * Facade for `scripts/slash-commands/SlashCommand.js`, served at
 * `<rev>/scripts/slash-commands/SlashCommand.js`. The extension registers
 * `/ejs` and `/ejs-refresh` at init; the pilot accepts the registration
 * (so init completes) but the Iris host has no execution surface for
 * extension-registered commands — the registration is inert and the report
 * records it as a deviation.
 */

export const SlashCommand = {
  fromProps(props: Record<string, unknown>): Record<string, unknown> {
    return { ...props }
  },
}
