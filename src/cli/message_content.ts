import { sanitizeRenderableText } from './sanitize.ts'
import { looksLikeMarkdown, renderMarkdownLines } from './markdown.ts'

export type MessageTone = 'plain' | 'heading' | 'list' | 'quote' | 'code' | 'code_meta' | 'rule' | 'table'

export interface MessageRenderLine {
  tone: MessageTone
  text: string
}

export interface AssistantRenderPlan {
  mode: 'plain' | 'markdown'
  lines: MessageRenderLine[]
}

export function buildAssistantRenderPlan(
  output: string,
  options?: { markdownEnabled?: boolean }
): AssistantRenderPlan {
  const markdownEnabled = options?.markdownEnabled !== false
  if (markdownEnabled && looksLikeMarkdown(output)) {
    return {
      mode: 'markdown',
      lines: renderMarkdownLines(output).map((line) => ({
        tone: line.kind,
        text: line.text
      }))
    }
  }

  const lines = sanitizeRenderableText(output).split('\n').map((text) => ({
    tone: 'plain' as const,
    text
  }))
  return {
    mode: 'plain',
    lines: lines.length > 0 ? lines : [{ tone: 'plain', text: '' }]
  }
}
