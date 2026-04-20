import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { ChatMessage, SessionMetaEntry, TranscriptMessageEntry } from '../types.js'
import type { PromptObservabilitySnapshot } from './prompt_observability.ts'
import {
  itemsToMessages,
  legacyMessageToItems,
  type ConversationItem,
  type ProviderResponseBoundary,
  type TranscriptItemEntry,
  type TranscriptResponseEntry,
} from './items.ts'

export interface SessionFiles {
  sessionId: string
  projectHash: string
  projectDir: string
  transcriptPath: string
  usagePath: string
}

export interface UsageEntry {
  timestamp: string
  session_id: string
  model: string
  provider?: string
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number | null
  tool_schema_tokens_estimate: number
  runtime_response_id?: string
  provider_response_id?: string
  provider_finish_reason?: string
  prompt_observability?: PromptObservabilitySnapshot
}

export interface SessionTranscriptLoadResult {
  items: ConversationItem[]
  messages: ChatMessage[]
  latestResponseBoundary: ProviderResponseBoundary | null
  eligiblePreviousResponseId: string | null
  hasLocalTailAfterLatestResponse: boolean
}

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool'])
const VALID_ITEM_ORIGINS = new Set(['provider_output', 'local_tool_output', 'local_runtime'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isTranscriptMessageEntry(value: unknown): value is TranscriptMessageEntry {
  if (!isRecord(value)) return false
  if (value.type !== 'message') return false
  if (typeof value.role !== 'string' || !VALID_ROLES.has(value.role)) return false
  if ('content' in value && value.content !== null && typeof value.content !== 'string') return false
  if ('name' in value && value.name !== undefined && typeof value.name !== 'string') return false
  if ('tool_call_id' in value && value.tool_call_id !== undefined && typeof value.tool_call_id !== 'string') return false
  if ('tool_calls' in value && value.tool_calls !== undefined && !Array.isArray(value.tool_calls)) return false
  return true
}

function isConversationItem(value: unknown): value is ConversationItem {
  if (!isRecord(value) || typeof value.kind !== 'string') return false
  if (value.kind === 'message') {
    return (
      (value.role === 'system' || value.role === 'user' || value.role === 'assistant') &&
      typeof value.content === 'string' &&
      typeof value.source === 'string'
    )
  }
  if (value.kind === 'reasoning') return true
  if (value.kind === 'function_call') {
    return typeof value.callId === 'string' && typeof value.name === 'string' && typeof value.argumentsText === 'string'
  }
  if (value.kind === 'function_call_output') {
    return typeof value.callId === 'string' && typeof value.outputText === 'string'
  }
  return false
}

function isTranscriptItemEntry(value: unknown): value is TranscriptItemEntry {
  if (!isRecord(value) || value.type !== 'item') return false
  if (!VALID_ITEM_ORIGINS.has(String(value.origin ?? ''))) return false
  if ('runtimeResponseId' in value && value.runtimeResponseId !== undefined && typeof value.runtimeResponseId !== 'string') {
    return false
  }
  return isConversationItem(value.item)
}

function isProviderResponseBoundary(value: unknown): value is ProviderResponseBoundary {
  if (!isRecord(value)) return false
  return (
    typeof value.runtimeResponseId === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.finishReason === 'string' &&
    typeof value.outputItemCount === 'number' &&
    typeof value.createdAt === 'string'
  )
}

function isTranscriptResponseEntry(value: unknown): value is TranscriptResponseEntry {
  return isRecord(value) && value.type === 'response' && isProviderResponseBoundary(value.response)
}

type ParsedTranscriptEntry =
  | SessionMetaEntry
  | TranscriptMessageEntry
  | TranscriptItemEntry
  | TranscriptResponseEntry

function parseTranscriptEntry(line: string): ParsedTranscriptEntry | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.type === 'message') return isTranscriptMessageEntry(parsed) ? parsed : null
  if (parsed.type === 'item') return isTranscriptItemEntry(parsed) ? parsed : null
  if (parsed.type === 'response') return isTranscriptResponseEntry(parsed) ? parsed : null
  if (parsed.type === 'session_meta') {
    if (
      typeof parsed.id === 'string' &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.model === 'string' &&
      typeof parsed.projectPath === 'string'
    ) {
      return {
        type: 'session_meta',
        id: parsed.id,
        createdAt: parsed.createdAt,
        model: parsed.model,
        projectPath: parsed.projectPath
      }
    }
  }
  return null
}

export function redactSecrets(input: string): string {
  let output = input
  output = output.replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
  output = output.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-[REDACTED]')
  output = output.replace(/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, 'sk-ant-[REDACTED]')
  output = output.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, 'ghp_[REDACTED]')
  output = output.replace(
    /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]'
  )
  return output
}

function redactItem(item: ConversationItem): ConversationItem {
  if (item.kind === 'message') {
    return { ...item, content: redactSecrets(item.content) }
  }
  if (item.kind === 'function_call') {
    return { ...item, argumentsText: redactSecrets(item.argumentsText) }
  }
  if (item.kind === 'function_call_output') {
    return { ...item, outputText: redactSecrets(item.outputText) }
  }
  if (item.kind === 'reasoning') {
    return {
      ...item,
      summaryText: item.summaryText ? redactSecrets(item.summaryText) : item.summaryText,
      encryptedContent: item.encryptedContent ? redactSecrets(item.encryptedContent) : item.encryptedContent,
    }
  }
  return item
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function findProjectRoot(startCwd: string): Promise<string> {
  let cursor = resolve(startCwd)
  for (;;) {
    if (await pathExists(join(cursor, '.git'))) return cursor
    const parent = resolve(cursor, '..')
    if (parent === cursor) return resolve(startCwd)
    cursor = parent
  }
}

interface SessionPathLayout {
  projectRoot: string
  projectHash: string
  defaultProjectDir: string
  overrideProjectDir: string | null
  legacyProjectDir: string
}

async function resolveSessionPathLayout(cwd: string): Promise<SessionPathLayout> {
  const projectRoot = await findProjectRoot(cwd)
  const projectHash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 16)
  const defaultProjectDir = join(projectRoot, '.merlion', 'sessions')
  const overrideDataDir = process.env.MERLION_DATA_DIR
  const overrideProjectDir = overrideDataDir ? join(overrideDataDir, 'projects', projectHash) : null
  const legacyProjectDir = join(homedir(), '.merlion', 'projects', projectHash)
  return {
    projectRoot,
    projectHash,
    defaultProjectDir,
    overrideProjectDir,
    legacyProjectDir
  }
}

export async function createSessionFiles(cwd: string): Promise<SessionFiles> {
  const layout = await resolveSessionPathLayout(cwd)
  const projectDir = layout.overrideProjectDir ?? layout.defaultProjectDir
  const sessionId = randomUUID()
  await mkdir(projectDir, { recursive: true })
  return {
    sessionId,
    projectHash: layout.projectHash,
    projectDir,
    transcriptPath: join(projectDir, `${sessionId}.jsonl`),
    usagePath: join(projectDir, `${sessionId}.usage.jsonl`)
  }
}

export async function getSessionFilesForResume(cwd: string, sessionId: string): Promise<SessionFiles> {
  const layout = await resolveSessionPathLayout(cwd)
  const candidates = layout.overrideProjectDir
    ? [layout.overrideProjectDir]
    : [layout.defaultProjectDir, layout.legacyProjectDir]

  for (const projectDir of candidates) {
    const transcriptPath = join(projectDir, `${sessionId}.jsonl`)
    if (!(await pathExists(transcriptPath))) continue
    const usagePath = join(projectDir, `${sessionId}.usage.jsonl`)
    return {
      sessionId,
      projectHash: layout.projectHash,
      projectDir,
      transcriptPath,
      usagePath
    }
  }

  throw new Error(`Session transcript not found: ${sessionId}`)
}

export async function appendSessionMeta(
  transcriptPath: string,
  sessionId: string,
  model: string,
  projectPath: string,
): Promise<void> {
  const entry: SessionMetaEntry = {
    type: 'session_meta',
    id: sessionId,
    createdAt: new Date().toISOString(),
    model,
    projectPath
  }
  await appendFile(transcriptPath, `${JSON.stringify(entry)}\n`, 'utf8')
}

export async function appendTranscriptResponse(
  transcriptPath: string,
  boundary: ProviderResponseBoundary,
): Promise<void> {
  const entry: TranscriptResponseEntry = {
    type: 'response',
    response: boundary,
  }
  await appendFile(transcriptPath, `${JSON.stringify(entry)}\n`, 'utf8')
}

export async function appendTranscriptItem(
  transcriptPath: string,
  item: ConversationItem,
  origin: TranscriptItemEntry['origin'],
  runtimeResponseId?: string,
): Promise<void> {
  const entry: TranscriptItemEntry = {
    type: 'item',
    item: redactItem(item),
    origin,
    runtimeResponseId,
  }
  await appendFile(transcriptPath, `${JSON.stringify(entry)}\n`, 'utf8')
}

export async function appendUsage(usagePath: string, entry: UsageEntry): Promise<void> {
  await appendFile(usagePath, `${JSON.stringify(entry)}\n`, 'utf8')
}

export async function loadSessionTranscript(transcriptPath: string): Promise<SessionTranscriptLoadResult> {
  const text = await readFile(transcriptPath, 'utf8')
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  const parsedEntries: ParsedTranscriptEntry[] = []

  for (const line of lines) {
    const parsed = parseTranscriptEntry(line)
    if (parsed) parsedEntries.push(parsed)
  }

  const items: ConversationItem[] = []
  let systemIndex = 0
  let latestResponseBoundary: ProviderResponseBoundary | null = null
  let latestResponseIndex = -1

  for (let index = 0; index < parsedEntries.length; index += 1) {
    const parsed = parsedEntries[index]!
    if (parsed.type === 'response') {
      latestResponseBoundary = parsed.response
      latestResponseIndex = index
      continue
    }
    if (parsed.type === 'item') {
      items.push(parsed.item)
      continue
    }
    if (parsed.type === 'message') {
      const converted = legacyMessageToItems(parsed, { systemIndex })
      items.push(...converted)
      if (parsed.role === 'system') systemIndex += 1
    }
  }

  let hasLocalTailAfterLatestResponse = false
  if (latestResponseBoundary && latestResponseIndex >= 0) {
    for (let index = latestResponseIndex + 1; index < parsedEntries.length; index += 1) {
      const parsed = parsedEntries[index]!
      if (parsed.type !== 'item') continue
      if (parsed.runtimeResponseId !== latestResponseBoundary.runtimeResponseId) {
        hasLocalTailAfterLatestResponse = true
        break
      }
    }
  }

  return {
    items,
    messages: itemsToMessages(items),
    latestResponseBoundary,
    eligiblePreviousResponseId:
      latestResponseBoundary && !hasLocalTailAfterLatestResponse
        ? latestResponseBoundary.providerResponseId ?? null
        : null,
    hasLocalTailAfterLatestResponse,
  }
}
