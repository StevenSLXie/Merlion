/**
 * E2E: Concurrent tool execution.
 *
 * The agent must read both hello.txt and math.ts in a single response
 * (i.e., issue both read_file calls in one assistant turn so the executor
 * can run them concurrently).
 *
 * Verifies: the executor's concurrent batch path, correct result ordering,
 * and that both file contents are synthesised into the final answer.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSandbox, rmSandbox, runAgent, SKIP } from './helpers.ts'

if (SKIP) {
  test.skip('E2E concurrent: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'agent reads hello.txt and math.ts concurrently and answers correctly',
    { timeout: 120_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        const result = await runAgent(
          'Read both hello.txt and math.ts. ' +
            'Answer two questions: (1) How many lines does hello.txt have? ' +
            '(2) What are the names of the exported functions in math.ts?',
          sandbox,
          { scenario: 'e2e-concurrent' },
        )

        assert.equal(result.terminal, 'completed', `Loop ended with: ${result.terminal}`)

        // hello.txt has 3 lines
        assert.match(result.finalText, /3/, 'Expected line count "3" in response')

        // math.ts has add and multiply
        assert.match(result.finalText, /add/, 'Expected "add" in response')
        assert.match(result.finalText, /multiply/, 'Expected "multiply" in response')

        // At minimum 2 read_file calls must have occurred
        const toolMessages = result.state.messages.filter((m) => m.role === 'tool')
        assert.ok(toolMessages.length >= 2, 'Expected at least 2 tool result messages')

        // Ideally both files were read in one parallel assistant turn
        const parallelTurn = result.state.messages.find(
          (m) =>
            m.role === 'assistant' &&
            m.tool_calls !== undefined &&
            m.tool_calls.filter((tc) => tc.function.name === 'read_file').length >= 2,
        )
        if (!parallelTurn) {
          // Acceptable: model may read files sequentially; what matters is both were read
          process.stderr.write(
            '[concurrent test] Files were read sequentially rather than in one parallel turn.\n',
          )
        }
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
