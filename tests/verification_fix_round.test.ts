import assert from 'node:assert/strict'
import test from 'node:test'

import { buildVerificationFixPrompt, runVerificationFixRounds } from '../src/verification/fix_round.ts'
import type { VerificationCheckResult, VerificationRunResult } from '../src/verification/runner.ts'

function failedRun(): VerificationRunResult {
  return {
    allPassed: false,
    results: [
      {
        id: 'test',
        name: 'Unit Tests',
        command: 'npm test',
        status: 'failed',
        durationMs: 10,
        exitCode: 1,
        output: '1 failing test',
        timedOut: false,
      },
    ],
  }
}

function passRun(): VerificationRunResult {
  return {
    allPassed: true,
    results: [
      {
        id: 'test',
        name: 'Unit Tests',
        command: 'npm test',
        status: 'passed',
        durationMs: 10,
        exitCode: 0,
        output: '',
        timedOut: false,
      },
    ],
  }
}

test('buildVerificationFixPrompt includes failed check details', () => {
  const prompt = buildVerificationFixPrompt(1, failedRun().results as VerificationCheckResult[])
  assert.match(prompt, /fix round 1/i)
  assert.match(prompt, /Unit Tests/)
  assert.match(prompt, /1 failing test/)
})

test('runVerificationFixRounds stops immediately when checks pass', async () => {
  const outcome = await runVerificationFixRounds({
    maxRounds: 2,
    runVerification: async () => passRun(),
    runFixTurn: async () => {
      throw new Error('should not run fix turn')
    },
  })
  assert.equal(outcome.passed, true)
  assert.equal(outcome.roundsUsed, 0)
})

test('runVerificationFixRounds runs fix turn and eventually passes', async () => {
  let call = 0
  let fixCalls = 0

  const outcome = await runVerificationFixRounds({
    maxRounds: 2,
    runVerification: async () => {
      call += 1
      return call === 1 ? failedRun() : passRun()
    },
    runFixTurn: async () => {
      fixCalls += 1
    },
  })

  assert.equal(outcome.passed, true)
  assert.equal(outcome.roundsUsed, 1)
  assert.equal(fixCalls, 1)
})

test('runVerificationFixRounds fails after max rounds', async () => {
  let fixCalls = 0
  const outcome = await runVerificationFixRounds({
    maxRounds: 1,
    runVerification: async () => failedRun(),
    runFixTurn: async () => {
      fixCalls += 1
    },
  })
  assert.equal(outcome.passed, false)
  assert.equal(outcome.roundsUsed, 1)
  assert.equal(fixCalls, 1)
})

test('runVerificationFixRounds with maxRounds=0 runs once and never calls fix turn', async () => {
  let fixCalls = 0
  const outcome = await runVerificationFixRounds({
    maxRounds: 0,
    runVerification: async () => failedRun(),
    runFixTurn: async () => {
      fixCalls += 1
    },
  })
  assert.equal(outcome.passed, false)
  assert.equal(outcome.roundsUsed, 0)
  assert.equal(fixCalls, 0)
})

test('buildVerificationFixPrompt includes all failed checks', () => {
  const results: VerificationCheckResult[] = [
    {
      id: 'test',
      name: 'Unit Tests',
      command: 'npm test',
      status: 'failed',
      durationMs: 10,
      exitCode: 1,
      output: '2 failing tests',
      timedOut: false,
    },
    {
      id: 'typecheck',
      name: 'TypeCheck',
      command: 'tsc --noEmit',
      status: 'failed',
      durationMs: 5,
      exitCode: 2,
      output: 'Type error in foo.ts',
      timedOut: false,
    },
  ]
  const prompt = buildVerificationFixPrompt(2, results)
  assert.match(prompt, /fix round 2/i)
  assert.match(prompt, /Unit Tests/)
  assert.match(prompt, /2 failing tests/)
  assert.match(prompt, /TypeCheck/)
  assert.match(prompt, /Type error in foo\.ts/)
})

test('buildVerificationFixPrompt truncates very long output', () => {
  const longOutput = 'x'.repeat(3000)
  const results: VerificationCheckResult[] = [
    {
      id: 'test',
      name: 'Big Output',
      command: 'npm test',
      status: 'failed',
      durationMs: 10,
      exitCode: 1,
      output: longOutput,
      timedOut: false,
    },
  ]
  const prompt = buildVerificationFixPrompt(1, results)
  // The prompt should not contain the full 3000-char output inline
  assert.ok(prompt.length < 3000, 'Prompt should be shorter than the raw output')
  assert.match(prompt, /\.\.\./, 'Truncation should be indicated with ellipsis')
})

test('runVerificationFixRounds emits onRound events with correct action', async () => {
  const events: Array<{ round: number; action: string }> = []
  let call = 0

  await runVerificationFixRounds({
    maxRounds: 2,
    runVerification: async () => {
      call += 1
      return call <= 1 ? failedRun() : passRun()
    },
    runFixTurn: async () => {},
    onRound: ({ round, action }) => {
      events.push({ round, action })
    },
  })

  assert.equal(events[0]?.action, 'fix', 'First round should emit fix action')
  assert.equal(events[1]?.action, 'pass', 'Second round should emit pass action')
})

test('runVerificationFixRounds sets lastVerification on outcome', async () => {
  const outcome = await runVerificationFixRounds({
    maxRounds: 1,
    runVerification: async () => passRun(),
    runFixTurn: async () => {},
  })
  assert.ok(outcome.lastVerification !== null, 'lastVerification must be set')
  assert.equal(outcome.lastVerification?.allPassed, true)
})

test('runVerificationFixRounds lastVerification reflects final run when failing', async () => {
  const outcome = await runVerificationFixRounds({
    maxRounds: 1,
    runVerification: async () => failedRun(),
    runFixTurn: async () => {},
  })
  assert.ok(outcome.lastVerification !== null)
  assert.equal(outcome.lastVerification?.allPassed, false)
})
