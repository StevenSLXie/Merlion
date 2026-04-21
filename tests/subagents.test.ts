import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { AssistantResponse, ChatMessage, ModelProvider, ToolCall } from '../src/types.ts'
import { createRuntimeState } from '../src/runtime/state/types.ts'
import { createSessionFiles } from '../src/runtime/session.ts'
import { createSubagentRuntime } from '../src/runtime/subagents.ts'
import { buildDefaultRegistry } from '../src/tools/builtin/index.ts'

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
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  }
}

function makeContextService() {
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

async function makeSandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'merlion-subagents-'))
  await mkdir(join(dir, '.git'), { recursive: true })
  return dir
}

test('foreground explorer returns terminal result and cached wait result', async () => {
  const cwd = await makeSandbox()
  try {
    const session = await createSessionFiles(cwd)
    const runtime = createSubagentRuntime({
      cwd,
      session,
      model: 'parent-model',
      parentRegistry: buildDefaultRegistry({ mode: 'default' }),
      permissions: { ask: async () => 'allow_session' },
      runtimeState: createRuntimeState(),
      history: [],
      prompt: 'inspect the login flow',
      createProvider: () =>
        new StubProvider([
          {
            role: 'assistant',
            content: 'I found the relevant login files and tests.',
            finish_reason: 'stop',
            usage: { prompt_tokens: 3, completion_tokens: 4 },
          },
        ]),
      createContextService: makeContextService,
    })

    const result = await runtime.spawnAgent({
      role: 'explorer',
      task: 'Find the login-related files and tests.',
      execution: 'foreground',
    })

    assert.equal(result.status, 'completed')
    assert.equal('agentId' in result, true)
    assert.equal(typeof result.summary, 'string')
    assert.match(result.summary, /login/i)
    assert.equal(await readFile(result.transcriptPath, 'utf8').then((text) => text.includes('Subagent briefing:')), true)

    const waited = await runtime.waitAgent(result.agentId)
    assert.equal(waited.status, 'completed')
    assert.equal(waited.summary, result.summary)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('explorer child is runtime-enforced read-only', async () => {
  const cwd = await makeSandbox()
  try {
    const session = await createSessionFiles(cwd)
    const runtime = createSubagentRuntime({
      cwd,
      session,
      model: 'parent-model',
      parentRegistry: buildDefaultRegistry({ mode: 'default' }),
      permissions: { ask: async () => 'allow_session' },
      runtimeState: createRuntimeState(),
      history: [],
      prompt: 'inspect without editing',
      createProvider: () =>
        new StubProvider([
          {
            role: 'assistant',
            content: null,
            finish_reason: 'tool_calls',
            tool_calls: [call('create_file', { path: 'notes.txt', content: 'oops' })],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          },
          {
            role: 'assistant',
            content: 'I stayed read-only and reported findings instead.',
            finish_reason: 'stop',
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          },
        ]),
      createContextService: makeContextService,
    })

    const result = await runtime.spawnAgent({
      role: 'explorer',
      task: 'Inspect the workspace and do not change files.',
      execution: 'foreground',
    })

    assert.equal(result.status, 'completed')
    assert.deepEqual(result.filesChanged, [])
    const transcript = await readFile(result.transcriptPath, 'utf8')
    assert.match(transcript, /Unknown tool: create_file/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('background worker can be waited to completion', async () => {
  const cwd = await makeSandbox()
  try {
    const session = await createSessionFiles(cwd)
    const runtime = createSubagentRuntime({
      cwd,
      session,
      model: 'parent-model',
      parentRegistry: buildDefaultRegistry({ mode: 'default' }),
      permissions: { ask: async () => 'allow_session' },
      runtimeState: createRuntimeState(),
      history: [],
      prompt: 'make a longer change',
      createProvider: () =>
        new StubProvider([
          {
            role: 'assistant',
            content: null,
            finish_reason: 'tool_calls',
            tool_calls: [call('sleep', { duration_ms: 100 })],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          },
          {
            role: 'assistant',
            content: 'Background worker finished the task.',
            finish_reason: 'stop',
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          },
        ]),
      createContextService: makeContextService,
    })

    const started = await runtime.spawnAgent({
      role: 'worker',
      task: 'Do a longer task in the background.',
      execution: 'background',
    })

    assert.equal(started.status, 'running')
    if (!('agentId' in started)) throw new Error('expected background agent id')

    const firstWait = await runtime.waitAgent(started.agentId)
    assert.equal(firstWait.status, 'running')

    await new Promise((resolve) => setTimeout(resolve, 200))
    const finalWait = await runtime.waitAgent(started.agentId)
    assert.equal(finalWait.status, 'completed')
    assert.match(finalWait.summary, /background worker finished/i)
    const registryText = await readFile(session.childRegistryPath, 'utf8')
    assert.match(registryText, /"status":"running"/)
    assert.match(registryText, /"status":"completed"/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
