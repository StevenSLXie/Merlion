/**
 * E2E: Verification fix-round integration (requires LLM).
 *
 * Full end-to-end flow: agent task → verification failure → agent fix → verification pass.
 *
 * Setup:
 *   - broken.js contains a deliberate syntax error (missing closing brace).
 *   - .merlion/verify.json declares a single check: `node --check broken.js`.
 *   - runVerificationFixRounds drives a real runLoop as the fix turn.
 *
 * Assertions:
 *   - outcome.passed === true (agent fixed the syntax error within 1 round).
 *   - The final verify run reports status=passed for the check.
 *   - broken.js on disk is valid JS after the fix.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSandbox, rmSandbox, runAgent, SKIP } from './helpers.ts'
import { discoverVerificationChecks } from '../../src/verification/checks.ts'
import { runVerificationChecks } from '../../src/verification/runner.ts'
import { runVerificationFixRounds } from '../../src/verification/fix_round.ts'

if (SKIP) {
  test.skip('E2E verify-fix-round: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'agent fixes syntax error and verification passes within one fix round',
    { timeout: 180_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        // ── Prepare broken.js ─────────────────────────────────────────────────
        // Deliberate syntax error: missing closing brace on the function body.
        const brokenCode = [
          'function add(a, b) {',
          '  return a + b;',
          '// missing closing brace — syntax error',
        ].join('\n') + '\n'
        await writeFile(join(sandbox, 'broken.js'), brokenCode, 'utf8')

        // ── Declare a verify config that checks syntax ─────────────────────────
        await mkdir(join(sandbox, '.merlion'), { recursive: true })
        await writeFile(
          join(sandbox, '.merlion', 'verify.json'),
          JSON.stringify({
            checks: [
              {
                id: 'syntax_check',
                name: 'Syntax Check',
                command: 'node --check broken.js',
              },
            ],
          }),
          'utf8',
        )

        // ── Confirm initial state: verification fails ─────────────────────────
        const initialChecks = await discoverVerificationChecks(sandbox)
        assert.equal(initialChecks.length, 1, 'Should discover exactly one check')

        const before = await runVerificationChecks({
          cwd: sandbox,
          checks: initialChecks,
          timeoutMs: 10_000,
        })
        assert.equal(
          before.results[0]?.status,
          'failed',
          'Syntax check must fail before fix',
        )

        // ── Run the fix-round loop with the real agent ─────────────────────────
        let fixRounds = 0
        const outcome = await runVerificationFixRounds({
          maxRounds: 2,
          runVerification: () =>
            runVerificationChecks({
              cwd: sandbox,
              checks: initialChecks,
              timeoutMs: 10_000,
            }),
          runFixTurn: async (prompt) => {
            fixRounds += 1
            await runAgent(
              `${prompt}\n\nThe file is broken.js in the project root.`,
              sandbox,
              { scenario: 'e2e-verify-fix-round' },
            )
          },
        })

        assert.equal(outcome.passed, true, `Verification must pass after fix (rounds used: ${fixRounds})`)
        assert.ok(fixRounds >= 1, 'At least one fix round must have been executed')

        // ── Verify the file is syntactically valid on disk ────────────────────
        const after = await runVerificationChecks({
          cwd: sandbox,
          checks: initialChecks,
          timeoutMs: 10_000,
        })
        assert.equal(after.results[0]?.status, 'passed', 'Syntax check must pass after agent fix')

        // File must be readable and contain a closing brace now
        const fixed = await readFile(join(sandbox, 'broken.js'), 'utf8')
        assert.match(fixed, /\}/, 'Fixed file must contain a closing brace')
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
