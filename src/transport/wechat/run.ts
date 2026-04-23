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
import type { RunLoopResult } from '../../runtime/loop.ts'
import { createContextService } from '../../context/service.ts'
import type { RuntimeSink } from '../../runtime/events.ts'
import type { ConversationItem } from '../../runtime/items.ts'
import { QueryEngine } from '../../runtime/query_engine.ts'
import type { ApprovalPolicy, NetworkMode, SandboxMode } from '../../sandbox/policy.ts'
import { resolveSandboxPolicy } from '../../sandbox/policy.ts'
import { deriveSandboxProtectedPaths } from '../../sandbox/protected_paths.ts'
import { resolveSandboxBackend } from '../../sandbox/resolve.ts'

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
  sandboxMode?: SandboxMode
  approvalPolicy?: ApprovalPolicy
  networkMode?: NetworkMode
  writableRoots?: string[]
  denyRead?: string[]
  denyWrite?: string[]
}

export interface WeixinPermissionResolution {
  mode: 'never'
  notice?: string
}

export function resolveWeixinPermissionMode(
  mode: ApprovalPolicy | 'interactive' | 'auto_allow' | 'auto_deny' | undefined,
): WeixinPermissionResolution {
  if (mode === 'never' || mode === 'auto_allow' || mode === 'auto_deny' || mode === 'untrusted') {
    return { mode: 'never' }
  }
  return {
    mode: 'never',
    notice:
      'interactive approval is not supported in WeChat mode; defaulting to approval=never.',
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

function trimHistory(history: ConversationItem[]): ConversationItem[] {
  if (history.length <= MAX_HISTORY_MESSAGES) return history
  const firstNonSystem = history.findIndex((item) => item.kind !== 'message' || item.role !== 'system')
  const systemBoundary = firstNonSystem < 0 ? history.length : firstNonSystem
  const systemItems = history.slice(0, systemBoundary)
  if (systemItems.length >= MAX_HISTORY_MESSAGES) {
    return systemItems.slice(-MAX_HISTORY_MESSAGES)
  }
  const rest = history.slice(systemBoundary)
  const keep = rest.slice(-Math.max(MAX_HISTORY_MESSAGES - systemItems.length, 20))
  return [...systemItems, ...keep]
}

function findLastAssistantText(items: ConversationItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item?.kind !== 'message' || item.role !== 'assistant') continue
    const text = item.content.trim()
    if (text) return text
  }
  return null
}

export function renderWeixinReply(result: RunLoopResult): string {
  const direct = result.finalText?.trim()
  if (direct) return direct

  const fallbackAssistant = findLastAssistantText(result.state.items)
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
  const registry = buildDefaultRegistry({ mode: 'wechat' })
  const protectedPaths = await deriveSandboxProtectedPaths(opts.cwd)
  const sandboxPolicy = resolveSandboxPolicy({
    cwd: opts.cwd,
    sandboxMode: opts.sandboxMode ?? 'workspace-write',
    approvalPolicy: 'never',
    networkMode: opts.networkMode ?? 'off',
    writableRoots: opts.writableRoots,
    denyRead: opts.denyRead,
    denyWrite: opts.denyWrite,
    fixedDenyRead: protectedPaths.denyRead,
    fixedDenyWrite: protectedPaths.denyWrite,
  })
  const sandboxBackend = await resolveSandboxBackend(sandboxPolicy)
  const permissions = createPermissionStore(permissionResolution.mode)
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
  const histories = new Map<string, ConversationItem[]>()
  const seenIds = new Set<number>()

  function getHistory(senderId: string): ConversationItem[] {
    if (!histories.has(senderId)) {
      histories.set(senderId, [])
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
      const sink: RuntimeSink = {
        renderBanner() {},
        renderUserPrompt() {},
        renderAssistantOutput() {},
        clearTypedInputLine() {},
        stopSpinner() {},
        promptLabel() { return 'wechat> ' },
        onTurnStart: ({ turn }) => {
          void sendProgress(`进度：第 ${turn} 轮处理中…`)
        },
        onAssistantResponse() {},
        onToolStart() {},
        onToolResult() {},
        onUsage() {},
        onPhaseUpdate: (text) => {
          if (!verboseProgressEnabled || !progressEnabled) return
          void sendProgress(text)
        },
        onMapUpdated: (text) => {
          if (!verboseProgressEnabled || !progressEnabled) return
          void sendProgress(text)
        },
        setToolDetailMode() {},
      }
      const contextService = createContextService({
        cwd: opts.cwd,
        permissionMode: 'auto_allow',
        sandboxMode: sandboxPolicy.mode,
        approvalPolicy: sandboxPolicy.approvalPolicy,
        networkMode: sandboxPolicy.networkMode,
      })
      const engine = new QueryEngine({
        cwd: opts.cwd,
        provider,
        registry,
        permissions,
        sandboxPolicy,
        sandboxBackend,
        contextService,
        model: opts.model,
        initialItems: [],
        sink,
        maxTurns,
      })
      if (history.length > 0) {
        await contextService.prefetchIfSafe()
        await engine.resumeFromTranscript(history)
      }
      const result = await engine.submitPrompt(text)

      histories.set(senderId, trimHistory(result.state.items))

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
