/**
 * E2E: Search tool.
 *
 * The agent must use the search tool to find function declarations in math.ts
 * and report both function names.
 *
 * Verifies: search tool execution, result parsing, and answer extraction.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { itemsToMessages } from '../../src/runtime/items.ts'
import {
  assertArchivedCostGateContract,
  assertNoCostRegression,
  makeSandbox,
  rmSandbox,
  runSandboxedAgent,
  SKIP,
} from './helpers.ts'

if (SKIP) {
  test.skip('E2E search: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'agent uses search to find exported functions in math.ts',
    { timeout: 120_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        const { result, costGate } = await runSandboxedAgent(
          'Use the search tool to find all occurrences of "export function" in math.ts. ' +
            'Report the names of every function you found.',
          sandbox,
          { scenario: 'e2e-search', deferCostGateFailure: true },
        )

        assert.equal(result.terminal, 'completed', `Loop ended with: ${result.terminal}`)

        // Both function names must appear in the response
        assert.match(result.finalText, /add/, 'Expected "add" in response')
        assert.match(result.finalText, /multiply/, 'Expected "multiply" in response')

        // Verify the search tool was actually called
        const assistantMessages = itemsToMessages(result.state.items).filter(
          (m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0,
        )
        const calledSearch = assistantMessages.some((m) =>
          m.tool_calls?.some((tc) => tc.function.name === 'search'),
        )
        assert.ok(calledSearch, 'Expected the search tool to be called')
        await assertArchivedCostGateContract(costGate, 'e2e-search')
        assertNoCostRegression(costGate)
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
