import type { MessageView } from '@iris/protocol'
import { groupByTurn } from './project.ts'
import { plainText } from './plain-text.ts'

export interface TurnNavigationItem {
  key: string
  ordinal: number
  start: number
  prompt: string
  response: string
}

/** Remove code/interface blocks: navigation previews describe prose, not source. */
function withoutFencedBlocks(source: string): string {
  const prose: string[] = []
  let fence: { char: string, length: number } | undefined
  for (const line of source.split(/\r?\n/)) {
    const marker = /^\s*([~`]{3,})/.exec(line)?.[1]
    if (fence !== undefined) {
      if (marker?.[0] === fence.char && marker.length >= fence.length) fence = undefined
      continue
    }
    if (marker !== undefined) {
      fence = { char: marker[0] ?? '', length: marker.length }
      continue
    }
    prose.push(line)
  }
  return prose.join('\n')
}

/** Text only: previews never mount card HTML or execute its scripts. */
function excerpt(text: string): string {
  const prose = withoutFencedBlocks(text)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
  return plainText(prose).replace(/\s+/g, ' ').trim().slice(0, 240)
}

/** Include greetings and unnumbered messages, anchored by stable message key. */
export function turnNavigation(messages: readonly MessageView[]): TurnNavigationItem[] {
  let start = 0
  return groupByTurn(messages).map((group, index) => {
    const item = {
      key: group.messages[0]!.key,
      ordinal: index + 1,
      start,
      prompt: excerpt(group.messages.find(message => message.role === 'user')?.text ?? ''),
      response: excerpt(group.messages.find(message => message.role === 'assistant')?.text ?? ''),
    }
    start += group.messages.length
    return item
  })
}
