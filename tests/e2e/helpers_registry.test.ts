import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { runLoop } from '../../src/runtime/loop.ts'
import type { AssistantResponse, ChatMessage, ModelProvider } from '../../src/types.ts'
import { buildDefaultRegistry } from '../../src/tools/builtin/index.ts'
import { makeRegistry, makeSandbox, rmSandbox, SYSTEM_PROMPT } from './helpers.ts'

const readonlyQuestionNames = buildDefaultRegistry({
  mode: 'default',
  profile: 'readonly_question',
}).getAll().map((tool) => tool.name)

function expectedScenarioNames(extraToolName: string): string[] {
  return buildDefaultRegistry({
    mode: 'default',
    includeNames: [...readonlyQuestionNames, extraToolName],
  }).getAll().map((tool) => tool.name)
}

class StubProvider implements ModelProvider {
  private index = 0
  private readonly responses: AssistantResponse[]

  constructor(responses: AssistantResponse[]) {
    this.responses = responses
  }

  async complete(_messages: ChatMessage[]): Promise<AssistantResponse> {
    const response = this.responses[this.index]
    if (!response) throw new Error(`unexpected provider call at index=${this.index}`)
    this.index += 1
    return response
  }
}

async function runScenarioLoop(
  scenario: string,
  cwd: string,
  userPrompt: string,
  responses: AssistantResponse[],
) {
  return await runLoop({
    provider: new StubProvider(responses),
    registry: makeRegistry({ scenario }),
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    cwd,
    maxTurns: 10,
    permissions: { ask: async () => 'allow_session' },
  })
}

test('targeted budget-regression E2E scenarios reuse readonly profile narrowing', () => {
  for (const scenario of ['e2e-read', 'e2e-tool-error']) {
    const names = makeRegistry({ scenario }).getAll().map((tool) => tool.name)
    assert.deepEqual(names, readonlyQuestionNames, `${scenario} should use readonly_question tools`)
  }
})

test('search scenario keeps only the search tool to avoid alternate read paths', () => {
  const names = makeRegistry({ scenario: 'e2e-search' }).getAll().map((tool) => tool.name)
  assert.deepEqual(names, ['search'])
})

test('edit scenario keeps only read_file and edit_file', () => {
  const names = makeRegistry({ scenario: 'e2e-edit' }).getAll().map((tool) => tool.name)
  assert.deepEqual(names, ['read_file', 'edit_file'])
  assert.equal(names.includes('create_file'), false)
  assert.equal(names.includes('write_file'), false)
})

test('multi-tool scenario adds only create_file to the readonly question tool set', () => {
  const names = makeRegistry({ scenario: 'e2e-multi-tool' }).getAll().map((tool) => tool.name)
  assert.deepEqual(names, expectedScenarioNames('create_file'))
  assert.equal(names.includes('edit_file'), false)
  assert.equal(names.includes('write_file'), false)
})

test('non-targeted scenarios keep the default registry behavior', () => {
  const defaultNames = buildDefaultRegistry({ mode: 'default' }).getAll().map((tool) => tool.name)
  const names = makeRegistry({ scenario: 'e2e-create' }).getAll().map((tool) => tool.name)
  assert.deepEqual(names, defaultNames)
})

test('readonly targeted registries still support read/search/tool-error flows locally', async () => {
  const cases: Array<{
    scenario: string
    task: string
    responses: AssistantResponse[]
    expectedText: RegExp
  }> = [
    {
      scenario: 'e2e-read',
      task: 'Read hello.txt and report the line count.',
      responses: [
        {
          role: 'assistant',
          content: null,
          finish_reason: 'tool_calls',
          tool_calls: [{
            id: 'call_read',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'hello.txt' }),
            },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        {
          role: 'assistant',
          content: 'hello.txt contains 3 lines.',
          finish_reason: 'stop',
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      ],
      expectedText: /\b3\b/,
    },
    {
      scenario: 'e2e-search',
      task: 'Use search to find exported functions in math.ts.',
      responses: [
        {
          role: 'assistant',
          content: null,
          finish_reason: 'tool_calls',
          tool_calls: [{
            id: 'call_search',
            type: 'function',
            function: {
              name: 'search',
              arguments: JSON.stringify({ pattern: 'export function', path: 'math.ts' }),
            },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        {
          role: 'assistant',
          content: 'I found add and multiply.',
          finish_reason: 'stop',
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      ],
      expectedText: /add.*multiply|multiply.*add/,
    },
    {
      scenario: 'e2e-tool-error',
      task: 'Try to read does_not_exist.txt and tell me the error.',
      responses: [
        {
          role: 'assistant',
          content: null,
          finish_reason: 'tool_calls',
          tool_calls: [{
            id: 'call_missing',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'does_not_exist.txt' }),
            },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        {
          role: 'assistant',
          content: 'The file does not exist.',
          finish_reason: 'stop',
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      ],
      expectedText: /does not exist/,
    },
  ]

  for (const testCase of cases) {
    const sandbox = await makeSandbox()
    try {
      const result = await runScenarioLoop(testCase.scenario, sandbox, testCase.task, testCase.responses)
      assert.equal(result.terminal, 'completed')
      assert.match(result.finalText, testCase.expectedText)
    } finally {
      await rmSandbox(sandbox)
    }
  }
})

test('edit targeted registry supports read and edit mutations locally', async () => {
  const sandbox = await makeSandbox()
  try {
    const result = await runScenarioLoop(
      'e2e-edit',
      sandbox,
      'Append subtract to math.ts.',
      [
        {
          role: 'assistant',
          content: null,
          finish_reason: 'tool_calls',
          tool_calls: [{
            id: 'call_read_math',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'math.ts' }),
            },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        {
          role: 'assistant',
          content: null,
          finish_reason: 'tool_calls',
          tool_calls: [{
            id: 'call_edit_math',
            type: 'function',
            function: {
              name: 'edit_file',
              arguments: JSON.stringify({
                path: 'math.ts',
                old_string: 'export function multiply(a: number, b: number): number {\n  return a * b\n}\n',
                new_string:
                  'export function multiply(a: number, b: number): number {\n  return a * b\n}\n\n' +
                  'export function subtract(a: number, b: number): number {\n  return a - b\n}\n',
              }),
            },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        {
          role: 'assistant',
          content: 'Added subtract to math.ts.',
          finish_reason: 'stop',
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        {
          role: 'assistant',
          content: 'Added subtract to math.ts. Validation was not run in this stubbed local helper test.',
          finish_reason: 'stop',
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      ],
    )

    const content = await readFile(join(sandbox, 'math.ts'), 'utf8')
    assert.equal(result.terminal, 'completed')
    assert.match(content, /export function subtract/)
    assert.match(content, /return a - b/)
  } finally {
    await rmSandbox(sandbox)
  }
})

test('multi-tool targeted registry supports read and create flows locally', async () => {
  const sandbox = await makeSandbox()
  try {
    const result = await runScenarioLoop(
      'e2e-multi-tool',
      sandbox,
      'Copy the first hello.txt line into output.txt.',
      [
        {
          role: 'assistant',
          content: null,
          finish_reason: 'tool_calls',
          tool_calls: [{
            id: 'call_read_hello',
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: 'hello.txt' }),
            },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        {
          role: 'assistant',
          content: null,
          finish_reason: 'tool_calls',
          tool_calls: [{
            id: 'call_create_output',
            type: 'function',
            function: {
              name: 'create_file',
              arguments: JSON.stringify({
                path: 'output.txt',
                content: 'Hello from Merlion fixture file.',
              }),
            },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        {
          role: 'assistant',
          content: 'Created output.txt with the first line.',
          finish_reason: 'stop',
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      ],
    )

    const content = await readFile(join(sandbox, 'output.txt'), 'utf8')
    assert.equal(result.terminal, 'completed')
    assert.equal(content, 'Hello from Merlion fixture file.')
  } finally {
    await rmSandbox(sandbox)
  }
})
