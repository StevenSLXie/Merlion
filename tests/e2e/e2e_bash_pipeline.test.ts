/**
 * E2E: Bash pipeline.
 *
 * The agent must run a shell pipeline (wc -l) to count lines in hello.txt
 * and report the result.
 *
 * Verifies: bash tool with piped commands, numeric output extraction,
 * and correct answer reporting.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSandbox, rmSandbox, runAgent, SKIP } from './helpers.ts'

if (SKIP) {
  test.skip('E2E bash-pipeline: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'agent counts lines in hello.txt via bash and reports 3',
    { timeout: 120_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        const result = await runAgent(
          'Use bash to count the number of lines in hello.txt. ' +
            'Report only the exact number.',
          sandbox,
          { scenario: 'e2e-bash-pipeline' },
        )

        assert.equal(result.terminal, 'completed', `Loop ended with: ${result.terminal}`)

        // hello.txt has exactly 3 lines
        assert.match(
          result.finalText,
          /3/,
          `Expected finalText to contain "3", got: ${result.finalText}`,
        )

        // Verify bash was called
        const assistantMessages = result.state.messages.filter(
          (m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0,
        )
        const calledBash = assistantMessages.some((m) =>
          m.tool_calls?.some((tc) => tc.function.name === 'bash'),
        )
        assert.ok(calledBash, 'Expected bash tool to be called')
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
