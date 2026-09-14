/**
 * Facade for `scripts/slash-commands/SlashCommandArgument.js`. Upstream's
 * enum values are carried verbatim; `fromProps` passes the descriptor through
 * for the inert registration path (see the SlashCommand facade note).
 */

export const ARGUMENT_TYPE = {
  BOOLEAN: 'boolean',
  CLOSURE: 'closure',
  DICTIONARY: 'dictionary',
  NUMBER: 'number',
  RANGE: 'range',
  STRING: 'string',
  SUBCOMMAND: 'subcommand',
  VARIABLE_NAME: 'variable_name',
} as const

export const SlashCommandArgument = {
  fromProps(props: Record<string, unknown>): Record<string, unknown> {
    return { ...props }
  },
}

export const SlashCommandNamedArgument = {
  fromProps(props: Record<string, unknown>): Record<string, unknown> {
    return { ...props }
  },
}
