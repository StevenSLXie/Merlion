import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import type { ChatMessage, SessionMetaEntry, TranscriptEntry, TranscriptMessageEntry } from '../types.js'
import type { PromptObservabilitySnapshot } from './prompt_observability.ts'

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
  prompt_observability?: PromptObservabilitySnapshot
}

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool'])

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

function parseTranscriptEntry(line: string): TranscriptEntry | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.type === 'message') {
    return isTranscriptMessageEntry(parsed) ? parsed : null
  }
  if (parsed.type === 'session_meta') {
    if (
      typeof parsed.id === 'string' &&
      typeof parsed.createdAt === 'string' &&
      typeof parsed.model === 'string' &&
      typeof parsed.projectPath === 'string'
    ) {
      const entry: SessionMetaEntry = {
        type: 'session_meta',
        id: parsed.id,
        createdAt: parsed.createdAt,
        model: parsed.model,
        projectPath: parsed.projectPath
      }
      return entry
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

function redactMessage(message: ChatMessage): ChatMessage {
  const redacted: ChatMessage = { ...message }
  if (typeof redacted.content === 'string') {
    redacted.content = redactSecrets(redacted.content)
  }
  if (redacted.tool_calls) {
    redacted.tool_calls = redacted.tool_calls.map((call) => ({
      ...call,
      function: {
        ...call.function,
        arguments: redactSecrets(call.function.arguments)
      }
    }))
  }
  return redacted
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

export async function appendTranscriptMessage(transcriptPath: string, message: ChatMessage): Promise<void> {
  const redacted = redactMessage(message)
  const entry: TranscriptMessageEntry = { type: 'message', ...redacted }
  await appendFile(transcriptPath, `${JSON.stringify(entry)}\n`, 'utf8')
}

export async function appendUsage(usagePath: string, entry: UsageEntry): Promise<void> {
  await appendFile(usagePath, `${JSON.stringify(entry)}\n`, 'utf8')
}

export async function loadSessionMessages(transcriptPath: string): Promise<ChatMessage[]> {
  const text = await readFile(transcriptPath, 'utf8')
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  const messages: ChatMessage[] = []

  for (const line of lines) {
    const parsed = parseTranscriptEntry(line)
    if (!parsed || parsed.type !== 'message') continue

    const message: ChatMessage = {
      role: parsed.role,
      content: parsed.content ?? null,
      tool_calls: parsed.tool_calls,
      tool_call_id: parsed.tool_call_id,
      name: parsed.name
    }
    messages.push(message)
  }

  return messages
}
