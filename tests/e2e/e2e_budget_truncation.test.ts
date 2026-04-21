/**
 * E2E: Tool result budget truncation.
 *
 * Creates a 300-line file (exceeds the 220-line default limit) and asks the
 * agent to read it. Verifies that:
 *   1. The executor truncated the tool result (marker present in tool message).
 *   2. Head/tail preservation means the agent can still see both the first
 *      line (sentinel A) and the last line (sentinel B).
 *   3. The loop completes despite receiving a truncated result.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { itemsToMessages } from '../../src/runtime/items.ts'
import { makeSandbox, rmSandbox, runAgent, SKIP } from './helpers.ts'

const FIRST_SENTINEL = 'alpha-truncation-sentinel'
const LAST_SENTINEL  = 'omega-truncation-sentinel'
const LINE_COUNT     = 300   // exceeds default maxLines=220

/** Build a file whose first and last lines have unique sentinels. */
function makeLargeFile(lines: number): string {
  const rows: string[] = []
  rows.push(`FIRST_LINE: ${FIRST_SENTINEL}`)
  for (let i = 2; i < lines; i++) {
    rows.push(`Line ${i}: padding content to exceed the default budget limit in this test file`)
  }
  rows.push(`LAST_LINE: ${LAST_SENTINEL}`)
  return rows.join('\n') + '\n'
}

if (SKIP) {
  test.skip('E2E budget-truncation: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'executor truncates a 300-line read_file result and agent still sees both sentinels',
    { timeout: 120_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        await writeFile(join(sandbox, 'large_file.txt'), makeLargeFile(LINE_COUNT), 'utf8')

        const result = await runAgent(
          'Read large_file.txt. Tell me the exact content of the very first line ' +
            'and the very last line.',
          sandbox,
          { scenario: 'e2e-budget-truncation' },
        )

        assert.equal(result.terminal, 'completed', `Loop ended with: ${result.terminal}`)

        // The tool result must carry a truncation marker
        const toolMessages = itemsToMessages(result.state.items).filter((m) => m.role === 'tool')
        const truncated = toolMessages.some(
          (m) => typeof m.content === 'string' && m.content.includes('truncated'),
        )
        assert.ok(truncated, 'Expected at least one tool result to contain a truncation marker')

        // Head preserves line 1 → agent reports first sentinel
        assert.match(
          result.finalText,
          new RegExp(FIRST_SENTINEL),
          `Agent should report the first-line sentinel.\nGot: ${result.finalText}`,
        )

        // Tail preserves line 300 → agent reports last sentinel
        assert.match(
          result.finalText,
          new RegExp(LAST_SENTINEL),
          `Agent should report the last-line sentinel.\nGot: ${result.finalText}`,
        )
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
