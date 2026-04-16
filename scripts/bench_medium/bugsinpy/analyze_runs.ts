import { readdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

type FailureBucket =
  | 'success'
  | 'environment'
  | 'agent_runtime'
  | 'target_bug_unsolved'
  | 'regression_after_fix'

interface CaseResult {
  case_id: string
  project: string
  bug_id: number
  status: 'passed' | 'failed'
  failure_reason?: string
  command_results?: {
    agent?: { code: number | null }
    acceptance?: { code: number | null }
    regression?: { code: number | null }
  }
}

interface AnalysisItem {
  case_id: string
  project: string
  bug_id: number
  bucket: FailureBucket
  reason: string
}

interface AnalysisSummary {
  run_dir: string
  total_cases: number
  buckets: Record<FailureBucket, number>
  cases: AnalysisItem[]
}

export function classifyResult(result: CaseResult): AnalysisItem {
  if (result.status === 'passed') {
    return {
      case_id: result.case_id,
      project: result.project,
      bug_id: result.bug_id,
      bucket: 'success',
      reason: 'all stages passed',
    }
  }

  const reason = result.failure_reason ?? 'unknown failure'
  if (reason.includes('checkout') || reason.includes('compile')) {
    return {
      case_id: result.case_id,
      project: result.project,
      bug_id: result.bug_id,
      bucket: 'environment',
      reason,
    }
  }
  if (reason.includes('agent')) {
    return {
      case_id: result.case_id,
      project: result.project,
      bug_id: result.bug_id,
      bucket: 'agent_runtime',
      reason,
    }
  }
  if (reason.includes('regression')) {
    return {
      case_id: result.case_id,
      project: result.project,
      bug_id: result.bug_id,
      bucket: 'regression_after_fix',
      reason,
    }
  }
  return {
    case_id: result.case_id,
    project: result.project,
    bug_id: result.bug_id,
    bucket: 'target_bug_unsolved',
    reason,
  }
}

function resolveRunDir(raw: string | undefined): string {
  if (!raw || raw.trim() === '') {
    throw new Error('usage: analyze_runs.ts <run-dir>')
  }
  return isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
}

async function loadCaseResults(runDir: string): Promise<CaseResult[]> {
  const entries = await readdir(runDir, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.result.json'))
    .map((entry) => join(runDir, entry.name))
    .sort((a, b) => a.localeCompare(b))
  const results = await Promise.all(files.map(async (path) => JSON.parse(await readFile(path, 'utf8')) as CaseResult))
  return results
}

async function main(): Promise<void> {
  const runDir = resolveRunDir(process.argv[2])
  const results = await loadCaseResults(runDir)
  const cases = results.map(classifyResult)
  const buckets: Record<FailureBucket, number> = {
    success: 0,
    environment: 0,
    agent_runtime: 0,
    target_bug_unsolved: 0,
    regression_after_fix: 0,
  }
  for (const item of cases) buckets[item.bucket] += 1

  const summary: AnalysisSummary = {
    run_dir: runDir,
    total_cases: cases.length,
    buckets,
    cases,
  }
  await writeFile(join(runDir, 'analysis.json'), JSON.stringify(summary, null, 2), 'utf8')
}

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
