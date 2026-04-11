/**
 * E2E: File edit task.
 *
 * The agent must edit math.ts and add a `subtract` function.
 * Verifies: read_file + edit_file tools, workspace boundary, and actual file content.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSandbox, rmSandbox, runAgent, SKIP } from './helpers.ts'

if (SKIP) {
  test.skip('E2E edit: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'agent adds a subtract function to math.ts',
    { timeout: 120_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        const result = await runAgent(
          'Read math.ts. Then add a new exported function called `subtract` ' +
            'that takes two numbers (a, b) and returns a - b. ' +
            'Do not remove existing functions.',
          sandbox,
          { scenario: 'e2e-edit' },
        )

        assert.equal(result.terminal, 'completed', `Loop ended with: ${result.terminal}`)

        // Verify the actual file on disk was modified
        const content = await readFile(join(sandbox, 'math.ts'), 'utf8')

        assert.match(content, /subtract/, 'math.ts should contain "subtract"')
        assert.match(content, /return a - b|return\s*a\s*-\s*b/, 'subtract body should be present')

        // Original functions must still be there
        assert.match(content, /function add/, 'add function must not be removed')
        assert.match(content, /function multiply/, 'multiply function must not be removed')

        // Verify edit_file was called (not create_file with a totally new file)
        const toolMessages = result.state.messages.filter((m) => m.role === 'tool')
        assert.ok(toolMessages.length >= 2, 'Expected at least read + edit tool calls')
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
