/**
 * E2E: Bash task.
 *
 * The agent must run a shell command and report output.
 * Verifies: bash tool execution and output plumbing through the loop.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSandbox, rmSandbox, runAgent, SKIP } from './helpers.ts'

// Sentinel value embedded in the task so we can assert the agent saw the right output.
const SENTINEL = 'merlion-e2e-sentinel-9f3a'

if (SKIP) {
  test.skip('E2E bash: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'agent runs echo command and reports the output',
    { timeout: 120_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        const result = await runAgent(
          `Run the command: echo "${SENTINEL}" and tell me exactly what was printed.`,
          sandbox,
          { scenario: 'e2e-bash' },
        )

        assert.equal(result.terminal, 'completed', `Loop ended with: ${result.terminal}`)

        // The agent must mention the sentinel in its response
        assert.match(
          result.finalText,
          new RegExp(SENTINEL),
          `Expected finalText to contain sentinel "${SENTINEL}", got: ${result.finalText}`,
        )

        // Verify bash was actually called
        const assistantMessages = result.state.messages.filter(
          (m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0,
        )
        const calledBash = assistantMessages.some((m) =>
          m.tool_calls?.some((tc) => tc.function.name === 'bash'),
        )
        assert.ok(calledBash, 'Expected the bash tool to be called')
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
