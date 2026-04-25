import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { AssistantResponse, ChatMessage, ModelProvider, ToolCall } from '../src/types.ts'
import type { ConversationItem } from '../src/runtime/items.ts'
import { createExternalUserItem, createSystemItem } from '../src/runtime/items.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import type { ToolDefinition } from '../src/tools/types.ts'
import { QueryEngine } from '../src/runtime/query_engine.ts'
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

class RecordingProvider implements ModelProvider {
  readonly seenMessages: ChatMessage[][] = []
  readonly seenToolNames: string[][] = []
  private index = 0
  private readonly responses: AssistantResponse[]

  constructor(responses: AssistantResponse[]) {
    this.responses = responses
  }

  async complete(messages: ChatMessage[], tools: ToolDefinition[]): Promise<AssistantResponse> {
    this.seenMessages.push(messages.map((message) => ({ ...message })))
    this.seenToolNames.push(tools.map((tool) => tool.name))
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

function makeReadOnlyProbeTool(): ToolDefinition {
  return {
    name: 'probe',
    description: 'read-only probe tool for query engine tests',
    parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    concurrencySafe: true,
    isReadOnly: true,
    async execute(input) {
      return { content: `probed ${String(input.target)}`, isError: false }
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
          initialItems: [
            createSystemItem('bootstrap orientation', 'runtime'),
          ],
        }
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

test('QueryEngine narrows analysis turns to read-only tools and records correction rewrites', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'merlion-task-control-'))
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
        content: 'Reframed analysis.',
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ])

    const engine = new QueryEngine({
      cwd,
      provider,
      registry: buildDefaultRegistry({ mode: 'default' }),
      permissions: { ask: async () => 'allow' },
      contextService: {
        getTrustLevel: () => 'trusted',
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
      },
      buildIntentContract: (prompt, options) => options?.primaryObjective ?? prompt,
      model: 'test-model',
    })

    await engine.submitPrompt('Analyze this module and summarize its weaknesses.')
    await engine.submitPrompt('I mean the whole project, not just this module.')

    assert.equal(provider.seenToolNames[0]?.includes('edit_file'), false)
    assert.equal(provider.seenToolNames[0]?.includes('spawn_agent'), true)
    assert.equal(provider.seenToolNames[1]?.includes('edit_file'), false)

    const secondTurnMessages = provider.seenMessages[1] ?? []
    const systemMessages = secondTurnMessages.filter((message) => message.role === 'system').map((message) => message.content ?? '')
    assert.equal(systemMessages.some((content) => /Execution charter for this turn:/i.test(content)), true)
    assert.equal(systemMessages.some((content) => /Correction note:/i.test(content)), true)
    assert.equal(systemMessages.some((content) => /whole repository/i.test(content)), true)

    const snapshot = engine.getSnapshot()
    assert.equal(snapshot.runtimeState.task.currentTask?.correctionOfPreviousTurn, true)
    assert.equal(snapshot.runtimeState.task.capabilityProfile, 'readonly_analysis')
    assert.match(snapshot.runtimeState.task.currentTask?.activeObjective ?? '', /whole repository/i)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('QueryEngine keeps the active tool schema sticky across lightweight follow-up prompts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'merlion-sticky-profile-'))
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
        content: 'Follow-up answer.',
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ])

    const engine = new QueryEngine({
      cwd,
      provider,
      registry: buildDefaultRegistry({ mode: 'default' }),
      permissions: { ask: async () => 'allow' },
      contextService: {
        getTrustLevel: () => 'trusted',
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
      },
      model: 'test-model',
    })

    await engine.submitPrompt('Analyze this module and summarize its weaknesses.')
    await engine.submitPrompt('What else should I inspect next?')

    assert.deepEqual(provider.seenToolNames[1], provider.seenToolNames[0])
    assert.equal(provider.seenToolNames[1]?.includes('spawn_agent'), true)

    const snapshot = engine.getSnapshot()
    assert.equal(snapshot.runtimeState.task.capabilityProfile, 'readonly_analysis')
    assert.equal(snapshot.runtimeState.task.profileEpoch.epoch, 1)
    assert.equal(snapshot.runtimeState.task.profileEpoch.lastSchemaChangeReason, null)
    assert.equal(snapshot.runtimeState.task.currentTask?.kind, 'question')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('QueryEngine changes tool schema only on explicit phase switches', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'merlion-phase-switch-'))
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
      contextService: {
        getTrustLevel: () => 'trusted',
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
      },
      model: 'test-model',
    })

    await engine.submitPrompt('Analyze this module and summarize its weaknesses.')
    await engine.submitPrompt('Verify the fix by running the relevant tests now.')

    assert.equal(provider.seenToolNames[0]?.includes('bash'), false)
    assert.equal(provider.seenToolNames[1]?.includes('bash'), true)
    assert.equal(provider.seenToolNames[1]?.includes('run_script'), true)

    const snapshot = engine.getSnapshot()
    assert.equal(snapshot.runtimeState.task.capabilityProfile, 'verification_readonly')
    assert.equal(snapshot.runtimeState.task.profileEpoch.epoch, 2)
    assert.equal(snapshot.runtimeState.task.profileEpoch.lastSchemaChangeReason, 'phase_switch')
    assert.equal(snapshot.runtimeState.task.currentTask?.kind, 'verification')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('QueryEngine records user_correction when a correction changes the active profile epoch', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'merlion-correction-switch-'))
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
        content: 'Applied the fix.',
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ])

    const engine = new QueryEngine({
      cwd,
      provider,
      registry: buildDefaultRegistry({ mode: 'default' }),
      permissions: { ask: async () => 'allow' },
      contextService: {
        getTrustLevel: () => 'trusted',
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
      },
      model: 'test-model',
    })

    await engine.submitPrompt('Analyze this module and summarize its weaknesses.')
    await engine.submitPrompt('I mean fix the bug in src/index.ts instead.')

    assert.equal(provider.seenToolNames[0]?.includes('edit_file'), false)
    assert.equal(provider.seenToolNames[1]?.includes('edit_file'), true)

    const snapshot = engine.getSnapshot()
    assert.equal(snapshot.runtimeState.task.capabilityProfile, 'implementation_scoped')
    assert.equal(snapshot.runtimeState.task.profileEpoch.epoch, 2)
    assert.equal(snapshot.runtimeState.task.profileEpoch.lastSchemaChangeReason, 'user_correction')
    assert.equal(snapshot.runtimeState.task.currentTask?.kind, 'implementation')
    assert.equal(snapshot.runtimeState.task.currentTask?.correctionOfPreviousTurn, true)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('QueryEngine keeps implementation schema sticky across lightweight follow-up prompts', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'merlion-sticky-implementation-'))
  try {
    const provider = new RecordingProvider([
      {
        role: 'assistant',
        content: 'Applied the fix.',
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      {
        role: 'assistant',
        content: 'You should inspect the touched call sites next.',
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ])

    const engine = new QueryEngine({
      cwd,
      provider,
      registry: buildDefaultRegistry({ mode: 'default' }),
      permissions: { ask: async () => 'allow' },
      contextService: {
        getTrustLevel: () => 'trusted',
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
      },
      model: 'test-model',
    })

    await engine.submitPrompt('Fix the failing login flow in src/auth.ts.')
    await engine.submitPrompt('What else should I inspect next?')

    assert.equal(provider.seenToolNames[0]?.includes('edit_file'), true)
    assert.deepEqual(provider.seenToolNames[1], provider.seenToolNames[0])

    const snapshot = engine.getSnapshot()
    assert.equal(snapshot.runtimeState.task.capabilityProfile, 'implementation_scoped')
    assert.equal(snapshot.runtimeState.task.profileEpoch.epoch, 1)
    assert.equal(snapshot.runtimeState.task.profileEpoch.lastSchemaChangeReason, null)
    assert.equal(snapshot.runtimeState.task.currentTask?.kind, 'question')
    assert.equal(snapshot.runtimeState.task.mutationPolicy?.mayMutateFiles, false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('QueryEngine keeps turn overlays within one submit and excludes them from persisted history', async () => {
  const provider = new RecordingProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('probe', { target: 'src/runtime/query_engine.ts' })],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    {
      role: 'assistant',
      content: 'Finished the first request.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    {
      role: 'assistant',
      content: 'Finished the follow-up request.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ])

  const persisted: ConversationItem[] = []
  const registry = new ToolRegistry()
  registry.register(makeReadOnlyProbeTool())
  const engine = new QueryEngine({
    cwd: process.cwd(),
    provider,
    registry,
    permissions: { ask: async () => 'allow' },
    contextService: {
      getTrustLevel: () => 'trusted',
      getPathGuidanceState: () => ({ loadedAgentFiles: new Set<string>() }),
      getGeneratedMapMode: () => false,
      setGeneratedMapMode() {},
      async prefetchIfSafe() {
        return { startupMapSummary: null, generatedMapMode: false, initialItems: [] }
      },
      async getSystemPrompt() {
        return 'system prompt'
      },
      async buildPromptPrelude(prompt) {
        return [
          createSystemItem(`Prompt-derived path guidance.\n\nfocus: ${prompt}`, 'runtime'),
        ]
      },
      async buildPathGuidanceItems() {
        return {
          loadedFiles: ['src/runtime/query_engine.ts'],
          items: [createSystemItem('Path guidance update.\n\n- src/runtime/query_engine.ts', 'runtime')],
        }
      },
      async extractCandidatePathsFromText() {
        return []
      },
      async extractCandidatePathsFromToolEvent() {
        return ['src/runtime/query_engine.ts']
      },
    },
    persistItem: async (item) => {
      persisted.push(item)
    },
    model: 'test-model',
  })

  await engine.submitPrompt('inspect src/runtime/query_engine.ts')
  await engine.submitPrompt('summarize the findings')

  const firstTurnSystems = provider.seenMessages[0]!.filter((message) => message.role === 'system').map((message) => message.content ?? '')
  const toolFollowUpSystems = provider.seenMessages[1]!.filter((message) => message.role === 'system').map((message) => message.content ?? '')
  const secondRequestSystems = provider.seenMessages[2]!.filter((message) => message.role === 'system').map((message) => message.content ?? '')

  assert.equal(firstTurnSystems.some((content) => content.includes('focus: inspect src/runtime/query_engine.ts')), true)
  assert.equal(toolFollowUpSystems.some((content) => content.startsWith('Prompt-derived path guidance.')), true)
  assert.equal(toolFollowUpSystems.some((content) => content.startsWith('Path guidance update.')), true)
  assert.equal(
    secondRequestSystems.some(
      (content) => content.startsWith('Prompt-derived path guidance.') && content.includes('focus: inspect src/runtime/query_engine.ts')
    ),
    false,
  )
  assert.equal(secondRequestSystems.some((content) => content.startsWith('Path guidance update.')), false)

  const persistedText = persisted
    .filter((item): item is Extract<ConversationItem, { kind: 'message' }> => item.kind === 'message')
    .map((item) => item.content)
    .join('\n')
  assert.equal(/Prompt-derived path guidance\./.test(persistedText), false)
  assert.equal(/Path guidance update\./.test(persistedText), false)
  assert.equal(/Execution charter for this turn:/.test(persistedText), false)

  const snapshotText = engine.getItems()
    .filter((item): item is Extract<ConversationItem, { kind: 'message' }> => item.kind === 'message')
    .map((item) => item.content)
    .join('\n')
  assert.equal(/Prompt-derived path guidance\./.test(snapshotText), false)
  assert.equal(/Path guidance update\./.test(snapshotText), false)
  assert.equal(/Execution charter for this turn:/.test(snapshotText), false)
})

test('QueryEngine resumeFromTranscript strips legacy overlay items before the next request', async () => {
  const provider = new RecordingProvider([
    {
      role: 'assistant',
      content: 'Resumed cleanly.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ])

  const engine = new QueryEngine({
    cwd: process.cwd(),
    provider,
    registry: buildDefaultRegistry({ mode: 'default' }),
    permissions: { ask: async () => 'allow' },
    contextService: {
      getTrustLevel: () => 'trusted',
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
    },
    model: 'test-model',
  })

  await engine.resumeFromTranscript([
    createSystemItem('system prompt', 'static'),
    createSystemItem('Prompt-derived path guidance.\n\nlegacy overlay', 'runtime'),
    createSystemItem('Path guidance update.\n\nlegacy guidance', 'runtime'),
    createExternalUserItem('original task'),
  ])

  assert.equal(engine.getItems().some((item) => item.kind === 'message' && item.content.includes('legacy overlay')), false)
  assert.equal(engine.getItems().some((item) => item.kind === 'message' && item.content.includes('legacy guidance')), false)

  await engine.submitPrompt('continue from the resumed session')

  const requestSystems = provider.seenMessages[0]!.filter((message) => message.role === 'system').map((message) => message.content ?? '')
  assert.equal(requestSystems.some((content) => content.includes('legacy overlay')), false)
  assert.equal(requestSystems.some((content) => content.includes('legacy guidance')), false)
})

test('QueryEngine rehydrates the sticky profile epoch on transcript resume before the next request', async () => {
  const provider = new RecordingProvider([
    {
      role: 'assistant',
      content: 'Resumed with the prior implementation schema.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ])

  const engine = new QueryEngine({
    cwd: process.cwd(),
    provider,
    registry: buildDefaultRegistry({ mode: 'default' }),
    permissions: { ask: async () => 'allow' },
    contextService: {
      getTrustLevel: () => 'trusted',
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
    },
    model: 'test-model',
  })

  await engine.resumeFromTranscript([
    createSystemItem('system prompt', 'static'),
    createExternalUserItem('Implement the requested change.'),
    {
      kind: 'function_call',
      callId: 'call_edit',
      name: 'edit_file',
      argumentsText: '{"path":"src/index.ts"}',
    },
  ])

  await engine.submitPrompt('What else changed?')

  assert.equal(provider.seenToolNames[0]?.includes('edit_file'), true)

  const snapshot = engine.getSnapshot()
  assert.equal(snapshot.runtimeState.task.capabilityProfile, 'implementation_scoped')
  assert.equal(snapshot.runtimeState.task.profileEpoch.epoch, 1)
  assert.equal(snapshot.runtimeState.task.profileEpoch.lastSchemaChangeReason, 'resume_rehydration')
  assert.equal(snapshot.runtimeState.task.profileEpoch.pendingResumeRehydration, false)
})

test('QueryEngine resumeFromSnapshot preserves the active profile epoch across engine replacement', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'merlion-snapshot-resume-'))
  try {
    const firstProvider = new RecordingProvider([
      {
        role: 'assistant',
        content: 'Initial analysis.',
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ])
    const contextService = {
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

    const firstEngine = new QueryEngine({
      cwd,
      provider: firstProvider,
      registry: buildDefaultRegistry({ mode: 'default' }),
      permissions: { ask: async () => 'allow' },
      contextService,
      model: 'test-model',
    })

    await firstEngine.submitPrompt('Analyze this module and summarize its weaknesses.')
    const snapshot = firstEngine.getSnapshot()

    const secondProvider = new RecordingProvider([
      {
        role: 'assistant',
        content: 'Follow-up answer.',
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ])
    const secondEngine = new QueryEngine({
      cwd,
      provider: secondProvider,
      registry: buildDefaultRegistry({ mode: 'default' }),
      permissions: { ask: async () => 'allow' },
      contextService,
      model: 'test-model',
    })

    await secondEngine.resumeFromSnapshot(snapshot)
    await secondEngine.submitPrompt('What else should I inspect next?')

    assert.equal(secondProvider.seenToolNames[0]?.includes('spawn_agent'), true)

    const secondSnapshot = secondEngine.getSnapshot()
    assert.equal(secondSnapshot.runtimeState.task.capabilityProfile, 'readonly_analysis')
    assert.equal(secondSnapshot.runtimeState.task.profileEpoch.epoch, 1)
    assert.equal(secondSnapshot.runtimeState.task.profileEpoch.lastSchemaChangeReason, null)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
