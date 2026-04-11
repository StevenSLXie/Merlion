export interface RetryOptions {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

function extractStatusCode(message: string): number | null {
  const match = message.match(/\b(400|401|403|429|500|502|503|529)\b/)
  return match ? Number(match[1]) : null
}

function isRetryableError(error: unknown): boolean {
  const message = String(error)
  const code = extractStatusCode(message)
  if (code === null) {
    return /ECONNRESET|EPIPE|ENOTFOUND|ETIMEDOUT/i.test(message)
  }
  return code === 429 || code === 500 || code === 502 || code === 503 || code === 529
}

function isPermanentError(error: unknown): boolean {
  const message = String(error)
  const code = extractStatusCode(message)
  return code === 400 || code === 401 || code === 403
}

function delay(attempt: number, baseDelayMs: number, maxDelayMs: number): Promise<void> {
  const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)))
  const jitter = Math.floor(exp * 0.25 * Math.random())
  return new Promise((resolve) => setTimeout(resolve, exp + jitter))
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let attempt = 0
  let lastError: unknown = undefined

  while (attempt < options.maxAttempts) {
    attempt += 1
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (isPermanentError(error)) throw error
      if (!isRetryableError(error) || attempt >= options.maxAttempts) throw error
      await delay(attempt, options.baseDelayMs, options.maxDelayMs)
    }
  }

  throw lastError ?? new Error('Retry exhausted')
}

