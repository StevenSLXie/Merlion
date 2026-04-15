import test from 'node:test'
import assert from 'node:assert/strict'

import type { AssistantResponse, ChatMessage, ModelProvider } from '../../src/types.ts'
import { ToolRegistry } from '../../src/tools/registry.ts'
import { QueryEngine } from '../../src/runtime/query_engine.ts'
import { RuntimeTaskRegistry } from '../../src/runtime/tasks/registry.ts'
import { localTurnTaskHandler } from '../../src/runtime/tasks/handlers/local_turn.ts'
import type { LocalTurnTaskInput, LocalTurnTaskOutput } from '../../src/runtime/tasks/types.ts'

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

test('e2e local task runtime dispatches prompt envelope through QueryEngine', async () => {
  const tasks = new RuntimeTaskRegistry()
  tasks.register(localTurnTaskHandler)
  const handler = tasks.get<LocalTurnTaskInput, LocalTurnTaskOutput>('local_turn')
  assert.ok(handler)

  const engine = new QueryEngine({
    cwd: process.cwd(),
    provider: new StubProvider([
      {
        role: 'assistant',
        content: 'handled by task runtime',
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ]),
    registry: new ToolRegistry(),
    permissions: { ask: async () => 'allow_session' },
    contextService: {
      getTrustLevel: () => 'trusted',
      getPathGuidanceState: () => ({ loadedAgentFiles: new Set<string>() }),
      getGeneratedMapMode: () => false,
      setGeneratedMapMode() {},
      async prefetchIfSafe() {
        return { initialMessages: [], startupMapSummary: null, generatedMapMode: false }
      },
      async getSystemPrompt() {
        return 'system prompt'
      },
      async buildPromptPrelude() {
        return []
      },
      async buildPathGuidanceMessages() {
        return { messages: [], loadedFiles: [] }
      },
      async extractCandidatePathsFromText() {
        return []
      },
      async extractCandidatePathsFromToolEvent() {
        return []
      },
    },
  })

  const result = await handler!.run({
    envelope: { kind: 'prompt', text: 'say something' },
    executeShellShortcut: async () => ({ output: 'shell', terminal: 'completed' }),
    executeSlashCommand: async () => ({ output: 'slash', terminal: 'completed' }),
  }, { engine })

  assert.equal(result.output, 'handled by task runtime')
  assert.equal(result.terminal, 'completed')
})
