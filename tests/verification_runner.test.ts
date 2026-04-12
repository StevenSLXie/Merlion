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

test('runVerificationChecks skips when required command is missing', async () => {
  const cwd = await makeDir()
  const checks: VerificationCheck[] = [
    {
      id: 'needs_missing_bin',
      name: 'Needs Missing Bin',
      command: 'totally-missing-binary --version',
      requiresCommands: ['totally-missing-binary'],
    },
  ]
  const result = await runVerificationChecks({ cwd, checks })
  assert.equal(result.allPassed, true)
  assert.equal(result.results[0]?.status, 'skipped')
  assert.match(result.results[0]?.output ?? '', /missing command/i)
})

test('runVerificationChecks fires onCheckStart and onCheckResult for each check', async () => {
  const cwd = await makeDir()
  const checks: VerificationCheck[] = [
    { id: 'a', name: 'A', command: 'echo a' },
    { id: 'b', name: 'B', command: 'exit 1' },
  ]
  const startIds: string[] = []
  const resultIds: string[] = []

  await runVerificationChecks({
    cwd,
    checks,
    timeoutMs: 5000,
    onCheckStart: (check) => { startIds.push(check.id) },
    onCheckResult: (result) => { resultIds.push(result.id) },
  })

  assert.deepEqual(startIds, ['a', 'b'])
  assert.deepEqual(resultIds, ['a', 'b'])
})

test('runVerificationChecks captures stderr output', async () => {
  const cwd = await makeDir()
  const checks: VerificationCheck[] = [
    { id: 'stderr_check', name: 'Stderr Check', command: 'echo "error output" >&2; exit 1' },
  ]
  const result = await runVerificationChecks({ cwd, checks, timeoutMs: 5000 })
  assert.equal(result.results[0]?.status, 'failed')
  assert.match(result.results[0]?.output ?? '', /error output/)
})

test('runVerificationChecks truncates output at maxOutputChars', async () => {
  const cwd = await makeDir()
  const checks: VerificationCheck[] = [
    { id: 'verbose', name: 'Verbose', command: 'node -e "process.stdout.write(\'x\'.repeat(3000))"' },
  ]
  const result = await runVerificationChecks({ cwd, checks, timeoutMs: 5000, maxOutputChars: 120 })
  const output = result.results[0]?.output ?? ''
  assert.ok(output.length <= 220, `Output length (${output.length}) should respect low maxOutputChars`)
  assert.match(output, /truncated/, 'Truncation marker should be present')
})

test('runVerificationChecks does not skip when requiresAnyCommands has at least one available command', async () => {
  const cwd = await makeDir()
  const checks: VerificationCheck[] = [
    {
      id: 'any_cmd',
      name: 'Any Command',
      command: 'echo ok',
      requiresAnyCommands: ['definitely-missing-command-xyz', 'bash'],
    },
  ]
  const result = await runVerificationChecks({ cwd, checks, timeoutMs: 5000 })
  assert.equal(result.results[0]?.status, 'passed')
})

test('runVerificationChecks skips when all requiresAnyCommands are missing', async () => {
  const cwd = await makeDir()
  const checks: VerificationCheck[] = [
    {
      id: 'any_missing',
      name: 'Any Missing',
      command: 'echo ok',
      requiresAnyCommands: ['definitely-missing-command-xyz', 'another-missing-command-xyz'],
    },
  ]
  const result = await runVerificationChecks({ cwd, checks, timeoutMs: 5000 })
  assert.equal(result.results[0]?.status, 'skipped')
  assert.match(result.results[0]?.output ?? '', /missing any command/i)
})

test('runVerificationChecks allPassed is true when all checks are skipped', async () => {
  const cwd = await makeDir()
  delete process.env.MERLION_FAKE_KEY_A
  delete process.env.MERLION_FAKE_KEY_B
  const checks: VerificationCheck[] = [
    { id: 'skip1', name: 'Skip 1', command: 'exit 1', requiresEnv: ['MERLION_FAKE_KEY_A'] },
    { id: 'skip2', name: 'Skip 2', command: 'exit 1', requiresEnv: ['MERLION_FAKE_KEY_B'] },
  ]
  const result = await runVerificationChecks({ cwd, checks })
  assert.equal(result.allPassed, true)
  assert.ok(result.results.every((r) => r.status === 'skipped'))
})

test('runVerificationChecks records correct exitCode and durationMs', async () => {
  const cwd = await makeDir()
  const checks: VerificationCheck[] = [
    { id: 'exit5', name: 'Exit 5', command: 'exit 5' },
  ]
  const result = await runVerificationChecks({ cwd, checks, timeoutMs: 5000 })
  assert.equal(result.results[0]?.exitCode, 5)
  assert.ok((result.results[0]?.durationMs ?? -1) >= 0, 'durationMs should be non-negative')
})

test('runVerificationChecks settles promptly when parent exits and background child remains', async () => {
  const cwd = await makeDir()
  const checks: VerificationCheck[] = [
    {
      id: 'bg_stdio',
      name: 'Background stdio holder',
      command: 'node -e "setTimeout(() => {}, 2200)" & echo started',
    },
  ]

  const result = await runVerificationChecks({ cwd, checks, timeoutMs: 5_000 })
  const only = result.results[0]
  assert.equal(only?.status, 'passed')
  assert.match(only?.output ?? '', /started/)
  assert.ok((only?.durationMs ?? 9_999) < 1_800, `Expected fast settlement, got ${only?.durationMs ?? -1}ms`)
})
