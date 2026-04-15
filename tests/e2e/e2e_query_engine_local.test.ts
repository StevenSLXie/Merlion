import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { AssistantResponse, ChatMessage, ModelProvider } from '../../src/types.ts'
import { buildDefaultRegistry } from '../../src/tools/builtin/index.ts'
import { createContextService } from '../../src/context/service.ts'
import { QueryEngine } from '../../src/runtime/query_engine.ts'

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

test('e2e local QueryEngine path creates a file and updates runtime state', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'merlion-e2e-engine-'))
  await mkdir(join(cwd, '.git'))

  try {
    const engine = new QueryEngine({
      cwd,
      provider: new StubProvider([
        {
          role: 'assistant',
          content: null,
          finish_reason: 'tool_calls',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: {
              name: 'create_file',
              arguments: JSON.stringify({ path: 'note.txt', content: 'hello from engine\n' }),
            },
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
        {
          role: 'assistant',
          content: 'Created note.txt.',
          finish_reason: 'stop',
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      ]),
      registry: buildDefaultRegistry({ mode: 'default' }),
      permissions: { ask: async () => 'allow_session' },
      contextService: createContextService({
        cwd,
        permissionMode: 'auto_allow',
      }),
      model: 'stub-model',
    })

    await engine.initialize()
    const result = await engine.submitPrompt('Create note.txt with a greeting.')
    const text = await readFile(join(cwd, 'note.txt'), 'utf8')

    assert.equal(result.terminal, 'completed')
    assert.equal(text, 'hello from engine\n')
    assert.match(result.finalText, /Created note\.txt/)
    assert.equal(engine.getSnapshot().runtimeState.compact.lastSummaryText, 'Created note.txt.')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
