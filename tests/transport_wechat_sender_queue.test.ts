import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'

import { SenderSerialQueue } from '../src/transport/wechat/sender_queue.ts'

async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('waitFor timeout')
    }
    await sleep(5)
  }
}

function createGate(): { promise: Promise<void>; release: () => void } {
  let release: (() => void) | null = null
  const promise = new Promise<void>((resolve) => {
    release = () => resolve()
  })
  return {
    promise,
    release: () => {
      if (!release) throw new Error('gate release function not initialized')
      release()
    },
  }
}

describe('transport/wechat/sender_queue', () => {
  test('serializes processing per sender and preserves FIFO order', async () => {
    const processed: number[] = []
    let inFlightA = 0
    let maxInFlightA = 0
    let queuedSignals = 0

    const queue = new SenderSerialQueue<{ id: number }>({
      maxPendingPerSender: 10,
      handler: async (_senderId, item) => {
        inFlightA += 1
        maxInFlightA = Math.max(maxInFlightA, inFlightA)
        await sleep(15)
        processed.push(item.id)
        inFlightA -= 1
      },
      onEnqueueWhileBusy: () => {
        queuedSignals += 1
      },
    })

    queue.enqueue('alice', { id: 1 })
    queue.enqueue('alice', { id: 2 })
    queue.enqueue('alice', { id: 3 })

    await waitFor(() => processed.length === 3)

    assert.deepEqual(processed, [1, 2, 3])
    assert.equal(maxInFlightA, 1, 'same sender must run serially')
    assert.ok(queuedSignals >= 2, 'later messages should be queued while sender is busy')
  })

  test('allows different senders to run concurrently', async () => {
    const aliceGate = createGate()
    const bobGate = createGate()
    const started = new Set<string>()
    const done = new Set<string>()

    const queue = new SenderSerialQueue<{ gate: Promise<void> }>({
      maxPendingPerSender: 10,
      handler: async (senderId, item) => {
        started.add(senderId)
        await item.gate
        done.add(senderId)
      },
    })

    queue.enqueue('alice', { gate: aliceGate.promise })
    queue.enqueue('bob', { gate: bobGate.promise })

    await waitFor(() => started.has('alice') && started.has('bob'))
    assert.equal(queue.isRunning('alice'), true)
    assert.equal(queue.isRunning('bob'), true)

    aliceGate.release()
    bobGate.release()
    await waitFor(() => done.has('alice') && done.has('bob'))
  })

  test('drops oldest pending item when sender queue is full', async () => {
    const firstGate = createGate()
    const processed: number[] = []
    let dropped = 0

    const queue = new SenderSerialQueue<{ id: number }>({
      maxPendingPerSender: 2,
      handler: async (_senderId, item) => {
        if (item.id === 1) await firstGate.promise
        processed.push(item.id)
      },
      onDropOldest: () => {
        dropped += 1
      },
    })

    queue.enqueue('alice', { id: 1 })
    await waitFor(() => queue.isRunning('alice'))

    queue.enqueue('alice', { id: 2 })
    queue.enqueue('alice', { id: 3 })
    queue.enqueue('alice', { id: 4 }) // drops id=2

    assert.equal(queue.pendingCount('alice'), 2)
    assert.equal(dropped, 1)

    firstGate.release()
    await waitFor(() => processed.length === 3)
    assert.deepEqual(processed, [1, 3, 4])
  })
})
