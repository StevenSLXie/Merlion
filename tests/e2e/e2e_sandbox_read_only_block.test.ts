/**
 * E2E: Real read-only sandbox enforcement for bash.
 *
 * The agent must use bash to attempt a file write inside a read-only sandbox.
 * Verifies: real sandbox backend selection, violation emission, and no file creation.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { itemsToMessages } from '../../src/runtime/items.ts'
import { makeSandbox, rmSandbox, runSandboxedAgent, SKIP } from './helpers.ts'

const TARGET = 'sandbox_blocked.txt'

if (SKIP) {
  test.skip('E2E sandbox read-only block: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'agent hits real read-only sandbox when bash tries to write a file',
    { timeout: 120_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        const { result, sandboxEvents } = await runSandboxedAgent(
          'Use the bash tool. Run exactly this shell command and do not use create_file, write_file, or edit_file: ' +
            `"printf 'sandbox-blocked' > ${TARGET}". ` +
            'Then tell me whether the command succeeded or failed.',
          sandbox,
          {
            scenario: 'e2e-sandbox-read-only-block',
            sandbox: {
              sandboxMode: 'read-only',
              approvalPolicy: 'never',
              networkMode: 'off',
            },
          },
        )

        assert.equal(result.terminal, 'completed', `Loop ended with: ${result.terminal}`)
        await assert.rejects(() => access(join(sandbox, TARGET), constants.F_OK))

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
          sandboxEvents.some((event) => event.type === 'sandbox.violation'),
          `Expected sandbox violation event, got: ${JSON.stringify(sandboxEvents)}`,
        )
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
