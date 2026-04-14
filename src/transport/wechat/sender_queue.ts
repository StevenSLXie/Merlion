export interface SenderSerialQueueOptions<T> {
  maxPendingPerSender: number
  handler: (senderId: string, item: T) => Promise<void>
  shouldStop?: () => boolean
  onDropOldest?: (event: { senderId: string; maxPendingPerSender: number }) => void
  onEnqueueWhileBusy?: (event: { senderId: string; pending: number }) => void
}

/**
 * Per-sender FIFO queue:
 * - serial execution for the same sender
 * - concurrent execution across different senders
 * - bounded pending size per sender
 */
export class SenderSerialQueue<T> {
  private readonly maxPendingPerSender: number
  private readonly handler: (senderId: string, item: T) => Promise<void>
  private readonly shouldStop: () => boolean
  private readonly onDropOldest?: (event: { senderId: string; maxPendingPerSender: number }) => void
  private readonly onEnqueueWhileBusy?: (event: { senderId: string; pending: number }) => void
  private readonly pending = new Map<string, T[]>()
  private readonly running = new Set<string>()

  constructor(options: SenderSerialQueueOptions<T>) {
    this.maxPendingPerSender = Math.max(1, Math.floor(options.maxPendingPerSender))
    this.handler = options.handler
    this.shouldStop = options.shouldStop ?? (() => false)
    this.onDropOldest = options.onDropOldest
    this.onEnqueueWhileBusy = options.onEnqueueWhileBusy
  }

  enqueue(senderId: string, item: T): void {
    const queue = this.pending.get(senderId) ?? []
    if (queue.length >= this.maxPendingPerSender) {
      queue.shift()
      this.onDropOldest?.({ senderId, maxPendingPerSender: this.maxPendingPerSender })
    }
    queue.push(item)
    this.pending.set(senderId, queue)

    if (this.running.has(senderId)) {
      this.onEnqueueWhileBusy?.({ senderId, pending: queue.length })
      return
    }
    void this.drain(senderId)
  }

  pendingCount(senderId: string): number {
    return this.pending.get(senderId)?.length ?? 0
  }

  isRunning(senderId: string): boolean {
    return this.running.has(senderId)
  }

  private async drain(senderId: string): Promise<void> {
    if (this.running.has(senderId)) return
    this.running.add(senderId)
    try {
      for (;;) {
        if (this.shouldStop()) return
        const queue = this.pending.get(senderId)
        const next = queue?.shift()
        if (!next) {
          this.pending.delete(senderId)
          return
        }
        if (queue && queue.length === 0) this.pending.delete(senderId)
        await this.handler(senderId, next)
      }
    } finally {
      this.running.delete(senderId)
      if (this.shouldStop()) return
      if ((this.pending.get(senderId)?.length ?? 0) > 0) {
        void this.drain(senderId)
      }
    }
  }
}
