import { appendFile, readFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

import type { ModelProvider } from '../types.js'
import type { ContextService } from '../context/service.ts'
import type { AskUserQuestionItem, PermissionDecision, PermissionStore, ToolDefinition } from '../tools/types.js'
import { ToolRegistry } from '../tools/registry.ts'
import { QueryEngine } from './query_engine.ts'
import type { ConversationItem } from './items.ts'
import { createSystemItem } from './items.ts'
import {
  appendSessionMeta,
  appendTranscriptItem,
  appendTranscriptResponse,
  appendUsage,
  createSessionFiles,
  type SessionFiles,
  type UsageEntry,
} from './session.ts'
import type { RuntimeSink } from './events.ts'
import type { RuntimeState } from './state/types.ts'
import { buildRegistryFromPool } from '../tools/builtin/index.ts'
import { extractChangedPathsFromToolCall } from './workspace_changes.ts'
import {
  type AgentRunResult,
  type AgentVerdict,
  type ChildAgentRecord,
  type ChildAgentStatus,
  type SpawnAgentBackgroundResult,
  type SpawnAgentInput,
  type SpawnAgentRejectedResult,
  type SpawnAgentResult,
  type SubagentRole,
  type SubagentToolRuntime,
  type WaitAgentResult,
} from './subagent_types.ts'

type ChildExecutionMode = 'foreground' | 'background'

interface SubagentRegistryEntry {
  type: 'child_agent'
  record: ChildAgentRecord
}

interface ActiveChildTask {
  parentSessionId: string
  settled: boolean
  result?: AgentRunResult
  promise: Promise<AgentRunResult>
}

interface ChildUsageTotals {
  promptTokens: number
  completionTokens: number
  cachedTokens: number | null
}

interface CreateSubagentRuntimeOptions {
  cwd: string
  session: SessionFiles
  model?: string
  parentRegistry: ToolRegistry
  permissions: PermissionStore
  askQuestions?: (questions: AskUserQuestionItem[]) => Promise<Record<string, string>>
  buildIntentContract?: (prompt: string) => string | undefined
  sink?: RuntimeSink
  runtimeState: RuntimeState
  history: ConversationItem[]
  prompt: string
  createProvider: (model?: string) => ModelProvider
  createContextService: () => ContextService
  maxConcurrentChildren?: number
  maxDepth?: number
  depth?: number
}

const ACTIVE_CHILDREN = new Map<string, ActiveChildTask>()

const EXPLORER_ALLOW = new Set([
  'read_file',
  'list_dir',
  'stat_path',
  'search',
  'grep',
  'glob',
  'git_status',
  'git_diff',
  'git_log',
  'fetch',
  'lsp',
  'tool_search',
  'bash',
  'run_script',
])

const WORKER_ALLOW = new Set([
  'read_file',
  'list_dir',
  'stat_path',
  'search',
  'grep',
  'glob',
  'write_file',
  'append_file',
  'create_file',
  'edit_file',
  'copy_file',
  'move_file',
  'delete_file',
  'mkdir',
  'bash',
  'run_script',
  'list_scripts',
  'git_status',
  'git_diff',
  'git_log',
  'fetch',
  'lsp',
  'tool_search',
  'todo_write',
  'config',
  'config_get',
  'config_set',
  'sleep',
])

const VERIFIER_ALLOW = new Set([
  'read_file',
  'list_dir',
  'stat_path',
  'search',
  'grep',
  'glob',
  'git_status',
  'git_diff',
  'git_log',
  'fetch',
  'lsp',
  'tool_search',
  'list_scripts',
  'bash',
  'run_script',
])

const READ_TOOL_NAMES = new Set([
  'read_file',
  'list_dir',
  'stat_path',
  'search',
  'grep',
  'glob',
  'git_status',
  'git_diff',
  'git_log',
  'fetch',
  'lsp',
])

const SAFE_SCRIPT_PATTERN = /\b(test|lint|check|verify|typecheck|ci)\b/i

const READ_ONLY_SHELL_BLOCKLIST: RegExp[] = [
  /\btouch\b/,
  /\bmkdir\b/,
  /\brm\b/,
  /\bmv\b/,
  /\bcp\b/,
  /\binstall\b/,
  /\badd\b/,
  /\btee\b/,
  /\bcat\s+.*>/,
  /(^|[^>])>(?!>)/,
  /\bgit\s+(add|commit|push|checkout|switch|restore|reset|clean)\b/,
  /\bsed\s+-i\b/,
  /\bperl\s+-i\b/,
]

function roleAllowsBackground(role: SubagentRole): boolean {
  return role === 'worker'
}

function defaultTimeoutMs(role: SubagentRole): number {
  if (role === 'explorer') return 300_000
  if (role === 'verifier') return 600_000
  return 900_000
}

function suggestedRetryAfterSeconds(role: SubagentRole): number {
  return role === 'worker' ? 15 : 10
}

function normalizeExecution(value: unknown): ChildExecutionMode {
  return value === 'background' ? 'background' : 'foreground'
}

function trimArray(values: Iterable<string>): string[] {
  return [...new Set([...values].map((value) => value.trim()).filter((value) => value !== ''))].sort()
}

function safeParseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function extractPathValues(args: Record<string, unknown>): string[] {
  const values: string[] = []
  for (const [key, value] of Object.entries(args)) {
    if (
      (key === 'path' || key === 'file_path' || key === 'from_path' || key === 'to_path') &&
      typeof value === 'string'
    ) {
      values.push(value)
    }
  }
  return trimArray(values)
}

function parseVerifierVerdict(finalText: string): { verdict: AgentVerdict; notes?: string[] } | undefined {
  const match = finalText.match(/verdict\s*:\s*(pass|fail|partial|not[_ ]applicable)/i)
  if (!match) return undefined
  const raw = match[1]!.toLowerCase().replace(' ', '_')
  if (raw === 'pass' || raw === 'fail' || raw === 'partial' || raw === 'not_applicable') {
    return { verdict: raw }
  }
  return undefined
}

function rolePrompt(role: SubagentRole): string {
  if (role === 'explorer') {
    return [
      'You are an explorer subagent.',
      'You are read-only.',
      'Gather evidence, cite concrete files and symbols, and do not change files.',
      'Your job is to clarify the codebase, not to implement fixes.',
    ].join('\n')
  }
  if (role === 'verifier') {
    return [
      'You are a verifier subagent.',
      'You are read-only and must not implement fixes.',
      'Independently test the parent claim and end with `VERDICT: pass|fail|partial|not_applicable`.',
      'Treat `partial` as incomplete verification, not success.',
    ].join('\n')
  }
  return [
    'You are a worker subagent.',
    'Implement the assigned task within the stated write scope and constraints.',
    'Report concrete changes, changed files, and checks you ran.',
  ].join('\n')
}

function formatBriefing(briefing: {
  parentSessionId: string
  role: SubagentRole
  originalUserRequest: string
  rootUserRequest?: string
  task: string
  purpose?: string
  parentSummary?: string
  relevantPaths?: string[]
  changedFiles?: string[]
  constraints?: string[]
  writeScope?: string[]
  verificationTarget?: {
    changedFiles: string[]
    acceptanceCriteria?: string[]
  }
}): string {
  return [
    'Subagent briefing:',
    JSON.stringify(briefing, null, 2),
  ].join('\n')
}

function hasPathLikeContent(value: string): boolean {
  return value.includes('/') || value.includes('.') || value.includes('\\')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function appendChildRecord(path: string, record: ChildAgentRecord): Promise<void> {
  const entry: SubagentRegistryEntry = {
    type: 'child_agent',
    record,
  }
  await appendFile(path, `${JSON.stringify(entry)}\n`, 'utf8')
}

async function loadChildRecords(path: string): Promise<Map<string, ChildAgentRecord>> {
  if (!(await pathExists(path))) return new Map()
  const text = await readFile(path, 'utf8')
  const out = new Map<string, ChildAgentRecord>()
  for (const line of text.split('\n').filter((entry) => entry.trim() !== '')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as { type?: string }).type === 'child_agent' &&
      (parsed as { record?: ChildAgentRecord }).record &&
      typeof (parsed as { record: ChildAgentRecord }).record.agentId === 'string'
    ) {
      const record = (parsed as { record: ChildAgentRecord }).record
      out.set(record.agentId, record)
    }
  }
  return out
}

function resultFromRecord(record: ChildAgentRecord): AgentRunResult {
  return {
    agentId: record.agentId,
    role: record.role,
    status: record.status,
    summary: record.summary,
    finalText: record.finalText,
    filesRead: record.filesRead,
    filesChanged: record.filesChanged,
    commandsRun: record.commandsRun,
    transcriptPath: record.transcriptPath,
    verification: record.verification,
    error: record.error,
  }
}

function summarizeRun(result: {
  role: SubagentRole
  status: ChildAgentStatus
  finalText?: string
  verification?: { verdict: AgentVerdict }
  error?: string
}): string {
  if (result.status === 'failed') {
    return `${result.role} failed: ${result.error ?? 'child runtime error'}`
  }
  if (result.status === 'stopped') {
    return `${result.role} stopped before completion; transcript preserved`
  }
  if (result.role === 'verifier' && result.verification) {
    return `verifier completed with verdict: ${result.verification.verdict}`
  }
  const text = result.finalText?.trim() ?? ''
  if (text !== '') {
    const singleLine = text.replace(/\s+/g, ' ').trim()
    return singleLine.length > 160 ? `${singleLine.slice(0, 157)}...` : singleLine
  }
  return `${result.role} completed`
}

function wrapConditionalTool(tool: ToolDefinition, role: SubagentRole): ToolDefinition {
  if (tool.name === 'bash' && (role === 'explorer' || role === 'verifier')) {
    return {
      ...tool,
      async execute(input, ctx) {
        const command = typeof input.command === 'string' ? input.command : ''
        if (READ_ONLY_SHELL_BLOCKLIST.some((pattern) => pattern.test(command))) {
          return {
            content: `[Denied by ${role} read-only shell policy] ${command}`,
            isError: true,
          }
        }
        return await tool.execute(input, ctx)
      },
    }
  }
  if (tool.name === 'run_script' && (role === 'explorer' || role === 'verifier')) {
    return {
      ...tool,
      async execute(input, ctx) {
        const script = typeof input.script === 'string' ? input.script : ''
        if (!SAFE_SCRIPT_PATTERN.test(script)) {
          return {
            content: `[Denied by ${role} read-only script policy] ${script}`,
            isError: true,
          }
        }
        return await tool.execute(input, ctx)
      },
    }
  }
  return tool
}

function buildRoleRegistry(parentRegistry: ToolRegistry, role: SubagentRole): ToolRegistry {
  const allowed = role === 'explorer'
    ? EXPLORER_ALLOW
    : role === 'verifier'
      ? VERIFIER_ALLOW
      : WORKER_ALLOW

  const filtered = parentRegistry.getAll()
    .filter((tool) => allowed.has(tool.name))
    .map((tool) => wrapConditionalTool(tool, role))

  return buildRegistryFromPool(filtered)
}

function createBackgroundPermissionStore(): PermissionStore {
  return {
    ask: async (): Promise<PermissionDecision> => 'deny',
  }
}

function createChildPermissionStore(
  parentPermissions: PermissionStore,
  execution: ChildExecutionMode,
): PermissionStore {
  if (execution === 'background') return createBackgroundPermissionStore()
  return parentPermissions
}

function createChildContextService(
  base: ContextService,
  role: SubagentRole,
  briefingText: string,
): ContextService {
  return {
    getTrustLevel: () => base.getTrustLevel(),
    getPathGuidanceState: () => base.getPathGuidanceState(),
    getGeneratedMapMode: () => base.getGeneratedMapMode(),
    setGeneratedMapMode: (value) => base.setGeneratedMapMode(value),
    async prefetchIfSafe() {
      const bootstrap = await base.prefetchIfSafe()
      return {
        ...bootstrap,
        initialItems: [
          ...bootstrap.initialItems,
          createSystemItem(briefingText, 'runtime'),
        ],
      }
    },
    async getSystemPrompt() {
      const basePrompt = await base.getSystemPrompt()
      return `${basePrompt}\n\nSubagent role contract:\n${rolePrompt(role)}`
    },
    async buildPromptPrelude(prompt) {
      return await base.buildPromptPrelude(prompt)
    },
    async buildPathGuidanceItems(candidatePaths) {
      return await base.buildPathGuidanceItems(candidatePaths)
    },
    async extractCandidatePathsFromText(content) {
      return await base.extractCandidatePathsFromText(content)
    },
    async extractCandidatePathsFromToolEvent(event) {
      return await base.extractCandidatePathsFromToolEvent(event)
    },
  }
}

function findRootExternalUserRequest(history: ConversationItem[], currentPrompt: string): string {
  for (const item of history) {
    if (item.kind === 'message' && item.role === 'user' && item.source === 'external') {
      return item.content
    }
  }
  return currentPrompt
}

function collectChangedFilesFromItems(items: ConversationItem[]): string[] {
  const failedCallIds = new Set<string>()
  for (const item of items) {
    if (item.kind !== 'function_call_output') continue
    const text = item.outputText.trim()
    if (
      item.isError === true ||
      text.startsWith('Unknown tool:') ||
      text.startsWith('[Permission denied]') ||
      text.startsWith('[Denied by ') ||
      text.startsWith('Tool argument validation failed:')
    ) {
      failedCallIds.add(item.callId)
    }
  }
  const changed = new Set<string>()
  for (const item of items) {
    if (item.kind !== 'function_call') continue
    if (failedCallIds.has(item.callId)) continue
    for (const path of extractChangedPathsFromToolCall(item.name, item.argumentsText)) {
      changed.add(path)
    }
  }
  return trimArray(changed)
}

function collectRelevantPathsFromItems(items: ConversationItem[]): string[] {
  const relevant = new Set<string>()
  for (const item of items) {
    if (item.kind !== 'function_call') continue
    const args = safeParseObject(item.argumentsText)
    if (!args) continue
    for (const path of extractPathValues(args)) {
      if (hasPathLikeContent(path)) relevant.add(path)
    }
  }
  return trimArray(relevant)
}

function collectReadFilesFromItems(items: ConversationItem[]): string[] | undefined {
  const files = new Set<string>()
  for (const item of items) {
    if (item.kind !== 'function_call' || !READ_TOOL_NAMES.has(item.name)) continue
    const args = safeParseObject(item.argumentsText)
    if (!args) continue
    for (const path of extractPathValues(args)) {
      files.add(path)
    }
  }
  const sorted = trimArray(files)
  return sorted.length > 0 ? sorted : undefined
}

function collectCommandsFromItems(items: ConversationItem[]): string[] | undefined {
  const commands: string[] = []
  for (const item of items) {
    if (item.kind !== 'function_call') continue
    const args = safeParseObject(item.argumentsText)
    if (!args) continue
    if (item.name === 'bash' && typeof args.command === 'string') {
      commands.push(args.command)
      continue
    }
    if (item.name === 'run_script' && typeof args.script === 'string') {
      commands.push(`npm run ${args.script}`)
    }
  }
  return commands.length > 0 ? commands : undefined
}

async function buildBriefing(
  options: CreateSubagentRuntimeOptions,
  input: SpawnAgentInput,
): Promise<{
  parentSessionId: string
  role: SubagentRole
  originalUserRequest: string
  rootUserRequest?: string
  task: string
  purpose?: string
  parentSummary?: string
  relevantPaths?: string[]
  changedFiles?: string[]
  constraints?: string[]
  writeScope?: string[]
  verificationTarget?: {
    changedFiles: string[]
    acceptanceCriteria?: string[]
  }
}> {
  const baseContext = options.createContextService()
  const parentChangedFiles = collectChangedFilesFromItems(options.history)
  const derivedRelevantPaths = trimArray([
    ...(input.writeScope ?? []),
    ...(await baseContext.extractCandidatePathsFromText(options.prompt)),
    ...collectRelevantPathsFromItems(options.history),
    ...parentChangedFiles,
  ])

  const constraints = trimArray([
    input.role === 'explorer' ? 'read-only role' : '',
    input.role === 'verifier' ? 'read-only role' : '',
    input.role === 'worker' && input.writeScope?.length ? `stay within write scope: ${input.writeScope.join(', ')}` : '',
    input.execution === 'background' ? 'background child cannot request new approvals interactively' : '',
  ])

  return {
    parentSessionId: options.session.sessionId,
    role: input.role,
    originalUserRequest: options.prompt,
    rootUserRequest: findRootExternalUserRequest(options.history, options.prompt),
    task: input.task,
    purpose: input.purpose,
    parentSummary: options.runtimeState.compact.lastSummaryText ?? undefined,
    relevantPaths: derivedRelevantPaths.length > 0 ? derivedRelevantPaths : undefined,
    changedFiles: parentChangedFiles.length > 0 ? parentChangedFiles : undefined,
    constraints: constraints.length > 0 ? constraints : undefined,
    writeScope: input.writeScope && input.writeScope.length > 0 ? trimArray(input.writeScope) : undefined,
    verificationTarget: input.role === 'verifier'
      ? {
          changedFiles: parentChangedFiles,
          acceptanceCriteria: ['Verify that the claimed change holds up under independent checks.'],
        }
      : undefined,
  }
}

async function runChildAgent(
  options: CreateSubagentRuntimeOptions,
  input: SpawnAgentInput,
  childSession: SessionFiles,
  agentId: string,
  execution: ChildExecutionMode,
  timeoutMs: number,
): Promise<AgentRunResult> {
  const briefing = await buildBriefing(options, input)
  const briefingText = formatBriefing(briefing)
  const registry = buildRoleRegistry(options.parentRegistry, input.role)
  const childContext = createChildContextService(options.createContextService(), input.role, briefingText)
  const childProvider = options.createProvider(input.model ?? options.model)
  const childUsageTotals: ChildUsageTotals = {
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
  }

  await appendSessionMeta(childSession.transcriptPath, childSession.sessionId, input.model ?? options.model ?? 'unknown', options.cwd)

  const engine = new QueryEngine({
    cwd: options.cwd,
    provider: childProvider,
    registry,
    permissions: createChildPermissionStore(options.permissions, execution),
    contextService: childContext,
    model: input.model ?? options.model,
    sessionId: childSession.sessionId,
    maxTurns: 100,
    askQuestions: execution === 'background' ? undefined : options.askQuestions,
    buildIntentContract: options.buildIntentContract,
    sink: execution === 'foreground'
      ? {
          renderBanner() {},
          renderUserPrompt() {},
          renderAssistantOutput() {},
          clearTypedInputLine() {},
          stopSpinner() {},
          promptLabel() { return 'subagent> ' },
          onTurnStart: ({ turn }) => {
            options.sink?.onPhaseUpdate(`[subagent:${input.role}] turn ${turn} in progress`)
          },
          onAssistantResponse() {},
          onToolStart() {},
          onToolResult() {},
          onUsage() {},
          onPhaseUpdate: (text) => options.sink?.onPhaseUpdate(`[subagent:${input.role}] ${text}`),
          onMapUpdated: (text) => options.sink?.onMapUpdated(`[subagent:${input.role}] ${text}`),
          setToolDetailMode() {},
        }
      : undefined,
    persistItem: async (item, origin, runtimeResponseId) => {
      await appendTranscriptItem(childSession.transcriptPath, item, origin, runtimeResponseId)
    },
    persistResponseBoundary: async (boundary) => {
      await appendTranscriptResponse(childSession.transcriptPath, boundary)
    },
    persistUsage: async (entry) => {
      childUsageTotals.promptTokens += entry.prompt_tokens
      childUsageTotals.completionTokens += entry.completion_tokens
      childUsageTotals.cachedTokens = (childUsageTotals.cachedTokens ?? 0) + (entry.cached_tokens ?? 0)
      const usageEntry: UsageEntry = {
        timestamp: new Date().toISOString(),
        session_id: childSession.sessionId,
        model: input.model ?? options.model ?? 'unknown',
        provider: entry.provider,
        prompt_tokens: entry.prompt_tokens,
        completion_tokens: entry.completion_tokens,
        cached_tokens: entry.cached_tokens ?? null,
        tool_schema_tokens_estimate: 0,
        runtime_response_id: entry.runtimeResponseId,
        provider_response_id: entry.providerResponseId,
        provider_finish_reason: entry.providerFinishReason,
        prompt_observability: entry.promptObservability,
      }
      await appendUsage(childSession.usagePath, usageEntry)
    },
  })

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timeoutHandle = undefined
      reject(new Error(`timeout after ${timeoutMs} ms`))
    }, timeoutMs)
  })

  try {
    const result = await Promise.race([
      engine.submitPrompt(input.task),
      timeoutPromise,
    ])
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
      timeoutHandle = undefined
    }
    const items = engine.getItems()
    const finalText = result.finalText.trim() !== '' ? result.finalText : undefined
    const filesChanged = collectChangedFilesFromItems(items)
    const verification = input.role === 'verifier' && finalText
      ? parseVerifierVerdict(finalText)
      : undefined
    const completed: AgentRunResult = {
      agentId,
      role: input.role,
      status: result.terminal === 'completed' ? 'completed' : 'failed',
      summary: '',
      finalText,
      filesRead: collectReadFilesFromItems(items),
      filesChanged: filesChanged.length > 0 ? filesChanged : [],
      commandsRun: collectCommandsFromItems(items),
      transcriptPath: childSession.transcriptPath,
      usage: {
        promptTokens: childUsageTotals.promptTokens,
        completionTokens: childUsageTotals.completionTokens,
        cachedTokens: childUsageTotals.cachedTokens,
      },
      verification,
      error: result.terminal === 'completed' ? undefined : result.finalText,
    }
    completed.summary = summarizeRun(completed)
    return completed
  } catch (error) {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle)
      timeoutHandle = undefined
    }
    const message = error instanceof Error ? error.message : String(error)
    const failed: AgentRunResult = {
      agentId,
      role: input.role,
      status: message.startsWith('timeout after ') ? 'failed' : 'failed',
      summary: '',
      transcriptPath: childSession.transcriptPath,
      filesChanged: [],
      error: message,
    }
    failed.summary = summarizeRun(failed)
    return failed
  }
}

export function createSubagentRuntime(options: CreateSubagentRuntimeOptions): SubagentToolRuntime {
  async function updateRecord(record: ChildAgentRecord): Promise<void> {
    await appendChildRecord(options.session.childRegistryPath, record)
  }

  async function currentRecords(): Promise<Map<string, ChildAgentRecord>> {
    return await loadChildRecords(options.session.childRegistryPath)
  }

  async function runningChildCount(): Promise<number> {
    let count = 0
    for (const [, task] of ACTIVE_CHILDREN.entries()) {
      if (task.parentSessionId === options.session.sessionId && !task.settled) count += 1
    }
    return count
  }

  async function spawnAgent(input: SpawnAgentInput): Promise<SpawnAgentResult> {
    const execution = normalizeExecution(input.execution)
    const maxDepth = options.maxDepth ?? 1
    const currentDepth = options.depth ?? 0
    if (currentDepth >= maxDepth) {
      const rejection: SpawnAgentRejectedResult = {
        status: 'rejected',
        reason: 'depth_limit_exceeded',
        suggestedRetryAfterSeconds: 15,
      }
      return rejection
    }
    if (execution === 'background' && !roleAllowsBackground(input.role)) {
      const rejection: SpawnAgentRejectedResult = {
        status: 'rejected',
        reason: 'background_not_supported',
        suggestedRetryAfterSeconds: 15,
      }
      return rejection
    }
    const maxConcurrentChildren = options.maxConcurrentChildren ?? 3
    const runningChildren = await runningChildCount()
    if (runningChildren >= maxConcurrentChildren) {
      return {
        status: 'rejected',
        reason: 'capacity_limit_exceeded',
        maxConcurrentChildren,
        runningChildren,
        suggestedRetryAfterSeconds: 15,
      }
    }

    const childSession = await createSessionFiles(options.cwd)
    const agentId = randomUUID()
    const timeoutMs = Math.min(
      Math.max(Math.floor(input.timeoutMs ?? defaultTimeoutMs(input.role)), 1_000),
      3_600_000,
    )
    const baseRecord: ChildAgentRecord = {
      agentId,
      parentSessionId: options.session.sessionId,
      parentDepth: currentDepth,
      childDepth: currentDepth + 1,
      role: input.role,
      execution,
      status: 'running',
      childSessionId: childSession.sessionId,
      transcriptPath: childSession.transcriptPath,
      timeoutMs,
      startedAt: new Date().toISOString(),
      task: input.task,
      purpose: input.purpose,
      model: input.model ?? options.model,
      summary: `${input.role} launched${execution === 'background' ? ' in background' : ''}`,
    }
    await updateRecord(baseRecord)

    if (execution === 'foreground') {
      const result = await runChildAgent(options, input, childSession, agentId, execution, timeoutMs)
      const terminalRecord: ChildAgentRecord = {
        ...baseRecord,
        ...result,
        status: result.status,
        finishedAt: new Date().toISOString(),
      }
      await updateRecord(terminalRecord)
      return result
    }

    const taskPromise = runChildAgent(options, input, childSession, agentId, execution, timeoutMs)
      .then(async (result) => {
        const terminalRecord: ChildAgentRecord = {
          ...baseRecord,
          ...result,
          status: result.status,
          finishedAt: new Date().toISOString(),
        }
        await updateRecord(terminalRecord)
        return result
      })
      .catch(async (error) => {
        const failed: AgentRunResult = {
          agentId,
          role: input.role,
          status: 'failed',
          summary: `${input.role} failed: ${String(error)}`,
          transcriptPath: childSession.transcriptPath,
          filesChanged: [],
          error: String(error),
        }
        const terminalRecord: ChildAgentRecord = {
          ...baseRecord,
          ...failed,
          status: 'failed',
          finishedAt: new Date().toISOString(),
        }
        await updateRecord(terminalRecord)
        return failed
      })

    const active: ActiveChildTask = {
      parentSessionId: options.session.sessionId,
      settled: false,
      promise: taskPromise,
    }
    ACTIVE_CHILDREN.set(agentId, active)
    void taskPromise.then((result) => {
      active.settled = true
      active.result = result
    })

    const running: SpawnAgentBackgroundResult = {
      agentId,
      role: input.role,
      status: 'running',
      summary: `${input.role} launched in background`,
      transcriptPath: childSession.transcriptPath,
    }
    return running
  }

  async function waitAgent(agentId: string): Promise<WaitAgentResult> {
    const active = ACTIVE_CHILDREN.get(agentId)
    if (active) {
      if (active.settled && active.result) {
        return active.result
      }
      const records = await currentRecords()
      const record = records.get(agentId)
      return {
        agentId,
        status: 'running',
        suggestedRetryAfterSeconds: suggestedRetryAfterSeconds(record?.role ?? 'worker'),
      }
    }

    const records = await currentRecords()
    const record = records.get(agentId)
    if (!record) {
      throw new Error(`Unknown child agent: ${agentId}`)
    }
    if (record.status === 'running') {
      return {
        agentId,
        role: record.role,
        status: 'failed',
        summary: `${record.role} failed: background child is no longer attached; transcript preserved`,
        transcriptPath: record.transcriptPath,
        filesChanged: [],
        error: 'background child is no longer attached',
      }
    }
    return resultFromRecord(record)
  }

  return {
    spawnAgent,
    waitAgent,
  }
}
