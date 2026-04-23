/**
 * E2E: Real workspace-write sandbox execution for bash.
 *
 * The agent must use bash to write a file inside the sandbox root.
 * Verifies: macOS workspace-write runs under the real sandbox backend rather
 * than falling back to no sandbox.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { itemsToMessages } from '../../src/runtime/items.ts'
import { makeSandbox, rmSandbox, runSandboxedAgent, SKIP } from './helpers.ts'

const TARGET = 'sandbox_workspace_write.txt'

if (SKIP) {
  test.skip('E2E sandbox workspace-write: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'agent writes successfully under the real workspace-write sandbox backend',
    { timeout: 120_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        const { result, sandboxEvents } = await runSandboxedAgent(
          'Use the bash tool. Run exactly this shell command and do not use create_file, write_file, or edit_file: ' +
            `"printf 'workspace-write' > ${TARGET}". ` +
            'Then report the result.',
          sandbox,
          {
            scenario: 'e2e-sandbox-workspace-write',
            sandbox: {
              sandboxMode: 'workspace-write',
              approvalPolicy: 'never',
              networkMode: 'off',
            },
          },
        )

        assert.equal(result.terminal, 'completed', `Loop ended with: ${result.terminal}`)
        assert.equal(await readFile(join(sandbox, TARGET), 'utf8'), 'workspace-write')

        const calledBash = itemsToMessages(result.state.items).some(
          (message) =>
            message.role === 'assistant' &&
            message.tool_calls?.some((toolCall) => toolCall.function.name === 'bash'),
        )
        assert.ok(calledBash, 'Expected the bash tool to be called')

        assert.ok(
          sandboxEvents.some(
            (event) => event.type === 'sandbox.backend.selected' && event.backend === 'macos-sandbox-exec',
          ),
          `Expected macOS sandbox backend selection, got: ${JSON.stringify(sandboxEvents)}`,
        )
        assert.ok(
          !sandboxEvents.some((event) => event.type === 'sandbox.escalation.allowed'),
          `Did not expect escalation in workspace-write success path, got: ${JSON.stringify(sandboxEvents)}`,
        )
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
