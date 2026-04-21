import test from 'node:test'
import assert from 'node:assert/strict'

import type { AssistantResponse, ChatMessage, ModelProvider, ToolCall } from '../../src/types.ts'
import { createContextService } from '../../src/context/service.ts'
import { itemsToMessages } from '../../src/runtime/items.ts'
import { QueryEngine } from '../../src/runtime/query_engine.ts'
import { createSubagentRuntime } from '../../src/runtime/subagents.ts'
import { createRuntimeState } from '../../src/runtime/state/types.ts'
import { createSessionFiles } from '../../src/runtime/session.ts'
import {
  makeProvider,
  makeRegistry,
  makeSandbox,
  rmSandbox,
  SKIP,
} from './helpers.ts'

function call(name: string, args: Record<string, unknown>, id = 'call_1'): ToolCall {
  return {
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  }
}

class ForegroundVerifierParentProvider implements ModelProvider {
  private step = 0

  async complete(messages: ChatMessage[]): Promise<AssistantResponse> {
    const lastToolMessage = [...messages].reverse().find((message) => message.role === 'tool')

    if (this.step === 0) {
      this.step += 1
      return {
        role: 'assistant',
        content: 'Launching a foreground verifier to validate the fixture facts.',
        finish_reason: 'tool_calls',
        tool_calls: [
          call('spawn_agent', {
            role: 'verifier',
            task: 'Verify that hello.txt contains exactly 3 lines and math.ts exports add and multiply. End with VERDICT: pass if both facts are confirmed.',
          }, 'spawn_1'),
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }
    }

    if (lastToolMessage?.content) {
      let parsed: { agentId?: string; status?: string } | null = null
      try {
        parsed = JSON.parse(lastToolMessage.content)
      } catch {
        parsed = null
      }
      if (parsed?.status === 'completed' && parsed.agentId) {
        return {
          role: 'assistant',
          content: 'The foreground verifier completed successfully.',
          finish_reason: 'stop',
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }
      }
    }

    throw new Error(`unexpected parent provider state at step=${this.step}`)
  }
}

if (SKIP) {
  test.skip('E2E live subagents: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'agent uses a foreground explorer subagent to inspect fixture files',
    { timeout: 180_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        const session = await createSessionFiles(sandbox)
        const registry = makeRegistry()
        const engine = new QueryEngine({
          cwd: sandbox,
          provider: makeProvider(),
          registry,
          permissions: { ask: async () => 'allow_session' },
          contextService: createContextService({
            cwd: sandbox,
            permissionMode: 'auto_allow',
          }),
          model: process.env.MERLION_E2E_MODEL ?? process.env.MERLION_MODEL ?? 'moonshotai/kimi-k2.5',
          createSubagentRuntime: ({ prompt, history, runtimeState, depth }) => createSubagentRuntime({
            cwd: sandbox,
            session,
            model: process.env.MERLION_E2E_MODEL ?? process.env.MERLION_MODEL ?? 'moonshotai/kimi-k2.5',
            parentRegistry: registry,
            permissions: { ask: async () => 'allow_session' },
            runtimeState: runtimeState ?? createRuntimeState(),
            history,
            prompt,
            depth,
            createProvider: () => makeProvider(),
            createContextService: () => createContextService({
              cwd: sandbox,
              permissionMode: 'auto_allow',
            }),
          }),
        })

        const result = await engine.submitPrompt(
          [
            'Use the `spawn_agent` tool exactly once with role `explorer` in foreground.',
            'Have the child inspect `hello.txt` and `math.ts`.',
            'Then answer with two facts only:',
            '1. the exact line count of hello.txt',
            '2. the exported function names in math.ts',
            'Do not answer from memory or by direct parent inspection; use the explorer child.',
          ].join('\n')
        )

        assert.equal(result.terminal, 'completed', `Loop ended with: ${result.terminal}`)
        assert.match(result.finalText, /\b3\b/, `Expected line count 3, got: ${result.finalText}`)
        assert.match(result.finalText, /\badd\b/i, `Expected add in final text, got: ${result.finalText}`)
        assert.match(result.finalText, /\bmultiply\b/i, `Expected multiply in final text, got: ${result.finalText}`)

        const toolMessages = itemsToMessages(result.state.items).filter((message) => message.role === 'tool')
        assert.ok(
          toolMessages.some((message) => (message.content ?? '').includes('"role": "explorer"')),
          'Expected spawn_agent explorer result in parent transcript',
        )
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )

  test(
    'foreground verifier subagent runs with a live child model and validates fixture facts',
    { timeout: 150_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        const session = await createSessionFiles(sandbox)
        const registry = makeRegistry()
        const engine = new QueryEngine({
          cwd: sandbox,
          provider: new ForegroundVerifierParentProvider(),
          registry,
          permissions: { ask: async () => 'allow_session' },
          contextService: createContextService({
            cwd: sandbox,
            permissionMode: 'auto_allow',
          }),
          model: process.env.MERLION_E2E_MODEL ?? process.env.MERLION_MODEL ?? 'moonshotai/kimi-k2.5',
          createSubagentRuntime: ({ prompt, history, runtimeState, depth }) => createSubagentRuntime({
            cwd: sandbox,
            session,
            model: process.env.MERLION_E2E_MODEL ?? process.env.MERLION_MODEL ?? 'moonshotai/kimi-k2.5',
            parentRegistry: registry,
            permissions: { ask: async () => 'allow_session' },
            runtimeState: runtimeState ?? createRuntimeState(),
            history,
            prompt,
            depth,
            createProvider: () => makeProvider(),
            createContextService: () => createContextService({
              cwd: sandbox,
              permissionMode: 'auto_allow',
            }),
          }),
        })

        const result = await engine.submitPrompt('Run the planned foreground verifier flow.')

        assert.equal(result.terminal, 'completed', `Loop ended with: ${result.terminal}`)
        assert.match(result.finalText, /foreground verifier completed successfully/i, `Expected completion summary, got: ${result.finalText}`)

        const toolMessages = itemsToMessages(result.state.items).filter((message) => message.role === 'tool')
        assert.ok(
          toolMessages.some((message) => (message.content ?? '').includes('"role": "verifier"')),
          'Expected verifier subagent result in parent transcript',
        )
        assert.ok(
          toolMessages.some((message) => (message.content ?? '').includes('"status": "completed"')),
          'Expected completed child result in parent transcript',
        )
        assert.ok(
          toolMessages.some((message) => (message.content ?? '').includes('"verdict": "pass"')),
          'Expected verifier verdict pass in child result',
        )
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
