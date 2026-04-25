import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { AssistantResponse, ChatMessage, ModelProvider, ToolCall } from '../src/types.ts'
import type { ConversationItem, ProviderCapabilities, ProviderResult } from '../src/runtime/items.ts'
import { createSystemItem, itemsToMessages, messagesToItems } from '../src/runtime/items.ts'
import { ToolRegistry } from '../src/tools/registry.ts'
import type { ToolDefinition } from '../src/tools/types.ts'
import { runLoop, shouldNudge } from '../src/runtime/loop.ts'
import { bashTool } from '../src/tools/builtin/bash.ts'
import { buildDefaultRegistry } from '../src/tools/builtin/index.ts'

function renderedMessages(items: ConversationItem[]) {
  return itemsToMessages(items)
}

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

class RecordingStubProvider extends StubProvider {
  readonly seenMessages: ChatMessage[][] = []

  async complete(messages: ChatMessage[]): Promise<AssistantResponse> {
    this.seenMessages.push(messages.map((message) => ({ ...message })))
    return await super.complete(messages)
  }
}

class ThrowProvider implements ModelProvider {
  private readonly error: Error
  constructor(message: string) {
    this.error = new Error(message)
  }
  async complete(): Promise<AssistantResponse> {
    throw this.error
  }
}

class ItemStubProvider implements ModelProvider {
  private index = 0
  private readonly responses: ProviderResult[]

  constructor(responses: ProviderResult[]) {
    this.responses = responses
  }

  capabilities(): ProviderCapabilities {
    return {
      transcriptMode: 'items',
      supportsReasoningItems: true,
      supportsPreviousResponseId: false,
    }
  }

  async complete(): Promise<AssistantResponse> {
    throw new Error('legacy complete should not be called')
  }

  async completeItems(_items: ConversationItem[]): Promise<ProviderResult> {
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
    function: { name, arguments: JSON.stringify(args) }
  }
}

function makeEchoTool(): ToolDefinition {
  return {
    name: 'echo_tool',
    description: 'echoes input',
    parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    concurrencySafe: true,
    async execute(input) {
      return { content: `echo:${String(input.value)}`, isError: false }
    }
  }
}

function makeAlwaysFailTool(): ToolDefinition {
  return {
    name: 'always_fail',
    description: 'always fails',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    concurrencySafe: true,
    async execute(input) {
      return { content: `File not found: ${String(input.path)}`, isError: true }
    }
  }
}

function makeAlwaysSuccessMutationTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} stub`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        file_path: { type: 'string' },
        from_path: { type: 'string' },
        to_path: { type: 'string' }
      }
    },
    concurrencySafe: false,
    async execute() {
      return { content: 'ok', isError: false }
    }
  }
}

function makeEditDiffMutationTool(name: string, addedLines: number, removedLines: number): ToolDefinition {
  return {
    name,
    description: `${name} stub`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
      }
    },
    concurrencySafe: false,
    async execute(input) {
      const path = typeof input.path === 'string' ? input.path : '/workspace/repo/src/example.ts'
      return {
        content: 'ok',
        isError: false,
        uiPayload: {
          kind: 'edit_diff' as const,
          path,
          addedLines,
          removedLines,
          hunks: []
        }
      }
    }
  }
}

function makeAlwaysSuccessTool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} stub`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        file_path: { type: 'string' },
        command: { type: 'string' },
        script: { type: 'string' }
      }
    },
    concurrencySafe: false,
    async execute(input) {
      return { content: JSON.stringify(input), isError: false }
    }
  }
}

function makeReadonlyAnalysisTaskControl() {
  return {
    taskState: {
      kind: 'analysis' as const,
      activeObjective: 'Analyze the project.',
      expectedDeliverable: 'Provide a code-backed analysis.',
      mayMutateFiles: false,
      requiredEvidence: 'codebacked' as const,
      correctionOfPreviousTurn: false,
      replacesPreviousObjective: false,
      explicitPaths: [],
      openQuestions: [],
    },
    capabilityProfile: 'readonly_analysis' as const,
    mutationPolicy: {
      mayMutateFiles: false,
      mayRunDestructiveShell: false,
      reason: 'analysis is read-only',
    },
  }
}

test('loop executes tool call then completes', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'ok' })],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done after retry',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeEchoTool())

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 5
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'done')
  assert.equal(renderedMessages(result.state.items).some((m) => m.role === 'tool'), true)
})

test('loop handles unknown tool safely', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('not_exists', {})],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'finished',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'finished after retry',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 5
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'finished after retry')
  const toolMsg = renderedMessages(result.state.items).find((m) => m.role === 'tool')
  assert.ok(toolMsg)
  assert.match(toolMsg?.content ?? '', /Unknown tool/)
})

test('loop returns terminal assistant text', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: 'all good',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 5
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'all good')
})

test('loop supports ask_user_question-style interactive callback', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('ask_user_question', {
        questions: [
          {
            header: 'Mode',
            id: 'mode',
            question: 'Which mode?',
            options: [
              { label: 'Safe', description: 'recommended' },
              { label: 'Fast', description: 'less checks' },
            ],
          },
        ],
      })],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'used the answer and finished',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register({
    name: 'ask_user_question',
    description: 'ask the user clarifying questions',
    parameters: { type: 'object', properties: { questions: { type: 'array' } }, required: ['questions'] },
    concurrencySafe: false,
    async execute(_input, ctx) {
      return {
        content: JSON.stringify({
          answers: await ctx.askQuestions?.([
            {
              header: 'Mode',
              id: 'mode',
              question: 'Which mode?',
              options: [
                { label: 'Safe', description: 'recommended' },
                { label: 'Fast', description: 'less checks' },
              ],
            },
          ]),
        }),
        isError: false,
      }
    }
  })

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 5,
    askQuestions: async () => ({ mode: 'Safe' }),
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'used the answer and finished')
  const toolMsg = renderedMessages(result.state.items).find((message) => message.role === 'tool')
  assert.match(toolMsg?.content ?? '', /"mode":"Safe"/)
})

test('loop recovers empty stop after tool calls by requesting final summary', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'ok' })],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: '',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'Edited tests/executor.test.ts by adding one blank line.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeEchoTool())

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 8
  })

  assert.equal(result.terminal, 'completed')
  assert.match(result.finalText, /Edited tests\/executor\.test\.ts/)
  assert.equal(
    renderedMessages(result.state.items).some((m) => m.role === 'user' && /final summary/i.test(m.content ?? '')),
    true
  )
})

test('loop falls back to synthetic summary when stop remains empty after recovery', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'ok' })],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: '',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: '',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeEchoTool())

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 8
  })

  assert.equal(result.terminal, 'completed')
  assert.match(result.finalText, /returned no final summary/i)
})

test('loop records prompt observability for synthetic natural-summary fallback turns', async () => {
  const usageEvents: Array<Record<string, unknown>> = []
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'ok' })],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: '',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: '',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'Synthetic summary after tool execution.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
  ])

  const registry = new ToolRegistry()
  registry.register(makeEchoTool())

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 8,
    onUsage: async (usage) => {
      usageEvents.push(usage as Record<string, unknown>)
    },
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'Synthetic summary after tool execution.')
  assert.equal(usageEvents.length, 4)
  assert.equal(typeof usageEvents[3]?.['runtimeResponseId'], 'string')
  assert.equal(usageEvents[3]?.['providerFinishReason'], 'stop')
  assert.equal(typeof usageEvents[3]?.['providerResponseId'], 'undefined')

  const promptObservability = usageEvents[3]?.['promptObservability'] as Record<string, unknown> | undefined
  assert.ok(promptObservability)
  assert.equal(promptObservability['schema_change_reason'], null)
  assert.equal((promptObservability['overlay_tokens_estimate'] as number) > 0, true)
  assert.equal(typeof promptObservability['tool_schema_hash'], 'string')
  assert.equal((promptObservability['stable_prefix_tokens'] as number) > 0, true)
})

test('loop uses the canonical request builder for tool follow-up and natural-summary fallback turns', async () => {
  const provider = new RecordingStubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'ok' })],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: '',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'Final summary after recovery.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
  ])

  const registry = new ToolRegistry()
  registry.register(makeEchoTool())

  await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    promptPreludeItems: [createSystemItem('Prompt-derived path guidance.\n\nfocus: src/runtime/loop.ts', 'runtime')],
    executionCharterText: 'Execution charter for this turn:\n- stay focused',
    intentContract: 'Mention only concrete outcomes.',
    cwd: process.cwd(),
    maxTurns: 8,
    onToolBatchComplete: async () => [
      createSystemItem('Path guidance update.\n\n- src/runtime/query_engine.ts', 'runtime'),
    ],
  })

  const toolFollowUpSystems = provider.seenMessages[1]!.filter((message) => message.role === 'system').map((message) => message.content ?? '')
  const fallbackSystems = provider.seenMessages[2]!.filter((message) => message.role === 'system').map((message) => message.content ?? '')
  const toolFollowUpPreludeIndex = toolFollowUpSystems.findIndex((content) => content.startsWith('Prompt-derived path guidance.'))
  const toolFollowUpCharterIndex = toolFollowUpSystems.findIndex((content) => content.startsWith('Execution charter for this turn:'))
  const toolFollowUpGuidanceIndex = toolFollowUpSystems.findIndex((content) => content.startsWith('Path guidance update.'))
  const toolFollowUpContractIndex = toolFollowUpSystems.findIndex((content) => content.startsWith('Execution contract for the current request.'))
  const fallbackPreludeIndex = fallbackSystems.findIndex((content) => content.startsWith('Prompt-derived path guidance.'))
  const fallbackCharterIndex = fallbackSystems.findIndex((content) => content.startsWith('Execution charter for this turn:'))
  const fallbackGuidanceIndex = fallbackSystems.findIndex((content) => content.startsWith('Path guidance update.'))
  const fallbackContractIndex = fallbackSystems.findIndex((content) => content.startsWith('Execution contract for the current request.'))

  assert.equal(toolFollowUpPreludeIndex < toolFollowUpCharterIndex, true)
  assert.equal(toolFollowUpCharterIndex < toolFollowUpGuidanceIndex, true)
  assert.equal(toolFollowUpGuidanceIndex < toolFollowUpContractIndex, true)
  assert.equal(fallbackPreludeIndex < fallbackCharterIndex, true)
  assert.equal(fallbackCharterIndex < fallbackGuidanceIndex, true)
  assert.equal(fallbackGuidanceIndex < fallbackContractIndex, true)
})

test('item-native loop recovers empty stop after tool calls by requesting final summary', async () => {
  const provider = new ItemStubProvider([
    {
      outputItems: [{
        kind: 'function_call',
        callId: 'call_1',
        name: 'echo_tool',
        argumentsText: '{"value":"ok"}',
      }],
      finishReason: 'tool_calls',
      usage: { prompt_tokens: 1, completion_tokens: 1, provider: 'openai' },
      providerResponseId: 'resp_1',
    },
    {
      outputItems: [],
      finishReason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1, provider: 'openai' },
      providerResponseId: 'resp_2',
    },
    {
      outputItems: [{
        kind: 'message',
        role: 'assistant',
        content: 'Final summary after tool output.',
        source: 'provider',
      }],
      finishReason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1, provider: 'openai' },
      providerResponseId: 'resp_3',
    },
  ])

  const registry = new ToolRegistry()
  registry.register(makeEchoTool())

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 8,
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'Final summary after tool output.')
  assert.equal(
    renderedMessages(result.state.items).some((message) => message.role === 'user' && /final summary/i.test(message.content ?? '')),
    true
  )
})

test('item-native loop emits usage correlated with runtime and provider response ids', async () => {
  const provider = new ItemStubProvider([
    {
      outputItems: [{
        kind: 'message',
        role: 'assistant',
        content: 'done',
        source: 'provider',
      }],
      finishReason: 'stop',
      usage: { prompt_tokens: 2, completion_tokens: 1, provider: 'openai' },
      responseBoundary: {
        runtimeResponseId: 'rt_1',
        providerResponseId: 'resp_1',
        provider: 'openai',
        finishReason: 'stop',
        outputItemCount: 1,
        createdAt: new Date().toISOString(),
      },
    },
  ])

  let usageEvent: Record<string, unknown> | null = null
  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 5,
    onUsage: async (usage) => {
      usageEvent = usage as Record<string, unknown>
    },
  })

  assert.equal(result.terminal, 'completed')
  assert.ok(usageEvent)
  assert.equal(usageEvent['runtimeResponseId'], 'rt_1')
  assert.equal(usageEvent['providerResponseId'], 'resp_1')
  assert.equal(usageEvent['providerFinishReason'], 'stop')
})

test('loop accepts initial items', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: 'continued',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'ignored because initial items provided',
    userPrompt: '',
    cwd: process.cwd(),
    maxTurns: 5,
    initialItems: messagesToItems([
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'a' }
    ]),
    persistInitialMessages: false
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'continued')
  assert.equal(result.state.items.length >= 4, true)
})

test('readonly task control blocks mutation tools even if the model calls them', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'merlion-readonly-mutation-'))
  try {
    const provider = new StubProvider([
      {
        role: 'assistant',
        content: null,
        finish_reason: 'tool_calls',
        tool_calls: [call('write_file', { path: 'blocked.txt', content: 'nope' })],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      {
        role: 'assistant',
        content: 'stayed read-only',
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ])

    const result = await runLoop({
      provider,
      registry: buildDefaultRegistry({ mode: 'default' }),
      systemPrompt: 'system',
      userPrompt: 'Analyze the repository.',
      cwd,
      maxTurns: 5,
      taskControl: makeReadonlyAnalysisTaskControl(),
    })

    assert.equal(result.terminal, 'completed')
    const rendered = renderedMessages(result.state.items)
    const toolMessage = rendered.find((message) => message.role === 'tool')
    assert.match(toolMessage?.content ?? '', /Denied by task policy/)
    await assert.rejects(() => readFile(join(cwd, 'blocked.txt'), 'utf8'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('readonly task control blocks destructive bash commands', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'merlion-readonly-bash-'))
  try {
    await writeFile(join(cwd, 'safe.txt'), 'keep', 'utf8')
    const provider = new StubProvider([
      {
        role: 'assistant',
        content: null,
        finish_reason: 'tool_calls',
        tool_calls: [call('bash', { command: 'touch blocked.txt' })],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      {
        role: 'assistant',
        content: 'reported the denial',
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ])

    const registry = new ToolRegistry()
    registry.register(bashTool)

    const result = await runLoop({
      provider,
      registry,
      systemPrompt: 'system',
      userPrompt: 'Verify the change without editing files.',
      cwd,
      maxTurns: 5,
      taskControl: makeReadonlyAnalysisTaskControl(),
    })

    assert.equal(result.terminal, 'completed')
    const toolMessage = renderedMessages(result.state.items).find((message) => message.role === 'tool')
    assert.match(toolMessage?.content ?? '', /read-only shell commands/)
    await assert.rejects(() => readFile(join(cwd, 'blocked.txt'), 'utf8'))
    assert.equal(await readFile(join(cwd, 'safe.txt'), 'utf8'), 'keep')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

// ── shouldNudge unit tests ─────────────────────────────────────────────────

test('shouldNudge: never nudges short conversational text', () => {
  const baseState = {
    messages: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    nudgeCount: 0
  }
  assert.equal(shouldNudge('在', baseState), false)
  assert.equal(shouldNudge('yes', baseState), false)
  assert.equal(shouldNudge('done', baseState), false)
  assert.equal(shouldNudge('ok', baseState), false)
  assert.equal(shouldNudge('', baseState), false)
})

test('shouldNudge: detects false start with I will/I\'ll pattern', () => {
  const baseState = {
    messages: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    nudgeCount: 0
  }
  const longEnough = "I'll start by reading the auth file and understanding the current session management approach."
  assert.equal(shouldNudge(longEnough, baseState), true)
})

test('shouldNudge: detects "let me" false start', () => {
  const baseState = {
    messages: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    nudgeCount: 0
  }
  assert.equal(
    shouldNudge('Let me read the configuration file to understand the current setup.', baseState),
    true,
  )
})

test('shouldNudge: detects chinese false-start promise', () => {
  const baseState = {
    messages: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    nudgeCount: 0
  }
  assert.equal(
    shouldNudge('我来为你构建这个页面。首先让我查看一下当前目录结构。', baseState),
    true,
  )
})

test('shouldNudge: detects generic action-plan phrasing', () => {
  const baseState = {
    messages: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    nudgeCount: 0
  }
  assert.equal(
    shouldNudge('Next I need to inspect the project structure and then run a quick search.', baseState),
    true,
  )
})

test('shouldNudge: path mention without execution evidence still nudges', () => {
  const baseState = {
    messages: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    nudgeCount: 0
  }
  assert.equal(
    shouldNudge("I'll inspect `src/runtime/loop.ts` first and then update the fix.", baseState),
    true,
  )
})

test('shouldNudge: does not nudge genuine past-tense completion', () => {
  const baseState = {
    messages: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    nudgeCount: 0
  }
  assert.equal(
    shouldNudge('The function has been updated successfully. The type error on line 42 is fixed.', baseState),
    false,
  )
})

test('shouldNudge: does not nudge concrete findings without tool calls', () => {
  const baseState = {
    messages: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    nudgeCount: 0
  }
  assert.equal(
    shouldNudge('I inspected the repo and found src/index.ts and src/runtime/loop.ts as key entry points.', baseState),
    false,
  )
})

test('shouldNudge: does not nudge short ack-like chinese reply', () => {
  const baseState = {
    messages: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    nudgeCount: 0
  }
  assert.equal(shouldNudge('在的', baseState), false)
})

test('shouldNudge: cap at 2 nudges prevents infinite nudge loop', () => {
  const cappedState = {
    messages: [],
    turnCount: 0,
    maxOutputTokensRecoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    nudgeCount: 2
  }
  const text = "Let me read the configuration file to understand the current setup."
  assert.equal(shouldNudge(text, cappedState), false)
})

test('loop injects nudge then completes when model stops after nudge', async () => {
  const LONG_WILL_DO = "I'll start by reading the authentication module to understand the existing session management approach."

  const provider = new StubProvider([
    {
      role: 'assistant',
      content: LONG_WILL_DO,
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    {
      role: 'assistant',
      content: 'Task is now complete.',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ])

  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'system',
    userPrompt: 'fix the auth bug',
    cwd: process.cwd(),
    maxTurns: 10,
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'Task is now complete.')
  assert.equal(result.state.nudgeCount, 1)
  // Nudge message must be present in state
  const nudgeMsg = renderedMessages(result.state.items).find(
    (m) => m.role === 'user' && typeof m.content === 'string' && m.content.includes('Continue with the task'),
  )
  assert.ok(nudgeMsg, 'nudge message should be present in state.items')
})

test('loop returns model_error for content_filter finish_reason', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'content_filter',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ])

  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 5,
  })

  assert.equal(result.terminal, 'model_error')
})

test('loop returns auth-specific remediation when provider key is invalid', async () => {
  const provider = new ThrowProvider('Provider error 401: Invalid API key')
  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 5,
  })

  assert.equal(result.terminal, 'model_error')
  assert.match(result.finalText, /authentication failed/i)
  assert.match(result.finalText, /merlion config/)
  assert.match(result.finalText, /~\/\.config\/merlion\/config\.json/)
  assert.match(result.finalText, /MERLION_API_KEY/)
})

test('loop handles tool_calls finish_reason with empty tool_calls array', async () => {
  // Model says tool_calls but sends empty array — should fall through to stop handling
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: 'no tools called',
      finish_reason: 'tool_calls',
      tool_calls: [],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ])

  const result = await runLoop({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 5,
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'no tools called')
})

test('loop emits turn/assistant/tool hooks for cli rendering', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'ok' })],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    },
  ])

  const registry = new ToolRegistry()
  registry.register(makeEchoTool())
  const events: string[] = []

  await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 10,
    onTurnStart: ({ turn }) => {
      events.push(`turn:${turn}`)
    },
    onAssistantResponse: ({ turn, finish_reason, tool_calls_count }) =>
      {
        events.push(`assistant:${turn}:${finish_reason}:${tool_calls_count}`)
      },
    onToolCallStart: ({ call }) => {
      events.push(`tool_start:${call.function.name}`)
    },
    onToolCallResult: ({ call }) => {
      events.push(`tool_done:${call.function.name}`)
    },
  })

  assert.equal(events.includes('turn:1'), true)
  assert.equal(events.includes('assistant:1:tool_calls:1'), true)
  assert.equal(events.includes('tool_start:echo_tool'), true)
  assert.equal(events.includes('tool_done:echo_tool'), true)
  assert.equal(events.includes('turn:2'), true)
  assert.equal(events.includes('assistant:2:stop:0'), true)
})

test('loop compacts oversized context once before provider call', async () => {
  const previous = process.env.MERLION_COMPACT_TRIGGER_CHARS
  process.env.MERLION_COMPACT_TRIGGER_CHARS = '300'
  process.env.MERLION_COMPACT_KEEP_RECENT = '4'

  try {
    const longHistory: ChatMessage[] = [
      { role: 'system', content: 'system' },
      ...Array.from({ length: 16 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `message-${i}-${'x'.repeat(120)}`,
      })),
    ]
    const provider = new StubProvider([
      {
        role: 'assistant',
        content: 'done',
        finish_reason: 'stop',
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ])

    const result = await runLoop({
      provider,
      registry: new ToolRegistry(),
      systemPrompt: 'unused',
      userPrompt: 'go',
      cwd: process.cwd(),
      maxTurns: 5,
      initialItems: messagesToItems(longHistory),
      persistInitialMessages: false,
    })

    assert.equal(result.terminal, 'completed')
    assert.equal(result.state.hasAttemptedReactiveCompact, true)
    const summaryCount = renderedMessages(result.state.items).filter(
      (m) => typeof m.content === 'string' && m.content.includes('Conversation compact summary')
    ).length
    assert.equal(summaryCount, 1)
  } finally {
    if (previous === undefined) {
      delete process.env.MERLION_COMPACT_TRIGGER_CHARS
    } else {
      process.env.MERLION_COMPACT_TRIGGER_CHARS = previous
    }
    delete process.env.MERLION_COMPACT_KEEP_RECENT
  }
})

test('loop injects correction hint after repeated identical tool errors', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('always_fail', { path: '.merlion/nanobot/channels/weixin.py' }, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('always_fail', { path: '.merlion/nanobot/channels/weixin.py' }, 'call_2')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('always_fail', { path: '.merlion/nanobot/channels/weixin.py' }, 'call_3')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done after retry',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeAlwaysFailTool())

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: '/workspace/nanobot',
    maxTurns: 10
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'done after retry')
  const hintMessages = renderedMessages(result.state.items).filter((m) => (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.includes('Repeated tool failure detected')
  ))
  assert.equal(hintMessages.length, 1)
  assert.match(hintMessages[0]?.content ?? '', /always_fail/)
  assert.match(hintMessages[0]?.content ?? '', /workspace root/)
  assert.match(hintMessages[0]?.content ?? '', /\/workspace\/nanobot\/\.merlion/)
  assert.match(hintMessages[0]?.content ?? '', /Do not use `~\/\.merlion`/)
})

test('loop appends post-tool batch messages from callback', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'ok' }, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done after retry',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeEchoTool())

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 6,
    onToolBatchComplete: () => messagesToItems([
      {
        role: 'system',
        content: 'Path guidance update: narrowed to src/runtime'
      }
    ])
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(
    renderedMessages(result.state.items).some((m) => m.role === 'system' && (m.content ?? '').includes('Path guidance update')),
    true
  )
})

test('loop injects immediate correction hint for invalid tool arguments', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', {}, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done after retry',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeEchoTool())

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 8
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'done after retry')
  const correctionMessage = renderedMessages(result.state.items).find((m) => (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.includes('Tool arguments were invalid for `echo_tool`')
  ))
  assert.ok(correctionMessage)
  assert.match(correctionMessage?.content ?? '', /strict JSON/i)
  assert.match(correctionMessage?.content ?? '', /required field/i)
  assert.match(correctionMessage?.content ?? '', /path:/i)
})

test('loop injects no-progress hint after consecutive all-error tool batches', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('always_fail', { path: 'a.txt' }, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('always_fail', { path: 'b.txt' }, 'call_2')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('always_fail', { path: 'c.txt' }, 'call_3')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done after retry',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeAlwaysFailTool())

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 10
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'done after retry')
  const noProgressMessages = renderedMessages(result.state.items).filter((m) => (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.includes('No progress detected')
  ))
  assert.equal(noProgressMessages.length, 1)
})

test('loop injects no-mutation hint after consecutive tool batches without file changes', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'scan-1' }, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'scan-2' }, 'call_2')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'scan-3' }, 'call_3')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'scan-4' }, 'call_4')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeEchoTool())

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 10
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'done')
  const noMutationMessages = renderedMessages(result.state.items).filter((m) => (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.includes('No material progress detected')
  ))
  assert.equal(noMutationMessages.length, 1)
})

test('loop injects bug-fix convergence hint earlier for repeated no-mutation batches', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'scan-1' }, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'scan-2' }, 'call_2')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('echo_tool', { value: 'scan-3' }, 'call_3')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeEchoTool())

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'Fix the regression in git branch handling.',
    cwd: process.cwd(),
    maxTurns: 10
  })

  assert.equal(result.terminal, 'completed')
  const convergenceMessages = renderedMessages(result.state.items).filter((m) => (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.includes('Bug-fix convergence:')
  ))
  assert.equal(convergenceMessages.length, 1)
  assert.match(convergenceMessages[0]?.content ?? '', /pick one likely implementation\/source file/i)
})

test('loop injects exploration budget hint after repeated read/search batches across multiple paths', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('read_file', { path: 'src/a.ts' }, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('read_file', { path: 'src/b.ts' }, 'call_2')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('read_file', { path: 'src/c.ts' }, 'call_3')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeAlwaysSuccessTool('read_file'))

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'Fix the regression in git branch handling.',
    cwd: '/workspace/repo',
    maxTurns: 10
  })

  assert.equal(result.terminal, 'completed')
  const explorationMessages = renderedMessages(result.state.items).filter((m) => (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.includes('Exploration budget exceeded')
  ))
  assert.equal(explorationMessages.length, 1)
  assert.match(explorationMessages[0]?.content ?? '', /inspected 3 path/)
})

test('loop injects verification reminder before concluding unvalidated code changes', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('edit_file', { path: 'src/auth.ts' }, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('bash', { command: 'npm test -- --runInBand' }, 'call_2')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'validated with npm test',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeAlwaysSuccessMutationTool('edit_file'))
  registry.register(makeAlwaysSuccessTool('bash'))

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'Update the authentication logic.',
    cwd: '/workspace/repo',
    maxTurns: 10
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'validated with npm test')
  const verificationMessages = renderedMessages(result.state.items).filter((m) => (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.includes('Before concluding a code-change task')
  ))
  assert.equal(verificationMessages.length, 1)
})

test('loop injects todo drift hint after repeated todo-only batches', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('todo_write', { todos: [{ content: 'inspect', status: 'in_progress' }] }, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('todo_write', { todos: [{ content: 'inspect', status: 'completed' }] }, 'call_2')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeAlwaysSuccessTool('todo_write'))

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'Fix the bug in parser behavior.',
    cwd: '/workspace/repo',
    maxTurns: 10
  })

  assert.equal(result.terminal, 'completed')
  const todoDriftMessages = renderedMessages(result.state.items).filter((m) => (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.includes('Todo drift detected')
  ))
  assert.equal(todoDriftMessages.length, 1)
})

test('loop injects large patch self-review hint for oversized edit diffs', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('edit_file', { path: 'src/auth.ts' }, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done and verified',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeEditDiffMutationTool('edit_file', 30, 15))

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'Update the authentication logic.',
    cwd: '/workspace/repo',
    maxTurns: 10
  })

  assert.equal(result.terminal, 'completed')
  const reviewMessages = renderedMessages(result.state.items).filter((m) => (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.includes('Large patch self-review')
  ))
  assert.equal(reviewMessages.length, 1)
  assert.match(reviewMessages[0]?.content ?? '', /src\/auth\.ts/)
})

test('loop injects overwrite-after-edit guardrail on same-path write_file after edit_file', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('edit_file', { path: 'src/auth.ts' }, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('write_file', { path: 'src/auth.ts', content: 'line\\n'.repeat(100) }, 'call_2')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done and verified',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeEditDiffMutationTool('edit_file', 1, 1))
  registry.register(makeAlwaysSuccessMutationTool('write_file'))

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'Update the authentication logic.',
    cwd: '/workspace/repo',
    maxTurns: 10
  })

  assert.equal(result.terminal, 'completed')
  const overwriteMessages = renderedMessages(result.state.items).filter((m) => (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.includes('Overwrite-after-edit guardrail')
  ))
  assert.equal(overwriteMessages.length, 1)
  assert.match(overwriteMessages[0]?.content ?? '', /edit_file .*write_file/i)
})

test('loop blocks premature completion after errored tool runs with no successful mutation', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('always_fail', { path: 'missing-a.txt' }, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('edit_file', { path: 'src/auth.ts' }, 'call_2')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'fixed and validated manually',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeAlwaysFailTool())
  registry.register(makeAlwaysSuccessMutationTool('edit_file'))

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: process.cwd(),
    maxTurns: 10
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'fixed and validated manually')
  const recoveryMessage = renderedMessages(result.state.items).find((m) => (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.includes('You have not made any successful file changes yet')
  ))
  assert.ok(recoveryMessage)
})

test('loop injects mutation oscillation hint on create/delete toggle', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('create_file', { path: 'tmp/a.txt', content: 'x' }, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('delete_file', { path: 'tmp/a.txt' }, 'call_2')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeAlwaysSuccessMutationTool('create_file'))
  registry.register(makeAlwaysSuccessMutationTool('delete_file'))

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'test',
    cwd: '/workspace/repo',
    maxTurns: 10
  })

  assert.equal(result.terminal, 'completed')
  assert.equal(result.finalText, 'done')
  const oscillationMessages = renderedMessages(result.state.items).filter((m) => (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.includes('Mutation oscillation detected')
  ))
  assert.equal(oscillationMessages.length, 1)
  assert.match(oscillationMessages[0]?.content ?? '', /create_file/)
  assert.match(oscillationMessages[0]?.content ?? '', /delete_file/)
})

test('loop injects bug-fix source-first hint when first successful mutation touches only tests', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('edit_file', { path: 'tests/rules/test_git_branch_exists.py' }, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeAlwaysSuccessMutationTool('edit_file'))

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'Fix the bug in git branch handling.',
    cwd: '/workspace/repo',
    maxTurns: 10
  })

  assert.equal(result.terminal, 'completed')
  const guardrailMessages = renderedMessages(result.state.items).filter((m) => (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.includes('Bug-fix guardrail:')
  ))
  assert.equal(guardrailMessages.length, 1)
  assert.match(guardrailMessages[0]?.content ?? '', /tests\/rules\/test_git_branch_exists\.py/)
  assert.match(guardrailMessages[0]?.content ?? '', /prefer implementation\/source changes first/i)
})

test('loop does not inject bug-fix source-first hint when first mutation is a source file', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('edit_file', { path: 'src/git_branch_exists.py' }, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeAlwaysSuccessMutationTool('edit_file'))

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'Fix the bug in git branch handling.',
    cwd: '/workspace/repo',
    maxTurns: 10
  })

  const guardrailMessages = renderedMessages(result.state.items).filter((m) => (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.includes('Bug-fix guardrail:')
  ))
  assert.equal(guardrailMessages.length, 0)
})

test('loop does not inject bug-fix source-first hint for explicit test-edit requests', async () => {
  const provider = new StubProvider([
    {
      role: 'assistant',
      content: null,
      finish_reason: 'tool_calls',
      tool_calls: [call('edit_file', { path: 'tests/auth.test.ts' }, 'call_1')],
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    },
    {
      role: 'assistant',
      content: 'done',
      finish_reason: 'stop',
      usage: { prompt_tokens: 1, completion_tokens: 1 }
    }
  ])

  const registry = new ToolRegistry()
  registry.register(makeAlwaysSuccessMutationTool('edit_file'))

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: 'system',
    userPrompt: 'Add a regression test in tests/auth.test.ts for the login flow.',
    cwd: '/workspace/repo',
    maxTurns: 10
  })

  const guardrailMessages = renderedMessages(result.state.items).filter((m) => (
    m.role === 'user' &&
    typeof m.content === 'string' &&
    m.content.includes('Bug-fix guardrail:')
  ))
  assert.equal(guardrailMessages.length, 0)
})
