import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  filterCases,
  getBenchRoot,
  getCaseRunRoot,
  getCheckoutCommand,
  getRepoRoot,
  getWorkspaceRepoDir,
  loadAllCases,
  nowStamp,
  resolveBugsInPyHome,
  shellQuote,
  type BugsInPyCaseSpec,
} from './common.ts'

interface CommandOutcome {
  command: string
  code: number | null
  timedOut: boolean
  duration_ms: number
  stdout: string
  stderr: string
}

interface CaseResult {
  case_id: string
  project: string
  bug_id: number
  status: 'passed' | 'failed'
  duration_ms: number
  workspace: string
  command_results: {
    checkout?: CommandOutcome
    compile?: CommandOutcome
    agent?: CommandOutcome
    acceptance?: CommandOutcome
    regression?: CommandOutcome
  }
  failure_reason?: string
}

interface Summary {
  run_dir: string
  total_cases: number
  passed_cases: number
  failed_cases: number
  run_agent: boolean
  cases: Array<{
    case_id: string
    project: string
    bug_id: number
    status: 'passed' | 'failed'
    duration_ms: number
  }>
}

interface RunOptions {
  bugsInPyHome: string
  runAgent: boolean
  repoRoot: string
  runDir: string
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.floor(parsed)
}

async function runCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandOutcome> {
  const startedAt = Date.now()
  return await new Promise<CommandOutcome>((resolveOutcome) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    child.stdout.on('data', (buf) => {
      const chunk = String(buf)
      stdout += chunk
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (buf) => {
      const chunk = String(buf)
      stderr += chunk
      process.stderr.write(chunk)
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)

    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveOutcome({
        command,
        code,
        timedOut,
        duration_ms: Date.now() - startedAt,
        stdout,
        stderr,
      })
    }

    child.on('close', (code) => finish(code))
    child.on('error', (error) => {
      stderr += `${String(error)}\n`
      finish(1)
    })
  })
}

function buildCompileCommand(repoRoot: string, repoDir: string): string {
  return `node --experimental-strip-types ${shellQuote(join(repoRoot, 'scripts/bench_medium/bugsinpy/compile.ts'))} --repo ${shellQuote(repoDir)}`
}

function buildTestCommand(repoRoot: string, repoDir: string, mode: 'relevant' | 'all'): string {
  return `node --experimental-strip-types ${shellQuote(join(repoRoot, 'scripts/bench_medium/bugsinpy/test.ts'))} --repo ${shellQuote(repoDir)} --mode ${mode}`
}

function buildAgentCommand(repoDir: string, prompt: string): string {
  return `npm run -s merlion -- --auto-allow --cwd ${shellQuote(repoDir)} ${shellQuote(prompt)}`
}

export async function runCase(spec: BugsInPyCaseSpec, options: RunOptions): Promise<CaseResult> {
  const startedAt = Date.now()
  const caseRunDir = getCaseRunRoot(options.runDir, spec.id)
  const workspaceDir = join(caseRunDir, 'workspace')
  await mkdir(workspaceDir, { recursive: true })

  const result: CaseResult = {
    case_id: spec.id,
    project: spec.project,
    bug_id: spec.bug_id,
    status: 'failed',
    duration_ms: 0,
    workspace: relative(options.repoRoot, workspaceDir).replace(/\\/g, '/'),
    command_results: {},
  }

  const timeoutMs = spec.timeout_sec * 1000
  const repoDir = getWorkspaceRepoDir(workspaceDir, spec.project)

  const checkout = await runCommand(getCheckoutCommand({
    bugsInPyHome: options.bugsInPyHome,
    project: spec.project,
    bugId: spec.bug_id,
    version: spec.version,
    workspaceDir,
  }), options.repoRoot, timeoutMs)
  result.command_results.checkout = checkout
  if (checkout.timedOut || (checkout.code ?? 1) !== 0) {
    result.failure_reason = checkout.timedOut ? 'checkout timed out' : 'checkout failed'
    result.duration_ms = Date.now() - startedAt
    return result
  }

  const compile = await runCommand(buildCompileCommand(options.repoRoot, repoDir), options.repoRoot, timeoutMs)
  result.command_results.compile = compile
  if (compile.timedOut || (compile.code ?? 1) !== 0) {
    result.failure_reason = compile.timedOut ? 'compile timed out' : 'compile failed'
    result.duration_ms = Date.now() - startedAt
    return result
  }

  if (options.runAgent) {
    const agent = await runCommand(buildAgentCommand(repoDir, spec.taskPrompt), options.repoRoot, timeoutMs)
    result.command_results.agent = agent
    if (agent.timedOut || (agent.code ?? 1) !== 0) {
      result.failure_reason = agent.timedOut ? 'agent timed out' : 'agent failed'
      result.duration_ms = Date.now() - startedAt
      return result
    }
  }

  const acceptance = await runCommand(
    buildTestCommand(options.repoRoot, repoDir, spec.acceptance_mode),
    options.repoRoot,
    timeoutMs,
  )
  result.command_results.acceptance = acceptance
  if (acceptance.timedOut || (acceptance.code ?? 1) !== 0) {
    result.failure_reason = acceptance.timedOut ? 'acceptance timed out' : 'acceptance failed'
    result.duration_ms = Date.now() - startedAt
    return result
  }

  const regression = await runCommand(
    buildTestCommand(options.repoRoot, repoDir, spec.regression_mode),
    options.repoRoot,
    timeoutMs,
  )
  result.command_results.regression = regression
  if (regression.timedOut || (regression.code ?? 1) !== 0) {
    result.failure_reason = regression.timedOut ? 'regression timed out' : 'regression failed'
    result.duration_ms = Date.now() - startedAt
    return result
  }

  result.status = 'passed'
  result.duration_ms = Date.now() - startedAt
  return result
}

async function main(): Promise<void> {
  const repoRoot = getRepoRoot()
  const bugsInPyHome = resolveBugsInPyHome()
  const runAgent = process.env.MERLION_BUGSINPY_RUN_AGENT === '1'
  const benchRoot = getBenchRoot()
  const runDir = join(benchRoot, 'results', nowStamp())
  await mkdir(runDir, { recursive: true })

  const cases = filterCases(await loadAllCases())
  if (cases.length === 0) {
    throw new Error('no BugsInPy cases matched the current filter')
  }

  const concurrency = parsePositiveInt(process.env.MERLION_BUGSINPY_CONCURRENCY, 1)
  const results = new Array<CaseResult>(cases.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= cases.length) return
      const spec = cases[index]!
      process.stdout.write(`[bugsinpy] start ${spec.id}\n`)
      const result = await runCase(spec, { bugsInPyHome, runAgent, repoRoot, runDir })
      results[index] = result
      await writeFile(join(runDir, `${spec.id}.result.json`), JSON.stringify(result, null, 2), 'utf8')
      process.stdout.write(`[bugsinpy] done ${spec.id}: ${result.status}\n`)
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()))

  const summary: Summary = {
    run_dir: runDir,
    total_cases: results.length,
    passed_cases: results.filter((item) => item.status === 'passed').length,
    failed_cases: results.filter((item) => item.status === 'failed').length,
    run_agent: runAgent,
    cases: results
      .map((item) => ({
        case_id: item.case_id,
        project: item.project,
        bug_id: item.bug_id,
        status: item.status,
        duration_ms: item.duration_ms,
      }))
      .sort((a, b) => a.case_id.localeCompare(b.case_id)),
  }

  await writeFile(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
  process.stdout.write(`[bugsinpy] summary written to ${runDir}\n`)
  if (summary.failed_cases > 0) {
    process.exitCode = 1
  }
}

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
