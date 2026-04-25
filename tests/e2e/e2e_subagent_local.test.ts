import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { AssistantResponse, ChatMessage, ModelProvider, ToolCall } from '../../src/types.ts'
import { QueryEngine } from '../../src/runtime/query_engine.ts'
import { createAssistantItem, createExternalUserItem, createSystemItem, itemsToMessages } from '../../src/runtime/items.ts'
import { buildDefaultRegistry } from '../../src/tools/builtin/index.ts'
import { createSessionFiles } from '../../src/runtime/session.ts'
import { createRuntimeState } from '../../src/runtime/state/types.ts'
import { createSubagentRuntime } from '../../src/runtime/subagents.ts'
import { deriveTaskControl } from '../../src/runtime/task_state.ts'
import { assertPromptObservabilityArchive, buildUsageArchivePayload } from './helpers.ts'
import { summarizeToolSchema } from '../../src/runtime/prompt_observability.ts'

function call(name: string, args: Record<string, unknown>, id = 'call_1'): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

class ChildWorkerProvider implements ModelProvider {
  async complete(_messages: ChatMessage[]): Promise<AssistantResponse> {
    return {
      role: 'assistant',
      content: 'Worker finished the implementation task.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }
  }
}

class ParentProvider implements ModelProvider {
  private step = 0

  async complete(messages: ChatMessage[]): Promise<AssistantResponse> {
    const lastToolMessage = [...messages].reverse().find((message) => message.role === 'tool')
    if (this.step === 0) {
      this.step += 1
      return {
        role: 'assistant',
        content: null,
        finish_reason: 'tool_calls',
        tool_calls: [
          call('spawn_agent', {
            role: 'worker',
            task: 'Implement a bounded change in the background.',
            execution: 'background',
          }),
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }
    }

    if (this.step >= 1 && lastToolMessage?.content) {
      const parsed = JSON.parse(lastToolMessage.content) as { agentId?: string; status?: string }
      if (parsed.agentId && parsed.status === 'running') {
        this.step += 1
        return {
          role: 'assistant',
          content: null,
          finish_reason: 'tool_calls',
          tool_calls: [call('wait_agent', { agentId: parsed.agentId }, `wait_${this.step}`)],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }
      }
      if (parsed.agentId && parsed.status === 'completed') {
        return {
          role: 'assistant',
          content: 'Parent observed the completed worker result and finished the task.',
          finish_reason: 'stop',
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }
      }
    }

    throw new Error(`unexpected parent provider state at step=${this.step}`)
  }
}

function makeContextService(overlayLabel?: string) {
  return {
    getTrustLevel: () => 'trusted' as const,
    getPathGuidanceState: () => ({ loadedAgentFiles: new Set<string>() }),
    getGeneratedMapMode: () => false,
    setGeneratedMapMode() {},
    async prefetchIfSafe() {
      return { initialItems: [], startupMapSummary: null, generatedMapMode: false }
    },
    async getSystemPrompt() {
      return 'system prompt'
    },
    async buildPromptPrelude(prompt: string) {
      if (!overlayLabel) return []
      return [
        createSystemItem(`Prompt-derived path guidance.\n\n${overlayLabel}: ${prompt}`, 'runtime'),
      ]
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

class RecordingChildExplorerProvider implements ModelProvider {
  readonly seenMessages: ChatMessage[][] = []

  async complete(messages: ChatMessage[]): Promise<AssistantResponse> {
    this.seenMessages.push(messages.map((message) => ({ ...message })))
    return {
      role: 'assistant',
      content: 'Child explorer finished with regenerated overlay only.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }
  }
}

class ForegroundParentProvider implements ModelProvider {
  private step = 0

  async complete(messages: ChatMessage[]): Promise<AssistantResponse> {
    const lastToolMessage = [...messages].reverse().find((message) => message.role === 'tool')
    if (this.step === 0) {
      this.step += 1
      return {
        role: 'assistant',
        content: null,
        finish_reason: 'tool_calls',
        tool_calls: [
          call('spawn_agent', {
            role: 'explorer',
            task: 'Inspect src/runtime/query_engine.ts and report the relevant symbols.',
            execution: 'foreground',
          }),
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }
    }

    if (this.step === 1 && lastToolMessage?.content) {
      this.step += 1
      return {
        role: 'assistant',
        content: 'Parent received the child result and stopped.',
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }
    }

    throw new Error(`unexpected foreground parent state at step=${this.step}`)
  }
}

test('e2e local loop can spawn and wait for a background worker subagent', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'merlion-e2e-subagent-'))
  await mkdir(join(cwd, '.git'), { recursive: true })

  try {
    const session = await createSessionFiles(cwd)
    const engine = new QueryEngine({
      cwd,
      provider: new ParentProvider(),
      registry: buildDefaultRegistry({ mode: 'default' }),
      permissions: { ask: async () => 'allow_session' },
      contextService: makeContextService(),
      model: 'parent-model',
      deriveTaskControl: (prompt, previousTask) => {
        const base = deriveTaskControl(prompt, previousTask)
        return {
          ...base,
          taskState: {
            ...base.taskState,
            kind: 'implementation',
            mayMutateFiles: true,
            requiredEvidence: 'codebacked',
            expectedDeliverable: 'Delegate bounded implementation work and wait for the result.',
          },
          capabilityProfile: 'implementation_scoped',
          mutationPolicy: {
            ...base.mutationPolicy,
            mayMutateFiles: true,
            mayRunDestructiveShell: true,
            reason: 'test override for subagent worker coverage',
          },
        }
      },
      createSubagentRuntime: ({ prompt, historyProjection, runtimeState, depth }) => createSubagentRuntime({
        cwd,
        session,
        model: 'parent-model',
        parentRegistry: buildDefaultRegistry({ mode: 'default' }),
        permissions: { ask: async () => 'allow_session' },
        runtimeState: runtimeState ?? createRuntimeState(),
        historyProjection,
        prompt,
        depth,
        createProvider: () => new ChildWorkerProvider(),
        createContextService: makeContextService,
      }),
    })

    const result = await engine.submitPrompt('Delegate a bounded task to a background worker and wait for it.')

    assert.equal(result.terminal, 'completed')
    assert.match(result.finalText, /completed worker result/i)
    assert.equal(itemsToMessages(result.state.items).some((message) => message.role === 'tool' && /"status": "completed"/.test(message.content ?? '')), true)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('e2e local subagent request regenerates child overlay instead of inheriting expired parent overlay', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'merlion-e2e-subagent-overlay-'))
  await mkdir(join(cwd, '.git'), { recursive: true })

  try {
    const session = await createSessionFiles(cwd)
    const childProvider = new RecordingChildExplorerProvider()
    const registry = buildDefaultRegistry({ mode: 'default' })
    const usageEntries: Array<{
      prompt_tokens: number
      completion_tokens: number
      cached_tokens: number | null
      stablePrefixTokens: number
      stablePrefixRatio: number
      toolSchemaHash: string | null
      schemaChangeReason: string | null
    }> = []
    const engine = new QueryEngine({
      cwd,
      provider: new ForegroundParentProvider(),
      registry,
      permissions: { ask: async () => 'allow_session' },
      contextService: makeContextService('parent overlay'),
      model: 'parent-model',
      initialItems: [
        createSystemItem('system prompt', 'static'),
        createExternalUserItem('Earlier parent task.'),
        createAssistantItem('Earlier parent result.'),
      ],
      deriveTaskControl: (prompt, previousTask) => {
        const base = deriveTaskControl(prompt, previousTask)
        return {
          ...base,
          taskState: {
            ...base.taskState,
            kind: 'implementation',
            mayMutateFiles: true,
            requiredEvidence: 'codebacked',
            expectedDeliverable: 'Delegate an explorer subagent and consume its result.',
          },
          capabilityProfile: 'implementation_scoped',
          mutationPolicy: {
            ...base.mutationPolicy,
            mayMutateFiles: true,
            mayRunDestructiveShell: true,
            reason: 'test override for child overlay coverage',
          },
        }
      },
      persistUsage: async (entry) => {
        usageEntries.push({
          prompt_tokens: entry.prompt_tokens,
          completion_tokens: entry.completion_tokens,
          cached_tokens: entry.cached_tokens ?? null,
          stablePrefixTokens: entry.promptObservability?.stable_prefix_tokens ?? 0,
          stablePrefixRatio: entry.promptObservability?.stable_prefix_ratio ?? 0,
          toolSchemaHash: entry.promptObservability?.tool_schema_hash ?? null,
          schemaChangeReason: entry.promptObservability?.schema_change_reason ?? null,
        })
      },
      createSubagentRuntime: ({ prompt, historyProjection, runtimeState, depth }) => createSubagentRuntime({
        cwd,
        session,
        model: 'parent-model',
        parentRegistry: registry,
        permissions: { ask: async () => 'allow_session' },
        runtimeState: runtimeState ?? createRuntimeState(),
        historyProjection,
        prompt,
        depth,
        createProvider: () => childProvider,
        createContextService: () => makeContextService('child overlay'),
      }),
    })

    const result = await engine.submitPrompt('Parent overlay prompt should stay local to the parent request.')

    assert.equal(result.terminal, 'completed')
    assert.match(result.finalText, /child result/i)
    const childSystemMessages = childProvider.seenMessages[0]!
      .filter((message) => message.role === 'system')
      .map((message) => message.content ?? '')
      .join('\n')
    const childTranscriptMessages = childProvider.seenMessages[0]!
      .filter((message) => message.role !== 'system')
      .map((message) => message.content ?? '')
      .join('\n')
    assert.match(childSystemMessages, /child overlay: Inspect src\/runtime\/query_engine\.ts/i)
    assert.doesNotMatch(childSystemMessages, /parent overlay: Parent overlay prompt should stay local/i)
    assert.match(childTranscriptMessages, /Earlier parent task\./)
    assert.match(childTranscriptMessages, /Earlier parent result\./)

    const childResultMessage = itemsToMessages(result.state.items)
      .find((message) => message.role === 'tool' && /"transcriptPath":/.test(message.content ?? ''))
    assert.ok(childResultMessage?.content, 'expected child result payload with transcript path')
    const childResult = JSON.parse(childResultMessage.content ?? '{}') as { transcriptPath?: string }
    assert.ok(childResult.transcriptPath, 'expected child transcript path')
    const childTranscript = await readFile(childResult.transcriptPath!, 'utf8')
    assert.match(childTranscript, /Subagent briefing:/)
    assert.match(childTranscript, /Earlier parent task\./)
    assert.match(childTranscript, /Earlier parent result\./)

    const archive = buildUsageArchivePayload({
      scenario: 'Subagent Overlay',
      task: 'Parent overlay prompt should stay local to the parent request.',
      cwd,
      result,
      model: 'parent-model',
      baseURL: 'https://example.test/v1',
      usageSamples: usageEntries.map((entry) => ({
        prompt_tokens: entry.prompt_tokens,
        completion_tokens: entry.completion_tokens,
        cached_tokens: entry.cached_tokens,
      })),
      totals: {
        prompt_tokens: usageEntries.reduce((sum, entry) => sum + entry.prompt_tokens, 0),
        completion_tokens: usageEntries.reduce((sum, entry) => sum + entry.completion_tokens, 0),
        cached_tokens: usageEntries.reduce((sum, entry) => sum + Math.max(0, entry.cached_tokens ?? 0), 0),
        total_tokens: usageEntries.reduce((sum, entry) => sum + entry.prompt_tokens + entry.completion_tokens, 0),
      },
      toolSchema: summarizeToolSchema(registry.getAll()),
      promptObservability: usageEntries.map((entry, index) => ({
        turn: index + 1,
        estimated_input_tokens: entry.prompt_tokens,
        tool_schema_tokens_estimate: 0,
        role_tokens: { system: 0, user: 0, assistant: 0, tool: 0 },
        role_delta_tokens: { system: 0, user: 0, assistant: 0, tool: 0 },
        stable_prefix_tokens: entry.stablePrefixTokens,
        stable_prefix_ratio: entry.stablePrefixRatio,
        stable_prefix_hash: entry.toolSchemaHash,
        tool_schema_hash: entry.toolSchemaHash,
        schema_change_reason: entry.schemaChangeReason,
      })),
    })
    const archiveSummary = assertPromptObservabilityArchive(archive, {
      minSnapshots: 2,
      minStablePrefixTokens: 1,
    })
    assert.equal(archiveSummary.maxStablePrefixRatio > 0, true)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
