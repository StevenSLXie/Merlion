import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { AssistantResponse, ChatMessage, ModelProvider, ToolCall } from '../../src/types.ts'
import { QueryEngine } from '../../src/runtime/query_engine.ts'
import { buildDefaultRegistry } from '../../src/tools/builtin/index.ts'
import { createSessionFiles } from '../../src/runtime/session.ts'
import { createRuntimeState } from '../../src/runtime/state/types.ts'
import { createSubagentRuntime } from '../../src/runtime/subagents.ts'

function call(name: string, args: Record<string, unknown>, id = 'call_1'): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

class ChildWorkerProvider implements ModelProvider {
  private index = 0
  private readonly responses: AssistantResponse[] = [
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('sleep', { duration_ms: 50 })],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    {
      role: 'assistant',
      content: 'Worker finished the implementation task.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ]

  async complete(_messages: ChatMessage[]): Promise<AssistantResponse> {
    const response = this.responses[this.index]
    if (!response) throw new Error(`unexpected child provider call at index=${this.index}`)
    this.index += 1
    return response
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

function makeContextService() {
  return {
    getTrustLevel: () => 'trusted' as const,
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
      createSubagentRuntime: ({ prompt, history, runtimeState, depth }) => createSubagentRuntime({
        cwd,
        session,
        model: 'parent-model',
        parentRegistry: buildDefaultRegistry({ mode: 'default' }),
        permissions: { ask: async () => 'allow_session' },
        runtimeState: runtimeState ?? createRuntimeState(),
        history,
        prompt,
        depth,
        createProvider: () => new ChildWorkerProvider(),
        createContextService: makeContextService,
      }),
    })

    const result = await engine.submitPrompt('Delegate a bounded task to a background worker and wait for it.')

    assert.equal(result.terminal, 'completed')
    assert.match(result.finalText, /completed worker result/i)
    assert.equal(result.state.messages.some((message) => message.role === 'tool' && /"status": "completed"/.test(message.content ?? '')), true)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

