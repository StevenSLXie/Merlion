/**
 * E2E: Reactive context compaction.
 *
 * Pre-populates the loop with a synthetic message history long enough to
 * exceed a very low trigger threshold. The compact check fires before the
 * first real model call, compresses the middle of the history, and sets
 * state.hasAttemptedReactiveCompact = true.
 *
 * Verifies:
 *   1. hasAttemptedReactiveCompact is true after the run.
 *   2. The loop does not end with model_error (compact → continue works).
 *   3. The actual task (read hello.txt → report first line) completes.
 *
 * Uses env-var overrides to keep the test fast and deterministic.
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from '../../src/types.js'

import { makeSandbox, rmSandbox, SKIP, makeProvider, makeRegistry, SYSTEM_PROMPT } from './helpers.ts'
import { runLoop } from '../../src/runtime/loop.ts'

/** Build a 7-message fake conversation history (no tool calls). */
function makeFakeHistory(): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',      content: 'Can you help me with TypeScript?                                    ' },
    { role: 'assistant', content: 'Yes, I can help with TypeScript projects.                           ' },
    { role: 'user',      content: 'How do I declare a type?                                            ' },
    { role: 'assistant', content: 'Use the `type` keyword: `type Foo = { bar: string }`.               ' },
    { role: 'user',      content: 'And an interface?                                                   ' },
    { role: 'assistant', content: 'Use `interface Foo { bar: string }`. Both are similar in practice.  ' },
  ]
}

if (SKIP) {
  test.skip('E2E compact: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'reactive compaction fires on oversized context and loop continues to completion',
    { timeout: 120_000 },
    async () => {
      const sandbox = await makeSandbox()

      // Lower threshold so the pre-populated 7-message history (> 400 chars) triggers
      // compaction immediately before the first model call.
      const prevTrigger = process.env.MERLION_COMPACT_TRIGGER_CHARS
      const prevKeep    = process.env.MERLION_COMPACT_KEEP_RECENT
      process.env.MERLION_COMPACT_TRIGGER_CHARS = '100'
      process.env.MERLION_COMPACT_KEEP_RECENT   = '3'

      try {
        const result = await runLoop({
          provider: makeProvider(),
          registry: makeRegistry(),
          // systemPrompt is ignored — provided via initialMessages
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: 'Read hello.txt and tell me the content of the first line.',
          cwd: sandbox,
          initialMessages: makeFakeHistory(),
          maxTurns: 15,
          permissions: { ask: async () => 'allow_session' },
        })

        // Compaction must have fired
        assert.ok(
          result.state.hasAttemptedReactiveCompact,
          'hasAttemptedReactiveCompact must be true after compaction',
        )

        // Loop must not crash due to the compacted context
        assert.notEqual(result.terminal, 'model_error', 'Loop must not end with model_error')

        // If the task completed, the agent should mention the first line
        if (result.terminal === 'completed') {
          assert.match(
            result.finalText,
            /Hello from Merlion/i,
            `Expected first-line content in response, got: ${result.finalText}`,
          )
        }
      } finally {
        if (prevTrigger === undefined) delete process.env.MERLION_COMPACT_TRIGGER_CHARS
        else process.env.MERLION_COMPACT_TRIGGER_CHARS = prevTrigger
        if (prevKeep === undefined) delete process.env.MERLION_COMPACT_KEEP_RECENT
        else process.env.MERLION_COMPACT_KEEP_RECENT = prevKeep
        await rmSandbox(sandbox)
      }
    },
  )
}
