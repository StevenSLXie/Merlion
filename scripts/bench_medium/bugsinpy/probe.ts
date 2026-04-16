import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getBenchRoot, getRepoRoot, nowStamp, resolveBugsInPyHome } from './common.ts'
import { runCase } from './run.ts'

interface ProbeCaseResult {
  case_id: string
  project: string
  bug_id: number
  version: 'buggy' | 'fixed'
  status: 'passed' | 'failed'
  failure_reason?: string
  duration_ms: number
}

interface ProbeSummary {
  run_dir: string
  project: string
  version: 'buggy' | 'fixed'
  run_agent: boolean
  total_cases: number
  passed_cases: number
  failed_cases: number
  cases: ProbeCaseResult[]
}

function parseBugIds(raw: string | undefined): number[] {
  if (!raw || raw.trim() === '') {
    throw new Error('MERLION_BUGSINPY_PROBE_BUG_IDS must be a comma-separated list')
  }
  const ids = raw
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.floor(item))
  if (ids.length === 0) {
    throw new Error('MERLION_BUGSINPY_PROBE_BUG_IDS did not contain valid positive integers')
  }
  return ids
}

export function buildEphemeralCaseSpec(params: {
  project: string
  bugId: number
  version: 'buggy' | 'fixed'
}): {
  id: string
  title: string
  project: string
  bug_id: number
  version: 'buggy' | 'fixed'
  timeout_sec: number
  acceptance_mode: 'relevant'
  regression_mode: 'all'
  caseDir: string
  taskPath: string
  taskPrompt: string
  tags: string[]
  status: 'seeded'
  notes: string[]
} {
  const versionTag = params.version === 'fixed' ? 'FIXED' : 'BUGGY'
  return {
    id: `PROBE_${params.project.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${params.bugId}_${versionTag}`,
    title: `${params.project} bug ${params.bugId} (${params.version})`,
    project: params.project,
    bug_id: params.bugId,
    version: params.version,
    timeout_sec: 1500,
    acceptance_mode: 'relevant',
    regression_mode: 'all',
    caseDir: '',
    taskPath: '',
    taskPrompt: params.version === 'fixed'
      ? `Probe the fixed baseline for ${params.project} bug ${params.bugId}. Do not modify code.`
      : `Probe the buggy baseline for ${params.project} bug ${params.bugId}.`,
    tags: ['probe'],
    status: 'seeded',
    notes: [],
  }
}

async function main(): Promise<void> {
  const repoRoot = getRepoRoot()
  const bugsInPyHome = resolveBugsInPyHome()
  const project = process.env.MERLION_BUGSINPY_PROBE_PROJECT?.trim()
  if (!project) {
    throw new Error('MERLION_BUGSINPY_PROBE_PROJECT is required')
  }
  const bugIds = parseBugIds(process.env.MERLION_BUGSINPY_PROBE_BUG_IDS)
  const version = (process.env.MERLION_BUGSINPY_PROBE_VERSION?.trim() === 'fixed' ? 'fixed' : 'buggy') as 'buggy' | 'fixed'
  const runAgent = process.env.MERLION_BUGSINPY_PROBE_RUN_AGENT === '1'
  const runDir = join(getBenchRoot(), 'probe_results', nowStamp())
  await mkdir(runDir, { recursive: true })

  const cases: ProbeCaseResult[] = []
  for (const bugId of bugIds) {
    const spec = buildEphemeralCaseSpec({ project, bugId, version })
    const result = await runCase(spec, {
      bugsInPyHome,
      runAgent,
      repoRoot,
      runDir,
    })
    const item: ProbeCaseResult = {
      case_id: spec.id,
      project,
      bug_id: bugId,
      version,
      status: result.status,
      failure_reason: result.failure_reason,
      duration_ms: result.duration_ms,
    }
    cases.push(item)
    await writeFile(join(runDir, `${spec.id}.result.json`), JSON.stringify(result, null, 2), 'utf8')
  }

  const summary: ProbeSummary = {
    run_dir: runDir,
    project,
    version,
    run_agent: runAgent,
    total_cases: cases.length,
    passed_cases: cases.filter((item) => item.status === 'passed').length,
    failed_cases: cases.filter((item) => item.status === 'failed').length,
    cases,
  }
  await writeFile(join(runDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
}

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
