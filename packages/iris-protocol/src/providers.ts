/**
 * The provider presets the connection form offers, and the one place both
 * halves agree on what each preset means.
 *
 * The form does not let a user type a provider as a bare string, because a
 * provider is not a name — it is an endpoint, a credential convention and a
 * default header. Measured on the user's own install, the profile named
 * `deepseek deepseek-chat` actually pointed at Gemini through a different
 * endpoint; a free-text provider field is how that drift starts. A preset
 * pins the endpoint the moment it is chosen, so the only thing left to type
 * is the key and the model.
 *
 * Display copy lives in the interface's i18n tables, keyed by {@link ProviderPreset.id};
 * this file carries only what the **host** also needs to judge a connection:
 * the endpoint, whether it cannot work without a key, and which header the
 * key is sent in.
 *
 * @module iris-protocol/providers
 */

/** One provider the connection form offers as a preset. */
export interface ProviderPreset {
  /** Machine id — also the `provider` route a profile saved from this preset carries. */
  id: string
  /**
   * The endpoint root the preset fills the form with; `/chat/completions` and
   * `/models` are appended. Empty for `custom`, where the endpoint is the
   * user's to type.
   */
  baseURL: string
  /**
   * True when the endpoint is known to refuse unauthenticated calls. The host
   * uses this to answer `connection.test` with `missing-key` **before** any
   * request leaves, so a forgotten key reads as the named mistake it is
   * rather than as a generic 401 from somewhere.
   */
  requiresKey: boolean
  /**
   * The header the credential is sent in. Absent means the OpenAI-compatible
   * convention: `Authorization: Bearer <key>`. A preset may name another
   * header (`x-api-key` for Anthropic), which is then sent as a bare value.
   */
  apiKeyHeader?: string
  /**
   * True for a loopback endpoint on the user's own machine — Ollama, llama.cpp,
   * LM Studio. The interface shows "no key needed" instead of a key field's
   * usual placeholder, and the host does not require one.
   */
  local?: boolean
}

/** DeepSeek's own API. */
export const DEEPSEEK: ProviderPreset = {
  id: 'deepseek',
  baseURL: 'https://api.deepseek.com/v1',
  requiresKey: true,
}

/** OpenAI's first-party API. */
export const OPENAI: ProviderPreset = {
  id: 'openai',
  baseURL: 'https://api.openai.com/v1',
  requiresKey: true,
}

/** OpenRouter's aggregator API. */
export const OPENROUTER: ProviderPreset = {
  id: 'openrouter',
  baseURL: 'https://openrouter.ai/api/v1',
  requiresKey: true,
}

/** Anthropic. Native credential header, not the Bearer convention. */
export const ANTHROPIC: ProviderPreset = {
  id: 'anthropic',
  baseURL: 'https://api.anthropic.com/v1',
  requiresKey: true,
  apiKeyHeader: 'x-api-key',
}

/** Google AI Studio's OpenAI-compatible endpoint. */
export const GEMINI: ProviderPreset = {
  id: 'gemini',
  baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
  requiresKey: true,
}

/** A local Ollama serve. Loopback, unauthenticated. */
export const OLLAMA: ProviderPreset = {
  id: 'ollama',
  baseURL: 'http://127.0.0.1:11434/v1',
  requiresKey: false,
  local: true,
}

/** A local llama.cpp server. Loopback, unauthenticated. */
export const LLAMA_CPP: ProviderPreset = {
  id: 'llama.cpp',
  baseURL: 'http://127.0.0.1:8080/v1',
  requiresKey: false,
  local: true,
}

/** A local LM Studio serve. Loopback, unauthenticated. */
export const LM_STUDIO: ProviderPreset = {
  id: 'lmstudio',
  baseURL: 'http://127.0.0.1:1234/v1',
  requiresKey: false,
  local: true,
}

/** Anything else: the user types the endpoint themselves. */
export const CUSTOM: ProviderPreset = {
  id: 'custom',
  baseURL: '',
  requiresKey: false,
}

/** The presets the connection form offers, in display order. */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  DEEPSEEK,
  OPENAI,
  OPENROUTER,
  ANTHROPIC,
  GEMINI,
  OLLAMA,
  LLAMA_CPP,
  LM_STUDIO,
  CUSTOM,
]

/**
 * Look a preset up by id.
 * @param id - the preset id, as stored in a profile's `provider`.
 * @returns the preset, or undefined when the id is not one of the offers —
 * a profile saved before presets existed carries route keys like `default`,
 * and that is a profile on the host's own route, not a broken one.
 */
export function providerPreset(id: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find(preset => preset.id === id)
}
