/**
 * E2E: Tool error recovery.
 *
 * The agent must gracefully handle a read_file error (file not found)
 * and complete the loop with terminal='completed' by reporting the error.
 *
 * Verifies: error propagation from tool to model, graceful recovery,
 * and that the loop does not crash or hang on tool failures.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { itemsToMessages } from '../../src/runtime/items.ts'
import { assertNoCostRegression, makeSandbox, rmSandbox, runSandboxedAgent, SKIP } from './helpers.ts'

if (SKIP) {
  test.skip('E2E tool-error: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'agent handles read_file error on missing file and completes',
    { timeout: 120_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        const { result, costGate } = await runSandboxedAgent(
          'Try to read a file called does_not_exist.txt. ' +
            'Tell me what error or message you received.',
          sandbox,
          { scenario: 'e2e-tool-error', deferCostGateFailure: true },
        )

        // The loop must complete — not crash or exhaust turns
        assert.equal(result.terminal, 'completed', `Loop ended with: ${result.terminal}`)

        // The agent must acknowledge the failure in its response
        const lowerText = result.finalText.toLowerCase()
        const mentionsFailure =
          lowerText.includes('not found') ||
          lowerText.includes('does not exist') ||
          lowerText.includes("doesn't exist") ||
          lowerText.includes('no such file') ||
          lowerText.includes('error') ||
          lowerText.includes('failed') ||
          lowerText.includes('could not')
        assert.ok(
          mentionsFailure,
          `Expected agent to mention the error, got: ${result.finalText}`,
        )

        // read_file must have been called (not avoided)
        const calledRead = itemsToMessages(result.state.items).some(
          (m) =>
            m.role === 'assistant' &&
            m.tool_calls?.some((tc) => tc.function.name === 'read_file'),
        )
        assert.ok(calledRead, 'Expected read_file to be called')
        assertNoCostRegression(costGate)
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
