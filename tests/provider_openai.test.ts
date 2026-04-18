import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'

import { OpenAICompatProvider } from '../src/providers/openai.ts'
import { buildModelToolDescription } from '../src/tools/model_guidance.ts'
import type { ToolDefinition } from '../src/tools/types.ts'

type FetchResponse = {
  ok: boolean
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
}

type FetchMock = (url: string, opts?: RequestInit) => Promise<FetchResponse>

let fetchMock: FetchMock | null = null
const originalFetch = global.fetch

before(() => {
  // @ts-expect-error test stub
  global.fetch = async (url: string, opts?: RequestInit) => {
    if (!fetchMock) throw new Error('fetchMock not set')
    return fetchMock(url, opts)
  }
})

after(() => {
  global.fetch = originalFetch
})

beforeEach(() => {
  fetchMock = null
})

function makeTool(overrides?: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: 'edit_file',
    description: 'Edit an existing file by replacing exact text.',
    modelGuidance: '- Read the file first.\n- Use exact old_string text.',
    modelExamples: ['{"path":"src/app.ts","old_string":"a","new_string":"b"}'],
    guidancePriority: 'critical',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' }
      },
      required: ['old_string', 'new_string']
    },
    concurrencySafe: false,
    execute: async () => ({ content: 'ok', isError: false }),
    ...overrides,
  }
}

test('buildModelToolDescription merges description, guidance, and examples', () => {
  const description = buildModelToolDescription(makeTool())
  assert.match(description, /^Edit an existing file/)
  assert.match(description, /Critical guidance:/)
  assert.match(description, /Read the file first/)
  assert.match(description, /Examples:/)
})

test('OpenAICompatProvider sends merged tool guidance in function description', async () => {
  let capturedBody: any = null
  fetchMock = async (_url, opts) => {
    capturedBody = JSON.parse(String(opts?.body ?? '{}'))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2 }
      }),
      text: async () => ''
    }
  }

  const provider = new OpenAICompatProvider({
    apiKey: 'test',
    baseURL: 'https://example.com/v1',
    model: 'gpt-test'
  })

  const result = await provider.complete(
    [{ role: 'user', content: 'edit the file' }],
    [makeTool()]
  )

  assert.equal(result.content, 'done')
  assert.equal(Array.isArray(capturedBody.tools), true)
  assert.match(capturedBody.tools[0].function.description, /Critical guidance:/)
  assert.match(capturedBody.tools[0].function.description, /Use exact old_string text/)
  assert.match(capturedBody.tools[0].function.description, /Examples:/)
})
