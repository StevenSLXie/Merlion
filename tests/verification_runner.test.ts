import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { VerificationCheck } from '../src/verification/checks.ts'
import { runVerificationChecks } from '../src/verification/runner.ts'

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'merlion-verify-run-'))
  await writeFile(join(dir, 'README.md'), 'x\n', 'utf8')
  return dir
}

test('runVerificationChecks handles pass/fail results', async () => {
  const cwd = await makeDir()
  const checks: VerificationCheck[] = [
    { id: 'pass', name: 'Pass', command: 'echo ok' },
    { id: 'fail', name: 'Fail', command: 'exit 2' },
  ]

  const result = await runVerificationChecks({ cwd, checks, timeoutMs: 5000 })
  assert.equal(result.allPassed, false)
  assert.equal(result.results[0]?.status, 'passed')
  assert.equal(result.results[1]?.status, 'failed')
})

test('runVerificationChecks skips when required env is missing', async () => {
  const cwd = await makeDir()
  delete process.env.MERLION_FAKE_SECRET
  const checks: VerificationCheck[] = [
    {
      id: 'needs_env',
      name: 'Needs Env',
      command: 'echo should-not-run',
      requiresEnv: ['MERLION_FAKE_SECRET'],
    },
  ]
  const result = await runVerificationChecks({ cwd, checks })
  assert.equal(result.allPassed, true)
  assert.equal(result.results[0]?.status, 'skipped')
  assert.match(result.results[0]?.output ?? '', /missing env/i)
})

test('runVerificationChecks marks timeout as failure', async () => {
  const cwd = await makeDir()
  const checks: VerificationCheck[] = [
    { id: 'slow', name: 'Slow', command: 'sleep 2' },
  ]
  const result = await runVerificationChecks({ cwd, checks, timeoutMs: 200 })
  assert.equal(result.results[0]?.status, 'failed')
  assert.equal(result.results[0]?.timedOut, true)
})
