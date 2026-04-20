import { after, before, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'

import { OpenAIResponsesProvider } from '../src/providers/openai_responses.ts'
import type { ToolDefinition } from '../src/tools/types.ts'
import { createAssistantItem, createExternalUserItem, createFunctionCallOutputItem, createSystemItem } from '../src/runtime/items.ts'

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

function makeTool(): ToolDefinition {
  return {
    name: 'read_file',
    description: 'Read a file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    concurrencySafe: true,
    execute: async () => ({ content: 'ok', isError: false }),
  }
}

test('OpenAIResponsesProvider sends internally-tagged function tools and item input', async () => {
  let capturedBody: any = null
  fetchMock = async (_url, opts) => {
    capturedBody = JSON.parse(String(opts?.body ?? '{}'))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'resp_123',
        output: [
          {
            type: 'function_call',
            id: 'fc_1',
            call_id: 'call_1',
            name: 'read_file',
            arguments: '{"path":"src/app.ts"}',
          }
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      text: async () => '',
    }
  }

  const provider = new OpenAIResponsesProvider({
    apiKey: 'test',
    baseURL: 'https://example.com/v1',
    model: 'gpt-test',
  })

  const result = await provider.completeItems(
    [
      createSystemItem('system', 'static'),
      createExternalUserItem('read src/app.ts'),
      createFunctionCallOutputItem('call_prev', 'previous output'),
    ],
    [makeTool()]
  )

  assert.equal(capturedBody.tools[0].type, 'function')
  assert.equal(capturedBody.tools[0].name, 'read_file')
  assert.equal(capturedBody.input[0].type, 'message')
  assert.equal(capturedBody.input[2].type, 'function_call_output')
  assert.equal(result.finishReason, 'tool_calls')
  assert.equal(result.outputItems[0]?.kind, 'function_call')
  assert.equal(result.providerResponseId, 'resp_123')
  assert.equal(result.responseBoundary?.providerResponseId, 'resp_123')
})

test('OpenAIResponsesProvider replays assistant history as input_text message content', async () => {
  let capturedBody: any = null
  fetchMock = async (_url, opts) => {
    capturedBody = JSON.parse(String(opts?.body ?? '{}'))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'resp_456',
        output: [
          {
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done' }],
          }
        ],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      text: async () => '',
    }
  }

  const provider = new OpenAIResponsesProvider({
    apiKey: 'test',
    baseURL: 'https://example.com/v1',
    model: 'gpt-test',
  })

  await provider.completeItems(
    [
      createSystemItem('system', 'static'),
      createExternalUserItem('task'),
      createAssistantItem('previous assistant answer'),
    ],
    []
  )

  assert.equal(capturedBody.input[2].type, 'message')
  assert.equal(capturedBody.input[2].role, 'assistant')
  assert.equal(capturedBody.input[2].content[0].type, 'input_text')
  assert.equal(capturedBody.input[2].content[0].text, 'previous assistant answer')
})
