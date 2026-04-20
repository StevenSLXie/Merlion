import test from 'node:test'
import assert from 'node:assert/strict'

import type { AssistantResponse, ChatMessage, ModelProvider, ToolCall } from '../src/types.ts'
import type { ConversationItem } from '../src/runtime/items.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import type { ToolDefinition } from '../src/tools/types.ts'
import { QueryEngine } from '../src/runtime/query_engine.ts'

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

function call(name: string, args: Record<string, unknown>, id = 'call_1'): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

function makeApprovalTool(): ToolDefinition {
  return {
    name: 'needs_approval',
    description: 'tool that asks for permission',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    concurrencySafe: false,
    async execute(input, ctx) {
      const decision = await ctx.permissions?.ask('write_file', `Write: ${String(input.path)}`)
      if (decision === 'deny') {
        return { content: '[Permission denied]', isError: true }
      }
      return { content: 'ok', isError: false }
    },
  }
}

test('QueryEngine initializes bootstrap context and tracks permission denials', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('needs_approval', { path: 'README.md' })],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    {
      role: 'assistant',
      content: 'Permission was denied for the README update request.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ])

  const registry = new ToolRegistry()
  registry.register(makeApprovalTool())
  const persisted: ConversationItem[] = []
  const engine = new QueryEngine({
    cwd: process.cwd(),
    provider,
    registry,
    permissions: { ask: async () => 'deny' },
    contextService: {
      getTrustLevel: () => 'trusted',
      getPathGuidanceState: () => ({ loadedAgentFiles: new Set<string>() }),
      getGeneratedMapMode: () => false,
      setGeneratedMapMode() {},
      async prefetchIfSafe() {
        return {
          startupMapSummary: 'generated project map up to date (1 scope)',
          generatedMapMode: false,
          initialMessages: [
            { role: 'system', content: 'bootstrap orientation' },
          ],
        }
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
    persistItem: async (item) => {
      persisted.push(item)
    },
    model: 'test-model',
  })

  await engine.initialize()
  assert.equal(engine.getStartupMapSummary(), 'generated project map up to date (1 scope)')

  const result = await engine.submitPrompt('update the readme')
  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'Permission was denied for the README update request.')

  const snapshot = engine.getSnapshot()
  assert.equal(snapshot.runtimeState.permissions.deniedToolNames.includes('write_file'), true)
  assert.equal(snapshot.runtimeState.compact.lastSummaryText, 'Permission was denied for the README update request.')
  assert.equal('skills' in (snapshot.runtimeState as unknown as Record<string, unknown>), false)
  assert.equal('memory' in (snapshot.runtimeState as unknown as Record<string, unknown>), false)
  assert.equal(persisted[0]?.kind, 'message')
  assert.equal(persisted[0] && 'content' in persisted[0] ? persisted[0].content : '', 'system prompt')
  assert.equal(persisted[1] && 'content' in persisted[1] ? persisted[1].content : '', 'bootstrap orientation')
})
