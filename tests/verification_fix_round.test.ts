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
