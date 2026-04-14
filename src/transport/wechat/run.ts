import { loginWithQRCode } from './auth.ts'
import { loadWeixinCredentials, type WeixinCredentials } from './store.ts'
import {
  getUpdates,
  sendMessage,
  SESSION_EXPIRED_ERRCODE,
  WECHAT_SEND_RATE_LIMIT_ERRCODE,
  WeixinApiError,
  DEFAULT_POLL_TIMEOUT_MS,
  type WeixinMessage,
} from './api.ts'
import { toPlainText, splitForWeixin } from './text_render.ts'
import { SenderSerialQueue } from './sender_queue.ts'
import { OpenAICompatProvider } from '../../providers/openai.ts'
import { buildDefaultRegistry } from '../../tools/builtin/index.ts'
import { createPermissionStore } from '../../permissions/store.ts'
import { createPromptSectionCache } from '../../prompt/sections.ts'
import { buildMerlionSystemPrompt } from '../../prompt/system_prompt.ts'
import { runLoop, type RunLoopResult } from '../../runtime/loop.ts'
import type { ChatMessage } from '../../types.ts'

const MAX_CONSECUTIVE_FAILURES = 3
const BACKOFF_DELAY_MS = 30_000
const RETRY_DELAY_MS = 2_000
const MAX_SEEN_MESSAGE_IDS = 1000
const MAX_HISTORY_MESSAGES = 80  // per sender; trim oldest user+assistant pairs
const MAX_PENDING_PER_SENDER = 20
const DEFAULT_WECHAT_MAX_TURNS = 50
const DEFAULT_WECHAT_MAX_PROGRESS_UPDATES = 10
const SEND_RETRY_ATTEMPTS = 3
const SEND_RETRY_DELAY_MS = 800

export interface WeixinRunOptions {
  model: string
  baseURL: string
  apiKey: string
  cwd: string
  forceLogin?: boolean
  permissionMode?: 'interactive' | 'auto_allow' | 'auto_deny'
}

export interface WeixinPermissionResolution {
  mode: 'auto_allow' | 'auto_deny'
  notice?: string
}

export function resolveWeixinPermissionMode(
  mode: 'interactive' | 'auto_allow' | 'auto_deny' | undefined,
): WeixinPermissionResolution {
  if (mode === 'auto_deny') return { mode: 'auto_deny' }
  if (mode === 'auto_allow') return { mode: 'auto_allow' }
  return {
    mode: 'auto_allow',
    notice:
      'interactive approval is not supported in WeChat mode; defaulting to --auto-allow. Use --auto-deny to block risky tools.',
  }
}

interface PendingInboundMessage {
  text: string
  contextToken?: string
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  const value = Math.floor(parsed)
  if (value <= 0) return fallback
  return Math.min(value, 300)
}

export function isWeixinProgressEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false
  const normalized = raw.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

export function isWeixinVerboseProgressEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false
  const normalized = raw.trim().toLowerCase()
  return normalized === '1' || normalized === 'true' || normalized === 'yes'
}

function shouldRetrySendError(error: unknown): boolean {
  if (error instanceof WeixinApiError) {
    if (error.errcode === WECHAT_SEND_RATE_LIMIT_ERRCODE) return false
    if (error.errcode === SESSION_EXPIRED_ERRCODE) return false
  }
  return true
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) }, { once: true })
  })
}

function extractText(msg: WeixinMessage): string | null {
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text?.trim()) {
      return item.text_item.text.trim()
    }
  }
  return null
}

function trimHistory(history: ChatMessage[]): ChatMessage[] {
  if (history.length <= MAX_HISTORY_MESSAGES) return history
  // Always keep the leading system message(s)
  const firstNonSystem = history.findIndex((m) => m.role !== 'system')
  const systemBoundary = firstNonSystem < 0 ? history.length : firstNonSystem
  const systemMessages = history.slice(0, systemBoundary)
  if (systemMessages.length >= MAX_HISTORY_MESSAGES) {
    return systemMessages.slice(-MAX_HISTORY_MESSAGES)
  }
  const rest = history.slice(systemBoundary)
  const keep = rest.slice(-Math.max(MAX_HISTORY_MESSAGES - systemMessages.length, 20))
  return [...systemMessages, ...keep]
}

function findLastAssistantText(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.role !== 'assistant') continue
    const text = msg.content?.trim()
    if (text) return text
  }
  return null
}

export function renderWeixinReply(result: RunLoopResult): string {
  const direct = result.finalText?.trim()
  if (direct) return direct

  const fallbackAssistant = findLastAssistantText(result.state.messages)
  if (fallbackAssistant) return fallbackAssistant

  if (result.terminal === 'max_turns_exceeded') {
    return `未能在当前步数预算内完成（${result.state.turnCount} 轮）。请把任务拆小一点，或先让我只做一个子任务。`
  }
  if (result.terminal === 'model_error') {
    return '本轮在生成最终回复前发生模型或网络错误，请重试一次。'
  }
  return '本轮已结束，但没有可发送的最终总结。你可以让我“总结刚才做了什么”。'
}

export async function runWeixinMode(opts: WeixinRunOptions): Promise<void> {
  const permissionResolution = resolveWeixinPermissionMode(opts.permissionMode)
  if (permissionResolution.notice) {
    process.stdout.write(`  [WeChat] ${permissionResolution.notice}\n`)
  }
  if (permissionResolution.mode === 'auto_deny') {
    process.stdout.write('  [WeChat] risky tools requiring approval will be denied.\n')
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  let creds: WeixinCredentials
  if (opts.forceLogin) {
    creds = await loginWithQRCode()
  } else {
    const saved = await loadWeixinCredentials()
    if (saved) {
      creds = saved
      process.stdout.write(
        `  WeChat bot ready (token: ${creds.botToken.slice(0, 10)}…)\n` +
        '  Listening for messages. Press Ctrl+C to exit.\n\n'
      )
    } else {
      creds = await loginWithQRCode()
    }
  }

  // ── AI provider + tooling ─────────────────────────────────────────────────
  const provider = new OpenAICompatProvider({
    apiKey: opts.apiKey,
    baseURL: opts.baseURL,
    model: opts.model,
  })
  const registry = buildDefaultRegistry()
  const permissions = createPermissionStore(permissionResolution.mode)
  const sectionCache = createPromptSectionCache()
  const systemPrompt = (await buildMerlionSystemPrompt({ cwd: opts.cwd, sectionCache })).text
  const maxTurns = parsePositiveInt(process.env.MERLION_WECHAT_MAX_TURNS, DEFAULT_WECHAT_MAX_TURNS)
  const maxProgressUpdates = parsePositiveInt(
    process.env.MERLION_WECHAT_MAX_PROGRESS_UPDATES,
    DEFAULT_WECHAT_MAX_PROGRESS_UPDATES,
  )
  const progressEnabled = isWeixinProgressEnabled(process.env.MERLION_WECHAT_PROGRESS)
  const verboseProgressEnabled = isWeixinVerboseProgressEnabled(process.env.MERLION_WECHAT_PROGRESS_VERBOSE)

  // ── Signal handling ───────────────────────────────────────────────────────
  const abort = new AbortController()
  process.once('SIGINT', () => {
    process.stdout.write('\n  Disconnecting from WeChat…\n')
    abort.abort()
  })

  // ── Per-sender state ──────────────────────────────────────────────────────
  const histories = new Map<string, ChatMessage[]>()
  const seenIds = new Set<number>()

  function getHistory(senderId: string): ChatMessage[] {
    if (!histories.has(senderId)) {
      histories.set(senderId, [
        { role: 'system', content: systemPrompt },
      ])
    }
    return histories.get(senderId)!
  }

  async function processSenderMessage(
    senderId: string,
    text: string,
    contextToken?: string,
  ): Promise<void> {
    let progressSuppressed = false
    let progressSentCount = 0

    const sendWithRetry = async (
      bodyText: string,
      messageContextToken?: string,
    ): Promise<void> => {
      let lastError: unknown
      for (let attempt = 1; attempt <= SEND_RETRY_ATTEMPTS; attempt++) {
        try {
          await sendMessage(
            creds.baseUrl,
            creds.botToken,
            senderId,
            bodyText,
            messageContextToken,
          )
          return
        } catch (error) {
          lastError = error
          if (error instanceof WeixinApiError && error.errcode === SESSION_EXPIRED_ERRCODE) {
            throw new Error('WeChat session expired. Run `merlion wechat --login` to reconnect.')
          }
          if (!shouldRetrySendError(error)) break
          if (attempt >= SEND_RETRY_ATTEMPTS) break
          process.stderr.write(
            `  [WeChat] send retry ${attempt}/${SEND_RETRY_ATTEMPTS - 1} for ${senderId}: ${String(error)}\n`,
          )
          await sleep(SEND_RETRY_DELAY_MS * attempt, abort.signal).catch(() => {})
        }
      }
      throw lastError
    }

    try {
      const sendProgress = async (progressText: string): Promise<void> => {
        if (!progressEnabled || progressSuppressed) return
        if (progressSentCount >= maxProgressUpdates) {
          progressSuppressed = true
          process.stdout.write(
            `  [WeChat] ${senderId}: progress updates capped at ${maxProgressUpdates} for this request\n`,
          )
          return
        }
        try {
          // Keep progress updates out of message threading to reduce delivery loss.
          await sendWithRetry(progressText, undefined)
          progressSentCount += 1
        } catch (error) {
          if (error instanceof WeixinApiError && error.errcode === WECHAT_SEND_RATE_LIMIT_ERRCODE) {
            progressSuppressed = true
            process.stderr.write(
              `  [WeChat] progress throttled by server (errcode=${WECHAT_SEND_RATE_LIMIT_ERRCODE}); silencing further progress for this request\n`,
            )
            return
          }
          process.stderr.write(`  [WeChat] progress send failed for ${senderId}: ${String(error)}\n`)
        }
      }

      const history = getHistory(senderId)
      const result = await runLoop({
        provider,
        registry,
        systemPrompt,
        userPrompt: text,
        cwd: opts.cwd,
        permissions,
        initialMessages: history,
        maxTurns,
        onTurnStart: async ({ turn }) => {
          await sendProgress(`进度：第 ${turn} 轮处理中…`)
        },
        onToolBatchComplete: async ({ turn, results }) => {
          if (!verboseProgressEnabled || !progressEnabled || results.length === 0) return
          const failed = results.filter((item) => item.isError).length
          const succeeded = results.length - failed
          await sendProgress(`进度：第 ${turn} 轮工具执行完成（成功 ${succeeded}，失败 ${failed}）`)
        },
      })

      // Persist updated history (result.state.messages includes the new turn)
      histories.set(senderId, trimHistory(result.state.messages))

      const reply = toPlainText(renderWeixinReply(result))
      const chunks = splitForWeixin(reply)
      for (const chunk of chunks) {
        await sendWithRetry(chunk, contextToken)
      }
      process.stdout.write(
        `  [WeChat] → ${senderId} [${result.terminal}, turns=${result.state.turnCount}]: ${reply.slice(0, 60)}${reply.length > 60 ? '…' : ''}\n`
      )
    } catch (err) {
      process.stderr.write(`  [WeChat] error for ${senderId}: ${String(err)}\n`)
      if (err instanceof WeixinApiError && err.errcode === WECHAT_SEND_RATE_LIMIT_ERRCODE) {
        process.stderr.write(
          `  [WeChat] send path is rate-limited for ${senderId}; skip fallback message to avoid retry storm\n`,
        )
        return
      }
      try {
        await sendWithRetry(
          'Sorry, I hit an error. Please try again.',
          contextToken,
        )
      } catch { /* ignore send failure */ }
    }
  }

  const senderQueue = new SenderSerialQueue<PendingInboundMessage>({
    maxPendingPerSender: MAX_PENDING_PER_SENDER,
    shouldStop: () => abort.signal.aborted,
    handler: async (senderId, item) => {
      await processSenderMessage(senderId, item.text, item.contextToken)
    },
    onDropOldest: ({ senderId, maxPendingPerSender }) => {
      process.stdout.write(
        `  [WeChat] ${senderId}: queue full (${maxPendingPerSender}) — dropped oldest message\n`
      )
    },
    onEnqueueWhileBusy: ({ senderId, pending }) => {
      process.stdout.write(`  [WeChat] ${senderId}: queued (${pending} pending)\n`)
    },
  })

  process.stdout.write(`  WeChat listening — model: ${opts.model}\n`)

  // ── Main poll loop ────────────────────────────────────────────────────────
  let getUpdatesBuf = ''
  let pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS
  let consecutiveFailures = 0

  while (!abort.signal.aborted) {
    try {
      const resp = await getUpdates(creds.baseUrl, creds.botToken, getUpdatesBuf, pollTimeoutMs)

      if (resp.longpolling_timeout_ms && resp.longpolling_timeout_ms > 0) {
        pollTimeoutMs = resp.longpolling_timeout_ms
      }

      const errCode = resp.errcode ?? resp.ret ?? 0
      const isError = errCode !== 0

      if (isError) {
        if (errCode === SESSION_EXPIRED_ERRCODE) {
          process.stderr.write(
            '  WeChat session expired. Run `merlion wechat --login` to reconnect.\n'
          )
          process.exit(1)
        }
        consecutiveFailures++
        process.stderr.write(
          `  getUpdates error: errcode=${errCode} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})\n`
        )
        const delay = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES
          ? (consecutiveFailures = 0, BACKOFF_DELAY_MS)
          : RETRY_DELAY_MS
        await sleep(delay, abort.signal).catch(() => {})
        continue
      }

      consecutiveFailures = 0
      if (resp.get_updates_buf) getUpdatesBuf = resp.get_updates_buf

      for (const msg of resp.msgs ?? []) {
        // Only handle inbound user messages
        if (msg.message_type !== 1) continue

        // Deduplicate
        if (msg.message_id !== undefined) {
          if (seenIds.has(msg.message_id)) continue
          seenIds.add(msg.message_id)
          if (seenIds.size > MAX_SEEN_MESSAGE_IDS) {
            const oldest = seenIds.values().next().value!
            seenIds.delete(oldest)
          }
        }

        const senderId = msg.from_user_id
        if (!senderId) continue

        const text = extractText(msg)
        if (!text) continue

        const contextToken = msg.context_token

        process.stdout.write(
          `  [WeChat] ${senderId}: ${text.slice(0, 80)}${text.length > 80 ? '…' : ''}\n`
        )
        senderQueue.enqueue(senderId, { text, contextToken })
      }

    } catch (err) {
      if (abort.signal.aborted) break
      const msg = String(err)
      if (msg.includes('aborted') || msg.includes('AbortError')) break
      consecutiveFailures++
      process.stderr.write(`  poll exception: ${msg}\n`)
      await sleep(RETRY_DELAY_MS, abort.signal).catch(() => {})
    }
  }
}
