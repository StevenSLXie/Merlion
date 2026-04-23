import type { ToolDefinition } from '../types.js'
import { authorizeNetworkAccess } from './fs_common.ts'

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncate(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content
  return `${content.slice(0, maxLength)}\n[content truncated]`
}

export const fetchTool: ToolDefinition = {
  name: 'fetch',
  description: 'Fetch content from a URL. Returns text content.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string' },
      max_length: { type: 'integer' }
    },
    required: ['url']
  },
  concurrencySafe: true,
  async execute(input, ctx) {
    const rawUrl = input.url
    const maxLengthRaw = input.max_length
    const maxLength = typeof maxLengthRaw === 'number' && Number.isFinite(maxLengthRaw)
      ? Math.max(1, Math.floor(maxLengthRaw))
      : 20_000

    if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
      return { content: 'Invalid URL: expected non-empty string.', isError: true }
    }

    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return { content: `Invalid URL: ${rawUrl}`, isError: true }
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { content: 'Only http/https URLs are allowed.', isError: true }
    }

    const authorization = await authorizeNetworkAccess(ctx, 'fetch', `Fetch URL: ${parsed.toString()}`)
    if (!authorization.ok) {
      return { content: authorization.error, isError: true }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)

    try {
      const response = await fetch(parsed, { signal: controller.signal })
      const type = response.headers.get('content-type') ?? 'application/octet-stream'
      const rawBody = await response.text()

      let content: string
      if (type.includes('application/json')) {
        try {
          content = JSON.stringify(JSON.parse(rawBody), null, 2)
        } catch {
          content = rawBody
        }
      } else if (type.includes('text/html')) {
        content = stripHtml(rawBody)
      } else if (type.startsWith('text/')) {
        content = rawBody
      } else {
        content = `[Binary content not shown. Content-Type: ${type}]`
      }

      return {
        content: `URL: ${parsed.toString()}\nStatus: ${response.status}\n\n${truncate(content, maxLength)}`,
        isError: false
      }
    } catch (error) {
      return { content: `Fetch failed: ${String(error)}`, isError: true }
    } finally {
      clearTimeout(timeout)
    }
  }
}
