import test from 'node:test'
import assert from 'node:assert/strict'

import type { AssistantResponse, ChatMessage, ModelProvider } from '../../src/types.ts'
import { buildDefaultRegistry } from '../../src/tools/builtin/index.ts'
import { runLoop } from '../../src/runtime/loop.ts'

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

test('e2e local ask_user_question flow resumes after answer injection', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: {
          name: 'ask_user_question',
          arguments: JSON.stringify({
            questions: [
              {
                header: 'Target',
                id: 'target',
                question: 'What should I focus on?',
                options: [
                  { label: 'Tests', description: 'stability first' },
                  { label: 'Feature', description: 'ship faster' },
                ],
              },
            ],
          }),
        },
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    {
      role: 'assistant',
      content: 'I will focus on tests.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ])

  const result = await runLoop({
    provider,
    registry: buildDefaultRegistry({ mode: 'default' }),
    systemPrompt: 'You are Merlion.',
    userPrompt: 'Ask what to focus on.',
    cwd: process.cwd(),
    maxTurns: 5,
    askQuestions: async () => ({ target: 'Tests' }),
  })

  assert.equal(result.terminal, 'completed')
  assert.match(result.finalText, /focus on tests/i)
  assert.equal(result.state.messages.some((message) => message.role === 'tool' && /"target": "Tests"/.test(message.content ?? '')), true)
})
