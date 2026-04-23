/**
 * E2E: Read-only sandbox escalation on failure.
 *
 * The agent must use bash to write a file. The first attempt runs inside a real
 * read-only sandbox, then the tool escalates outside the sandbox on failure.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { itemsToMessages } from '../../src/runtime/items.ts'
import { makeSandbox, rmSandbox, runSandboxedAgent, SKIP } from './helpers.ts'

const TARGET = 'sandbox_escalated.txt'

if (SKIP) {
  test.skip('E2E sandbox on-failure escalation: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'agent escalates out of read-only sandbox after bash write fails',
    { timeout: 120_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        const { result, sandboxEvents } = await runSandboxedAgent(
          'Use the bash tool. Run exactly this shell command and do not use create_file, write_file, or edit_file: ' +
            `"printf 'sandbox-escalated' > ${TARGET}". ` +
            'If the first attempt fails because of the sandbox, continue and tell me the final outcome.',
          sandbox,
          {
            scenario: 'e2e-sandbox-on-failure-escalation',
            sandbox: {
              sandboxMode: 'read-only',
              approvalPolicy: 'on-failure',
              networkMode: 'off',
            },
          },
        )

        assert.equal(result.terminal, 'completed', `Loop ended with: ${result.terminal}`)
        const content = await readFile(join(sandbox, TARGET), 'utf8')
        assert.equal(content, 'sandbox-escalated')

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
        assert.ok(
          sandboxEvents.some((event) => event.type === 'sandbox.escalation.requested'),
          `Expected escalation request event, got: ${JSON.stringify(sandboxEvents)}`,
        )
        assert.ok(
          sandboxEvents.some((event) => event.type === 'sandbox.escalation.allowed'),
          `Expected escalation allowed event, got: ${JSON.stringify(sandboxEvents)}`,
        )
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
