/**
 * Facade for `scripts/openai.js`, served at `<rev>/scripts/openai.js`. The
 * extension reads `oai_settings.prompts` for the `getpreset` helper and the
 * chat-completion model name; the pilot preset surface is empty, so `getpreset`
 * resolves to nothing rather than fabricating prompt text.
 */

export const oai_settings: {
  prompts: Array<{ name: string, content: string, [key: string]: unknown }>
  [key: string]: unknown
} = {
  prompts: [],
}

export function getChatCompletionModel(): string {
  return 'iris-compat-model'
}
