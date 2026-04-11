/**
 * E2E test helpers.
 *
 * All E2E tests require OPENROUTER_API_KEY in the environment.
 * Tests are skipped automatically when the key is absent.
 */
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { OpenAICompatProvider } from '../../src/providers/openai.ts'
import { buildDefaultRegistry } from '../../src/tools/builtin/index.ts'
import { runLoop } from '../../src/runtime/loop.ts'
import type { RunLoopResult } from '../../src/runtime/loop.ts'

export const FIXTURES_DIR = join(fileURLToPath(import.meta.url), '../../fixtures')

// Default model for E2E tests — cheap but capable enough for simple tool-use tasks.
const E2E_MODEL = process.env.MERLION_E2E_MODEL ?? 'anthropic/claude-haiku-4-5'
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

/**
 * Run a single-task agent loop in the sandbox and return the result.
 * Uses auto_allow permissions so tests never block on interactive prompts.
 */
export async function runAgent(task: string, cwd: string): Promise<RunLoopResult> {
  const provider = new OpenAICompatProvider({
    apiKey: API_KEY,
    baseURL: E2E_BASE_URL,
    model: E2E_MODEL,
  })
  const registry = buildDefaultRegistry()

  return runLoop({
    provider,
    registry,
    systemPrompt:
      'You are Merlion, a coding agent. Use your tools to complete the task. ' +
      'Be concise. When done, state what you did.',
    userPrompt: task,
    cwd,
    maxTurns: 20,
    permissions: { ask: async () => 'allow_session' },
  })
}
