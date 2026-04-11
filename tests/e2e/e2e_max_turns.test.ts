/**
 * E2E: Max-turns terminal condition.
 *
 * The loop must return terminal='max_turns_exceeded' when the turn budget runs out
 * before the task completes.
 *
 * Strategy: set maxTurns=1 and give the agent a task that forces a tool call
 * (echo a unique string). After the first assistant turn makes the bash call,
 * the loop exhausts its budget before the model can respond with the final answer.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSandbox, rmSandbox, SKIP, makeProvider, makeRegistry, SYSTEM_PROMPT } from './helpers.ts'
import { runLoop } from '../../src/runtime/loop.ts'

if (SKIP) {
  test.skip('E2E max-turns: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'loop returns max_turns_exceeded when turn budget is exhausted',
    { timeout: 120_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        // maxTurns=1: after the first assistant response (which must call bash),
        // the next loop iteration hits the turn cap and returns max_turns_exceeded.
        const result = await runLoop({
          provider: makeProvider(),
          registry: makeRegistry(),
          systemPrompt: SYSTEM_PROMPT,
          userPrompt:
            'Run this exact bash command and report its output: echo merlion-max-turns-sentinel',
          cwd: sandbox,
          maxTurns: 1,
          permissions: { ask: async () => 'allow_session' },
        })

        assert.equal(
          result.terminal,
          'max_turns_exceeded',
          `Expected max_turns_exceeded, got: ${result.terminal}`,
        )

        // The state should record exactly 1 completed turn
        assert.equal(result.state.turnCount, 1, 'turnCount should be 1 after single-turn budget')
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
