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

import { evaluateCostGate, parseCostGateMode, readCostBaseline } from '../../src/runtime/cost_gate.ts'
import { OpenAICompatProvider } from '../../src/providers/openai.ts'
import { buildDefaultRegistry } from '../../src/tools/builtin/index.ts'
import { runLoop } from '../../src/runtime/loop.ts'
import type { RunLoopResult } from '../../src/runtime/loop.ts'
import { createUsageTracker } from '../../src/runtime/usage.ts'

export const FIXTURES_DIR = join(fileURLToPath(import.meta.url), '../fixtures')

// Default model for E2E tests.
// Priority: MERLION_E2E_MODEL > MERLION_MODEL > cheap default
const E2E_MODEL =
  process.env.MERLION_E2E_MODEL ??
  process.env.MERLION_MODEL ??
  'anthropic/claude-haiku-4-5'
const E2E_BASE_URL = process.env.MERLION_BASE_URL ?? 'https://openrouter.ai/api/v1'

export const API_KEY = process.env.OPENROUTER_API_KEY ?? ''
export const SKIP = !API_KEY

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

async function writeUsageArchive(params: {
  scenario: string
  task: string
  cwd: string
  result: RunLoopResult
  model: string
  baseURL: string
  usageSamples: Array<{ prompt_tokens: number; completion_tokens: number; cached_tokens: number | null }>
  totals: { prompt_tokens: number; completion_tokens: number; cached_tokens: number; total_tokens: number }
}): Promise<void> {
  const dir = getUsageArchiveDir()
  await mkdir(dir, { recursive: true })
  const scenario = safeScenarioLabel(params.scenario)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(dir, `${scenario}-${stamp}.json`)
  const payload = {
    timestamp: new Date().toISOString(),
    scenario,
    model: params.model,
    base_url: params.baseURL,
    cwd: params.cwd,
    terminal: params.result.terminal,
    task: params.task,
    final_text: params.result.finalText,
    turn_count: params.result.state.turnCount,
    usage_samples: params.usageSamples,
    totals: params.totals
  }
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

async function enforceCostGate(scenario: string, totalTokens: number): Promise<void> {
  const mode = parseCostGateMode(process.env.MERLION_COST_GATE)
  const baseline = await readCostBaseline(getCostBaselinePath())
  const decision = evaluateCostGate({
    baseline,
    scenario: safeScenarioLabel(scenario),
    totalTokens,
    mode
  })

  if (decision.status === 'warn') {
    process.stderr.write(`${decision.message}\n`)
    return
  }
  if (decision.status === 'fail') {
    throw new Error(decision.message)
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
  const provider = new OpenAICompatProvider({
    apiKey: API_KEY,
    baseURL: E2E_BASE_URL,
    model: E2E_MODEL,
  })
  const registry = buildDefaultRegistry()
  const usageTracker = createUsageTracker()
  const usageSamples: Array<{ prompt_tokens: number; completion_tokens: number; cached_tokens: number | null }> = []

  const result = await runLoop({
    provider,
    registry,
    systemPrompt:
      'You are Merlion, a coding agent. Use your tools to complete the task. ' +
      'Be concise. When done, state what you did.',
    userPrompt: task,
    cwd,
    maxTurns: 30,
    permissions: { ask: async () => 'allow_session' },
    onUsage: (usage) => {
      usageTracker.record(usage)
      usageSamples.push({
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        cached_tokens: usage.cached_tokens ?? null,
      })
    },
  })

  await writeUsageArchive({
    scenario: options?.scenario ?? 'e2e',
    task,
    cwd,
    result,
    model: E2E_MODEL,
    baseURL: E2E_BASE_URL,
    usageSamples,
    totals: usageTracker.getTotals(),
  })
  await enforceCostGate(options?.scenario ?? 'e2e', usageTracker.getTotals().total_tokens)

  return result
}
