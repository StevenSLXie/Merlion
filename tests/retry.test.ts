import test from 'node:test'
import assert from 'node:assert/strict'

import { withRetry } from '../src/runtime/retry.ts'

test('retries transient errors then succeeds', async () => {
  let count = 0
  const result = await withRetry(async () => {
    count += 1
    if (count < 3) {
      throw new Error('Provider error 503: overloaded')
    }
    return 'ok'
  }, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 })

  assert.equal(result, 'ok')
  assert.equal(count, 3)
})

test('does not retry permanent errors', async () => {
  let count = 0
  await assert.rejects(
    () =>
      withRetry(async () => {
        count += 1
        throw new Error('Provider error 401: invalid key')
      }, { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 2 }),
    /401/
  )
  assert.equal(count, 1)
})

test('fails after max attempts', async () => {
  let count = 0
  await assert.rejects(
    () =>
      withRetry(async () => {
        count += 1
        throw new Error('Provider error 503: overloaded')
      }, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 }),
    /503/
  )
  assert.equal(count, 3)
})

