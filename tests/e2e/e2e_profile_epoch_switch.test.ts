import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { AssistantResponse, ChatMessage, ModelProvider } from '../../src/types.ts'
import type { ToolDefinition } from '../../src/tools/types.ts'
import { buildDefaultRegistry } from '../../src/tools/builtin/index.ts'
import { QueryEngine } from '../../src/runtime/query_engine.ts'

class RecordingProvider implements ModelProvider {
  readonly seenToolNames: string[][] = []
  private index = 0
  private readonly responses: AssistantResponse[]

  constructor(responses: AssistantResponse[]) {
    this.responses = responses
  }

  async complete(_messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse> {
    this.seenToolNames.push(tools.map((tool) => tool.name))
    const response = this.responses[this.index]
    if (!response) throw new Error(`unexpected provider call at index=${this.index}`)
    this.index += 1
    return response
  }
}

function makeContextService() {
  return {
    getTrustLevel: () => 'trusted' as const,
    getPathGuidanceState: () => ({ loadedAgentFiles: new Set<string>() }),
    getGeneratedMapMode: () => false,
    setGeneratedMapMode() {},
    async prefetchIfSafe() {
      return { startupMapSummary: null, generatedMapMode: false, initialItems: [] }
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
  }
}

test('e2e local explicit profile switch changes schema only at the boundary and records the reason', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'merlion-e2e-profile-epoch-'))
  const usageEntries: Array<{
    toolSchemaHash: string | null
    schemaChangeReason: string | null
  }> = []

  try {
    const provider = new RecordingProvider([
      {
        role: 'assistant',
        content: 'Initial analysis.',
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      {
        role: 'assistant',
        content: 'Verification plan.',
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ])

    const engine = new QueryEngine({
      cwd,
      provider,
      registry: buildDefaultRegistry({ mode: 'default' }),
      permissions: { ask: async () => 'allow' },
      contextService: makeContextService(),
      persistUsage: async (entry) => {
        usageEntries.push({
          toolSchemaHash: entry.promptObservability?.tool_schema_hash ?? null,
          schemaChangeReason: entry.promptObservability?.schema_change_reason ?? null,
        })
      },
      model: 'test-model',
    })

    await engine.submitPrompt('Analyze this module and summarize its weaknesses.')
    await engine.submitPrompt('Verify the fix by running the relevant tests now.')

    assert.equal(provider.seenToolNames.length, 2)
    assert.equal(usageEntries.length, 2)
    assert.equal(provider.seenToolNames[0]?.includes('bash'), false)
    assert.equal(provider.seenToolNames[1]?.includes('bash'), true)
    assert.equal(provider.seenToolNames[1]?.includes('run_script'), true)
    assert.notDeepEqual(provider.seenToolNames[1], provider.seenToolNames[0])
    assert.equal(usageEntries[0]?.schemaChangeReason, 'initial_epoch')
    assert.equal(usageEntries[1]?.schemaChangeReason, 'phase_switch')
    assert.notEqual(usageEntries[1]?.toolSchemaHash, usageEntries[0]?.toolSchemaHash)

    const snapshot = engine.getSnapshot()
    assert.equal(snapshot.runtimeState.task.capabilityProfile, 'verification_readonly')
    assert.equal(snapshot.runtimeState.task.profileEpoch.epoch, 2)
    assert.equal(snapshot.runtimeState.task.profileEpoch.lastSchemaChangeReason, 'phase_switch')
    assert.equal(snapshot.runtimeState.task.currentTask?.kind, 'verification')
    assert.equal(snapshot.runtimeState.task.mutationPolicy?.mayMutateFiles, false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
