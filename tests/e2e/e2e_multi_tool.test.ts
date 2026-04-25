/**
 * E2E: Multi-tool task.
 *
 * The agent must: read hello.txt, then create a new file output.txt
 * containing only the first line of hello.txt.
 *
 * Verifies: sequential read_file → create_file, content correctness,
 * and that the agent does not exceed the tool call chain.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
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
  test.skip('E2E multi-tool: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'agent reads hello.txt and creates output.txt with only the first line',
    { timeout: 120_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        const { result, costGate } = await runSandboxedAgent(
          'Read hello.txt. Then create a new file called output.txt that contains ' +
            'only the first line of hello.txt (no trailing newline is fine). ' +
            'Do not modify hello.txt.',
          sandbox,
          { scenario: 'e2e-multi-tool', deferCostGateFailure: true },
        )

        assert.equal(result.terminal, 'completed', `Loop ended with: ${result.terminal}`)

        // output.txt must exist and contain the first line of hello.txt
        const content = await readFile(join(sandbox, 'output.txt'), 'utf8')
        assert.match(
          content,
          /Hello from Merlion fixture file/,
          `output.txt should start with the first line, got: ${content}`,
        )

        // hello.txt must be untouched
        const original = await readFile(join(sandbox, 'hello.txt'), 'utf8')
        assert.match(original, /Hello from Merlion fixture file/)
        assert.match(original, /Line two is here/)
        assert.match(original, /Line three is the last/)

        // At minimum: read_file + create_file calls
        const toolMessages = itemsToMessages(result.state.items).filter((m) => m.role === 'tool')
        assert.ok(toolMessages.length >= 2, 'Expected at least 2 tool calls')
        await assertArchivedCostGateContract(costGate, 'e2e-multi-tool')
        assertNoCostRegression(costGate)
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
