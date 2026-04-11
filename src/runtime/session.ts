import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ChatMessage } from '../types.js'

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
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number | null
  tool_schema_tokens_estimate: number
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

export async function createSessionFiles(cwd: string): Promise<SessionFiles> {
  const dataDir = process.env.MERLION_DATA_DIR ?? join(homedir(), '.merlion')
  const projectHash = createHash('sha256').update(cwd).digest('hex').slice(0, 16)
  const sessionId = randomUUID()
  const projectDir = join(dataDir, 'projects', projectHash)
  await mkdir(projectDir, { recursive: true })
  return {
    sessionId,
    projectHash,
    projectDir,
    transcriptPath: join(projectDir, `${sessionId}.jsonl`),
    usagePath: join(projectDir, `${sessionId}.usage.jsonl`)
  }
}

export async function getSessionFilesForResume(cwd: string, sessionId: string): Promise<SessionFiles> {
  const dataDir = process.env.MERLION_DATA_DIR ?? join(homedir(), '.merlion')
  const projectHash = createHash('sha256').update(cwd).digest('hex').slice(0, 16)
  const projectDir = join(dataDir, 'projects', projectHash)
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`)
  const usagePath = join(projectDir, `${sessionId}.usage.jsonl`)

  try {
    await stat(transcriptPath)
  } catch {
    throw new Error(`Session transcript not found: ${sessionId}`)
  }

  return { sessionId, projectHash, projectDir, transcriptPath, usagePath }
}

export async function appendSessionMeta(
  transcriptPath: string,
  sessionId: string,
  model: string,
  projectPath: string,
): Promise<void> {
  const entry = {
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
  const entry = { type: 'message', ...redacted }
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
    let parsed: any
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (parsed.type !== 'message') continue

    const message: ChatMessage = {
      role: parsed.role,
      content: parsed.content ?? null,
      tool_calls: parsed.tool_calls,
      tool_call_id: parsed.tool_call_id,
      name: parsed.name,
    }
    messages.push(message)
  }

  return messages
}
