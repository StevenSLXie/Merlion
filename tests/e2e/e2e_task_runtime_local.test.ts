import test from 'node:test'
import assert from 'node:assert/strict'

import type { AssistantResponse, ChatMessage, ModelProvider } from '../../src/types.ts'
import { ToolRegistry } from '../../src/tools/registry.ts'
import { QueryEngine } from '../../src/runtime/query_engine.ts'
import { executeLocalTurn } from '../../src/runtime/local_turn.ts'

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

test('e2e local turn dispatches prompt envelope through QueryEngine', async () => {
  const engine = new QueryEngine({
    cwd: process.cwd(),
    provider: new StubProvider([
      {
        role: 'assistant',
        content: 'handled by local turn',
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
        return { initialItems: [], startupMapSummary: null, generatedMapMode: false }
      },
      async getSystemPrompt() {
        return 'system prompt'
      },
      async buildPromptPrelude() {
        return []
      },
      async buildPathGuidanceItems() {
        return { items: [], loadedFiles: [] }
      },
      async extractCandidatePathsFromText() {
        return []
      },
      async extractCandidatePathsFromToolEvent() {
        return []
      },
    },
  })

  const result = await executeLocalTurn({
    envelope: { kind: 'prompt', text: 'say something' },
    executeShellShortcut: async () => ({ output: 'shell', terminal: 'completed' }),
    executeSlashCommand: async () => ({ output: 'slash', terminal: 'completed' }),
  }, engine)

  assert.equal(result.output, 'handled by local turn')
  assert.equal(result.terminal, 'completed')
})
