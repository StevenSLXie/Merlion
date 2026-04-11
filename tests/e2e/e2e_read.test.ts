/**
 * E2E: Read-only task.
 *
 * The agent must read hello.txt (3 lines) and report the line count.
 * No file writes, no bash. Verifies: read_file tool + answer extraction.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSandbox, rmSandbox, runAgent, SKIP } from './helpers.ts'

if (SKIP) {
  test.skip('E2E read: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'agent reads hello.txt and reports the correct line count',
    { timeout: 120_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        const result = await runAgent(
          'Read the file hello.txt and tell me exactly how many lines it contains.',
          sandbox,
        )

        assert.equal(result.terminal, 'completed', `Loop ended with: ${result.terminal}`)

        // hello.txt has exactly 3 lines — agent must state "3" in its answer
        assert.match(
          result.finalText,
          /\b3\b/,
          `Expected answer to contain "3", got: ${result.finalText}`,
        )

        // Verify the agent actually called read_file (not just guessed)
        const toolMessages = result.state.messages.filter((m) => m.role === 'tool')
        assert.ok(
          toolMessages.length > 0,
          'Expected at least one tool call (read_file)',
        )
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
