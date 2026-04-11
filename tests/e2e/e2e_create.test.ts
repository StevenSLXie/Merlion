/**
 * E2E: Create file tool.
 *
 * The agent must create a new TypeScript file with a specified function.
 * Verifies: create_file tool execution, workspace file creation, and content correctness.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSandbox, rmSandbox, runAgent, SKIP } from './helpers.ts'

if (SKIP) {
  test.skip('E2E create: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'agent creates a new greet.ts file with a greet function',
    { timeout: 120_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        const result = await runAgent(
          'Create a new file called greet.ts. ' +
            'It must contain a single exported function named greet that takes a string ' +
            'parameter called name and returns the string "Hello, " concatenated with name.',
          sandbox,
          { scenario: 'e2e-create' },
        )

        assert.equal(result.terminal, 'completed', `Loop ended with: ${result.terminal}`)

        // File must exist and contain expected code
        const content = await readFile(join(sandbox, 'greet.ts'), 'utf8')
        assert.match(content, /greet/, 'greet.ts should define a "greet" identifier')
        assert.match(content, /Hello/, 'greet.ts should contain the "Hello" greeting string')
        assert.match(content, /export/, 'greet.ts should export the function')

        // Verify create_file was called, not edit_file or bash
        const assistantMessages = result.state.messages.filter(
          (m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0,
        )
        const calledCreate = assistantMessages.some((m) =>
          m.tool_calls?.some((tc) => tc.function.name === 'create_file'),
        )
        assert.ok(calledCreate, 'Expected create_file tool to be called')
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
