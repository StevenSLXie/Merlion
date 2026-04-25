/**
 * E2E test helpers.
 *
 * All E2E tests require OPENROUTER_API_KEY in the environment.
 * Tests are skipped automatically when the key is absent.
 */
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  evaluateCostGate,
  parseCostGateMode,
  readCostBaseline,
  type CostGateDecision,
} from '../../src/runtime/cost_gate.ts'
import {
  createPromptObservabilityTrackerWithToolSchema,
  summarizeToolSchema,
  type PromptObservabilitySnapshot,
} from '../../src/runtime/prompt_observability.ts'
import { OpenAICompatProvider } from '../../src/providers/openai.ts'
import type { CapabilityProfileName } from '../../src/runtime/task_state.ts'
import { buildDefaultRegistry, buildRegistryFromPool } from '../../src/tools/builtin/index.ts'
import type { RuntimeSandboxEvent } from '../../src/runtime/events.ts'
import { runLoop } from '../../src/runtime/loop.ts'
import type { RunLoopResult } from '../../src/runtime/loop.ts'
import {
  createUsageTracker,
  deriveUsageMetrics,
  resolveUsageRatesFromEnv,
  summarizeUsageSamples,
  type UsageDerivedMetrics,
  type UsageRates,
} from '../../src/runtime/usage.ts'
import type { MerlionSandboxConfig } from '../../src/sandbox/policy.ts'
import { resolveSandboxPolicy } from '../../src/sandbox/policy.ts'
import { deriveSandboxProtectedPaths } from '../../src/sandbox/protected_paths.ts'
import { resolveSandboxBackend } from '../../src/sandbox/resolve.ts'
import { assembleToolPool } from '../../src/tools/pool.ts'

export const FIXTURES_DIR = join(fileURLToPath(import.meta.url), '../fixtures')

// Default model for E2E tests.
// Priority: MERLION_E2E_MODEL > MERLION_MODEL > pinned baseline default
const E2E_MODEL =
  process.env.MERLION_E2E_MODEL ??
  process.env.MERLION_MODEL ??
  'moonshotai/kimi-k2.5'
const E2E_BASE_URL = process.env.MERLION_BASE_URL ?? 'https://openrouter.ai/api/v1'

export const API_KEY = process.env.OPENROUTER_API_KEY ?? ''
export const SKIP = !API_KEY

export const SYSTEM_PROMPT =
  'You are Merlion, a coding agent. Use your tools to complete the task. ' +
  'Be concise. When done, state what you did.'

/** Create a fresh provider instance using the configured E2E model. */
export function makeProvider(): OpenAICompatProvider {
  return new OpenAICompatProvider({
    apiKey: API_KEY,
    baseURL: E2E_BASE_URL,
    model: E2E_MODEL,
  })
}

const READONLY_QUESTION_PROFILE: CapabilityProfileName = 'readonly_question'
const READONLY_QUESTION_TOOL_NAMES = assembleToolPool({
  mode: 'default',
  profile: READONLY_QUESTION_PROFILE,
}).map((tool) => tool.name)

const BUDGET_TARGETED_E2E_SCENARIOS = new Map<
  string,
  { profile?: CapabilityProfileName; includeToolNames?: string[]; extraToolNames?: string[] }
>([
  ['e2e-read', { profile: READONLY_QUESTION_PROFILE }],
  ['e2e-search', { profile: READONLY_QUESTION_PROFILE, includeToolNames: ['search'] }],
  ['e2e-tool-error', { profile: READONLY_QUESTION_PROFILE }],
  ['e2e-edit', { includeToolNames: ['read_file', 'edit_file'] }],
  ['e2e-multi-tool', { extraToolNames: ['create_file'] }],
])

function uniqueNames(names: string[]): string[] {
  return [...new Set(names)]
}

/** Create a fresh tool registry, narrowing only the targeted budget-regression scenarios. */
export function makeRegistry(options?: { scenario?: string }) {
  const scenario = options?.scenario ? safeScenarioLabel(options.scenario) : null
  const targetedConfig = scenario ? BUDGET_TARGETED_E2E_SCENARIOS.get(scenario) : undefined

  if (!targetedConfig) {
    return buildDefaultRegistry({ mode: 'default' })
  }

  if (targetedConfig.includeToolNames) {
    return buildRegistryFromPool(assembleToolPool({
      mode: 'default',
      profile: targetedConfig.profile ?? 'implementation_scoped',
      includeNames: uniqueNames(targetedConfig.includeToolNames),
    }))
  }

  if (targetedConfig.profile && !targetedConfig.extraToolNames) {
    return buildDefaultRegistry({ mode: 'default', profile: targetedConfig.profile })
  }

  return buildRegistryFromPool(assembleToolPool({
    mode: 'default',
    profile: 'implementation_scoped',
    includeNames: uniqueNames([
      ...READONLY_QUESTION_TOOL_NAMES,
      ...(targetedConfig.extraToolNames ?? []),
    ]),
  }))
}

/**
 * Create a temporary sandbox directory pre-populated with the fixture files.
 * Returns the sandbox path. Caller is responsible for cleanup via rmSandbox().
 */
export async function makeSandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'merlion-e2e-'))
  await cp(FIXTURES_DIR, dir, { recursive: true })
  return dir
}

export async function rmSandbox(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

function safeScenarioLabel(raw: string): string {
  const normalized = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return normalized.length > 0 ? normalized.slice(0, 64) : 'unnamed'
}

function getUsageArchiveDir(): string {
  return process.env.MERLION_E2E_USAGE_DIR ?? join(process.cwd(), '.merlion', 'e2e-usage')
}

function getCostBaselinePath(): string {
  return process.env.MERLION_E2E_COST_BASELINE ?? join(process.cwd(), 'docs', 'cost-baseline.json')
}

interface UsageArchiveParams {
  scenario: string
  task: string
  cwd: string
  result: RunLoopResult
  model: string
  baseURL: string
  usageSamples: Array<{ prompt_tokens: number; completion_tokens: number; cached_tokens: number | null }>
  totals: { prompt_tokens: number; completion_tokens: number; cached_tokens: number; total_tokens: number }
  toolSchema: ReturnType<typeof summarizeToolSchema>
  promptObservability: PromptObservabilitySnapshot[]
  usageRates?: UsageRates
  derivedTotals?: UsageDerivedMetrics
}

export interface E2ECostGateReport {
  scenario: string
  totalTokens: number
  archivePath: string
  decision: CostGateDecision
}

export function buildUsageArchivePayload(params: UsageArchiveParams) {
  const derivedTotals = params.derivedTotals ?? deriveUsageMetrics(
    summarizeUsageSamples(params.usageSamples),
    params.usageRates,
  )
  return {
    timestamp: new Date().toISOString(),
    scenario: safeScenarioLabel(params.scenario),
    model: params.model,
    base_url: params.baseURL,
    cwd: params.cwd,
    terminal: params.result.terminal,
    task: params.task,
    final_text: params.result.finalText,
    turn_count: params.result.state.turnCount,
    tool_count: params.toolSchema.tool_count,
    tool_schema_serialized_chars: params.toolSchema.tool_schema_serialized_chars,
    tool_schema_tokens_estimate: params.toolSchema.tool_schema_tokens_estimate,
    usage_samples: params.usageSamples,
    totals: params.totals,
    derived_totals: {
      uncached_prompt_tokens: derivedTotals.uncached_prompt_tokens,
      cached_prompt_ratio: derivedTotals.cached_prompt_ratio,
      effective_input_tokens: derivedTotals.effective_input_tokens,
      effective_total_tokens: derivedTotals.effective_total_tokens,
      ...(derivedTotals.estimated_cost_usd === undefined
        ? {}
        : { estimated_cost_usd: derivedTotals.estimated_cost_usd }),
      primary_metric: derivedTotals.primary_metric,
      primary_metric_value: derivedTotals.primary_metric_value,
      primary_metric_degraded_reason: derivedTotals.primary_metric_degraded_reason,
    },
    prompt_observability: [...params.promptObservability].sort((left, right) => left.turn - right.turn),
  }
}

async function writeUsageArchive(params: UsageArchiveParams): Promise<string> {
  const dir = getUsageArchiveDir()
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const payload = buildUsageArchivePayload(params)
  const path = join(dir, `${payload.scenario}-${stamp}.json`)
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  return path
}

export async function evaluateArchivedCostGate(
  scenario: string,
  totalTokens: number,
  archivePath: string,
  derivedMetrics: UsageDerivedMetrics,
): Promise<E2ECostGateReport> {
  const normalizedScenario = safeScenarioLabel(scenario)
  const mode = parseCostGateMode(process.env.MERLION_COST_GATE)
  const baseline = await readCostBaseline(getCostBaselinePath())
  const decision = evaluateCostGate({
    baseline,
    scenario: normalizedScenario,
    totalTokens,
    derivedMetrics,
    mode,
  })

  if (decision.status === 'warn') {
    process.stderr.write(`${decision.message}; usage_archive=${archivePath}\n`)
  }

  return {
    scenario: normalizedScenario,
    totalTokens,
    archivePath,
    decision,
  }
}

export function formatCostGateFailure(report: E2ECostGateReport): string {
  if (report.decision.status !== 'fail') {
    return report.decision.message
  }
  return `${report.decision.message}; usage_archive=${report.archivePath}`
}

export function assertNoCostRegression(report: E2ECostGateReport): void {
  if (report.decision.status === 'fail') {
    throw new Error(formatCostGateFailure(report))
  }
}

/**
 * Run a single-task agent loop in the sandbox and return the result.
 * Uses auto_allow permissions so tests never block on interactive prompts.
 */
export async function runAgent(
  task: string,
  cwd: string,
  options?: { scenario?: string },
): Promise<RunLoopResult> {
  const { result } = await runSandboxedAgent(task, cwd, options)
  return result
}

export async function runSandboxedAgent(
  task: string,
  cwd: string,
  options?: {
    scenario?: string
    sandbox?: MerlionSandboxConfig
    deferCostGateFailure?: boolean
  },
): Promise<{
  result: RunLoopResult
  sandboxEvents: RuntimeSandboxEvent[]
  costGate: E2ECostGateReport
}> {
  const provider = new OpenAICompatProvider({
    apiKey: API_KEY,
    baseURL: E2E_BASE_URL,
    model: E2E_MODEL,
  })
  const registry = makeRegistry({ scenario: options?.scenario })
  const toolSchema = summarizeToolSchema(registry.getAll())
  const promptObservabilityTracker = createPromptObservabilityTrackerWithToolSchema(toolSchema.tool_schema_serialized)
  const usageTracker = createUsageTracker()
  const usageRates = resolveUsageRatesFromEnv(process.env)
  const usageSamples: Array<{ prompt_tokens: number; completion_tokens: number; cached_tokens: number | null }> = []
  const promptObservabilityByTurn = new Map<number, PromptObservabilitySnapshot>()
  const sandboxEvents: RuntimeSandboxEvent[] = []
  const protectedPaths = await deriveSandboxProtectedPaths(cwd)
  const sandboxPolicy = resolveSandboxPolicy({
    cwd,
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-failure',
    networkMode: 'off',
    ...options?.sandbox,
    fixedDenyRead: protectedPaths.denyRead,
    fixedDenyWrite: protectedPaths.denyWrite,
  })
  const sandboxBackend = sandboxPolicy
    ? await resolveSandboxBackend(sandboxPolicy)
    : undefined

  const result = await runLoop({
    provider,
    registry,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: task,
    cwd,
    maxTurns: 30,
    permissions: { ask: async () => 'allow_session' },
    sandboxPolicy,
    sandboxBackend,
    askQuestions: async (questions) =>
      Object.fromEntries(
        questions.map((question) => [question.id, question.options[0]?.label ?? ''])
      ),
    promptObservabilityTracker,
    onPromptObservability: (snapshot) => {
      promptObservabilityByTurn.set(snapshot.turn, snapshot)
    },
    onSandboxEvent: (event) => {
      sandboxEvents.push(event)
    },
    onUsage: (usage) => {
      usageTracker.record(usage)
      usageSamples.push({
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        cached_tokens: usage.cached_tokens ?? null,
      })
    },
  })

  const derivedTotals = usageTracker.getDerivedMetrics(usageRates)
  const archivePath = await writeUsageArchive({
    scenario: options?.scenario ?? 'e2e',
    task,
    cwd,
    result,
    model: E2E_MODEL,
    baseURL: E2E_BASE_URL,
    usageSamples,
    totals: usageTracker.getTotals(),
    toolSchema,
    promptObservability: Array.from(promptObservabilityByTurn.values()),
    usageRates,
    derivedTotals,
  })
  const costGate = await evaluateArchivedCostGate(
    options?.scenario ?? 'e2e',
    usageTracker.getTotals().total_tokens,
    archivePath,
    derivedTotals,
  )
  if (!options?.deferCostGateFailure) {
    assertNoCostRegression(costGate)
  }

  return { result, sandboxEvents, costGate }
}
