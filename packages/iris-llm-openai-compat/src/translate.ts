/**
 * Translate OpenAI-compatible wire chunks into the harness `StreamChunk`
 * protocol, keeping one open block per content / reasoning / tool-call index.
 *
 * Block ends, usage, and finish are all deferred to `[DONE]` so no chunk can
 * ever follow `finish`, and both usage shapes (attached to the finish chunk,
 * or a trailing usage-only chunk) are covered.
 */

import { CallId, EMPTY_RESPONSE_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { DONE } from './sse.ts'

/** Usage as OpenAI-compatible endpoints report it. */
export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** One streamed chunk of an OpenAI-compatible chat completion. */
export interface WireChunk {
  choices?: {
    delta?: {
      content?: string | null
      /** Present on reasoning models (DeepSeek, and increasingly others). */
      reasoning_content?: string | null
      tool_calls?: {
        index: number
        id?: string
        function?: { name?: string, arguments?: string }
      }[]
    }
    finish_reason?: string | null
  }[]
  usage?: WireUsage | null
}

/** One block under assembly. */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
}

/**
 * Map the wire `finish_reason` vocabulary onto the harness `FinishReason`.
 * @param reason - the wire value.
 * @returns the mapped reason; unrecognized values become an error finish carrying the uppercased value as `code`.
 */
export function mapFinishReason(reason: string): FinishReason {
  switch (reason) {
    case 'stop': return { kind: 'stop' }
    case 'tool_calls': case 'function_call': return { kind: 'tool-calls' }
    case 'length': return { kind: 'max-tokens' }
    default:
      return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } }
  }
}

/**
 * Map wire usage onto the harness convention.
 *
 * OpenAI-compatible `prompt_tokens` INCLUDES cached tokens, while the harness
 * `TokenUsage` counts are disjoint — so cache reads are subtracted out.
 * @param usage - wire usage from either the finish chunk or a trailing usage-only chunk.
 * @returns disjoint harness counts.
 */
export function mapUsage(usage: WireUsage): TokenUsage {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  const combined = usage.prompt_tokens + usage.completion_tokens
  const hasExactTotal = Number.isSafeInteger(combined)
    && usage.prompt_tokens >= 0
    && usage.completion_tokens >= 0
    && (usage.total_tokens === undefined || usage.total_tokens === combined)
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...hasExactTotal ? { totalTokens: combined } : {},
    ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
  }
}

/** Assemble the final ContentBlock for one open block. */
function closeBlock(block: OpenBlock): ContentBlock {
  switch (block.kind) {
    case 'text': return { type: 'text', text: block.text }
    case 'reasoning': return { type: 'reasoning', text: block.text }
    case 'tool-call': return {
      type: 'tool-call',
      id: CallId(block.callId ?? ''),
      name: block.name ?? '',
      arguments: block.text,
    }
  }
}

/**
 * Consume `[DONE]`-terminated SSE payloads and yield harness stream chunks.
 * @param payloads - SSE data payloads from `parseSse`.
 * @returns deltas as they arrive; block ends, usage, and finish deferred to `[DONE]`.
 */
export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  let nextIndex = 0
  let textBlock: OpenBlock | undefined
  let reasoningBlock: OpenBlock | undefined
  const toolBlocks = new Map<number, OpenBlock>()
  const order: OpenBlock[] = []
  let pendingFinish: FinishReason | undefined
  let pendingUsage: TokenUsage | undefined

  const open = (kind: OpenBlock['kind']): OpenBlock => {
    const block: OpenBlock = { index: nextIndex++, kind, text: '' }
    order.push(block)
    return block
  }

  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) yield { type: 'block-end', index: block.index, block: closeBlock(block) }
      if (pendingUsage) yield { type: 'usage', usage: pendingUsage }
      const reason = pendingFinish ?? { kind: 'stop' as const }
      yield {
        type: 'finish',
        reason: reason.kind === 'stop' && order.length === 0
          ? {
              kind: 'error',
              failure: { message: 'model returned a completed response with no content', code: EMPTY_RESPONSE_CODE },
            }
          : reason,
      }
      return
    }

    let chunk: WireChunk
    try {
      chunk = JSON.parse(payload) as WireChunk
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE')
    }

    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta

      // Reasoning first: thinking models interleave it ahead of visible text.
      // An empty first delta must not open a block.
      const reasoning = delta?.reasoning_content
      if (typeof reasoning === 'string' && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open('reasoning')
          yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
        }
        reasoningBlock.text += reasoning
        yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning }
      }

      const content = delta?.content
      if (typeof content === 'string' && content.length > 0) {
        if (!textBlock) {
          textBlock = open('text')
          yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
        }
        textBlock.text += content
        yield { type: 'text-delta', index: textBlock.index, text: content }
      }

      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index)
        if (!block) {
          block = open('tool-call')
          toolBlocks.set(call.index, block)
          yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        }
        if (call.id !== undefined) block.callId = call.id
        if (call.function?.name !== undefined) block.name = call.function.name
        const fragment = call.function?.arguments ?? ''
        block.text += fragment
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: CallId(block.callId ?? ''),
          ...block.name !== undefined ? { name: block.name } : {},
          argumentsDelta: fragment,
        }
      }

      if (typeof choice.finish_reason === 'string') pendingFinish = mapFinishReason(choice.finish_reason)
    }

    if (chunk.usage) pendingUsage = mapUsage(chunk.usage)
  }

  throw new LlmError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED')
}
