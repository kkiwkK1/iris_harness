/**
 * Serialize harness messages and sampling into an OpenAI-compatible request body.
 *
 * Scope note: this spike serializes text only. Reasoning blocks are dropped on
 * the way out (a model must not be fed its own thinking back), and tool blocks
 * are out of scope because the roleplay loop does not call tools.
 */

import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

/**
 * Sampling knobs SillyTavern users expect, which `GenerateOptions` does not
 * carry (it stops at temperature/maxTokens/stop).
 *
 * Declaring them here is the spike's test of the plan's key assumption: that a
 * downstream package can widen the request type and have the extra fields
 * survive the trip to its own adapter.
 */
export interface IrisSampling {
  topP?: number
  topK?: number
  minP?: number
  repetitionPenalty?: number
  frequencyPenalty?: number
  presencePenalty?: number
  seed?: number
}

declare module '@deepseek-ai/dsh-llm' {
  interface GenerateOptions {
    /** Sampling beyond the harness's own six fields. */
    sampling?: IrisSampling
  }
}

/** One OpenAI-compatible chat message. */
interface WireMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Concatenate the text blocks of one message. */
function textOf(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Build the wire message array, prepending the assembled system prompt.
 * @param options - the assembled harness request.
 * @returns messages in provider order.
 */
export function serializeMessages(options: GenerateOptions): WireMessage[] {
  const messages: WireMessage[] = []
  if (options.system !== undefined && options.system.length > 0) {
    messages.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages) {
    const content = textOf(message)
    // A message whose blocks are all non-text carries nothing this spike can send.
    if (content.length === 0) continue
    messages.push({ role: message.role, content })
  }
  return messages
}

/**
 * Build the full request body, mapping both the harness's own call config and
 * the Iris sampling extension onto OpenAI-compatible field names.
 * @param options - the assembled harness request.
 * @returns the JSON body to POST.
 */
export function serializeRequest(options: GenerateOptions): Record<string, unknown> {
  const sampling = options.sampling ?? {}
  return {
    model: options.model,
    messages: serializeMessages(options),
    stream: true,
    stream_options: { include_usage: true },
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {},
    ...options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {},
    ...sampling.topP !== undefined ? { top_p: sampling.topP } : {},
    ...sampling.topK !== undefined ? { top_k: sampling.topK } : {},
    ...sampling.minP !== undefined ? { min_p: sampling.minP } : {},
    ...sampling.repetitionPenalty !== undefined ? { repetition_penalty: sampling.repetitionPenalty } : {},
    ...sampling.frequencyPenalty !== undefined ? { frequency_penalty: sampling.frequencyPenalty } : {},
    ...sampling.presencePenalty !== undefined ? { presence_penalty: sampling.presencePenalty } : {},
    ...sampling.seed !== undefined ? { seed: sampling.seed } : {},
  }
}
