import test from 'node:test'
import assert from 'node:assert/strict'

import type { AssistantResponse, ChatMessage, ModelProvider, ToolCall } from '../src/types.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import type { ToolDefinition } from '../src/tools/types.ts'
import { runLoop } from '../src/runtime/loop.ts'

class StubProvider implements ModelProvider {
  private index = 0
  private readonly responses: AssistantResponse[]

  constructor(responses: AssistantResponse[]) {
    this.responses = responses
  }

  async complete(messages: ChatMessage[]): Promise<AssistantResponse> {
    const response = this.responses[this.index]
    if (!response) throw new Error(`unexpected provider call at index=${this.index}`)
    this.index += 1
    return response
  }
}

function call(name: string, args: Record<string, unknown>, id = 'call_1'): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  }
}

function makeEchoTool(): ToolDefinition {
  return {
    name: 'echo_tool',
    description: 'echoes input',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    concurrencySafe: true,
    async execute(input) {
      return { content: `echo:${String(input.value)}`, isError: false }
    }
  }
}

test('loop executes tool call then completes', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'ok' })],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeEchoTool())

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 5
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'done')
  assert.equal(result.state.messages.some((m) => m.role === 'tool'), true)
})

test('loop handles unknown tool safely', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('not_exists', {})],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'finished',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 5
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'finished')
  const toolMsg = result.state.messages.find((m) => m.role === 'tool')
  assert.ok(toolMsg)
  assert.match(toolMsg?.content ?? '', /Unknown tool/)
})

test('loop returns terminal assistant text', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: 'all good',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 5
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'all good')
})

test('loop accepts initial messages', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: 'continued',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'ignored because initial messages provided',
    userPrompt: '',
    cwd: process.cwd(),
    maxTurns: 5,
    initialMessages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' }
    ],
    persistInitialMessages: false
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'continued')
  assert.equal(result.state.messages.length >= 4, true)
})
