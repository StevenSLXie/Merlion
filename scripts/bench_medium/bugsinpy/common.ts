import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export type BugsInPyVersion = 'buggy' | 'fixed'
export type BugsInPyTestMode = 'relevant' | 'all'
export type SeedStatus = 'seeded' | 'validated'

export interface BugsInPyCaseFile {
  id: string
  title: string
  project: string
  bug_id: number
  version: BugsInPyVersion
  timeout_sec: number
  acceptance_mode: BugsInPyTestMode
  regression_mode: BugsInPyTestMode
  python_version_hint?: string
  tags?: string[]
  status?: SeedStatus
  notes?: string[]
}

export interface BugsInPyCaseSpec extends BugsInPyCaseFile {
  caseDir: string
  taskPath: string
  taskPrompt: string
  tags: string[]
  status: SeedStatus
  notes: string[]
}

export interface BugsInPyBugInfo {
  pythonpathEntries: string[]
  testFiles: string[]
  raw: Record<string, string>
}

function compareByLocale(a: string, b: string): number {
  return a.localeCompare(b)
}

export function getRepoRoot(): string {
  return resolve(import.meta.dirname, '../../..')
}

export function getBenchRoot(): string {
  return join(getRepoRoot(), 'bench_medium', 'bugsinpy')
}

export function getCasesRoot(): string {
  return join(getBenchRoot(), 'cases')
}

export function resolveBugsInPyHome(raw = process.env.MERLION_BUGSINPY_HOME ?? process.env.BUGSINPY_HOME): string {
  if (!raw || raw.trim() === '') {
    throw new Error('MERLION_BUGSINPY_HOME or BUGSINPY_HOME must point to a local BugsInPy clone')
  }
  return resolve(raw)
}

export async function findCaseDirs(root = getCasesRoot()): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort(compareByLocale)
  const valid: string[] = []
  for (const dir of dirs) {
    const hasCase = await stat(join(dir, 'case.json')).then(() => true).catch(() => false)
    const hasTask = await stat(join(dir, 'task.md')).then(() => true).catch(() => false)
    if (hasCase && hasTask) valid.push(dir)
  }
  return valid
}

export async function loadCaseSpec(caseDir: string): Promise<BugsInPyCaseSpec> {
  const casePath = join(caseDir, 'case.json')
  const taskPath = join(caseDir, 'task.md')
  const [rawCase, taskPrompt] = await Promise.all([
    readFile(casePath, 'utf8'),
    readFile(taskPath, 'utf8'),
  ])
  const parsed = JSON.parse(rawCase) as BugsInPyCaseFile
  return {
    ...parsed,
    caseDir,
    taskPath,
    taskPrompt: taskPrompt.trim(),
    tags: parsed.tags ?? [],
    status: parsed.status ?? 'seeded',
    notes: parsed.notes ?? [],
  }
}

export async function loadAllCases(root = getCasesRoot()): Promise<BugsInPyCaseSpec[]> {
  const dirs = await findCaseDirs(root)
  const cases = await Promise.all(dirs.map((dir) => loadCaseSpec(dir)))
  return cases.sort((a, b) => a.id.localeCompare(b.id))
}

export function filterCases(cases: BugsInPyCaseSpec[], filter = process.env.MERLION_BUGSINPY_CASE_FILTER ?? ''): BugsInPyCaseSpec[] {
  const needle = filter.trim().toLowerCase()
  if (needle === '') return cases
  return cases.filter((item) => (
    item.id.toLowerCase().includes(needle) ||
    item.project.toLowerCase().includes(needle) ||
    item.title.toLowerCase().includes(needle)
  ))
}

export function resolveVersionFlag(version: BugsInPyVersion): '0' | '1' {
  return version === 'fixed' ? '1' : '0'
}

export function getCheckoutCommand(params: {
  bugsInPyHome: string
  project: string
  bugId: number
  version: BugsInPyVersion
  workspaceDir: string
}): string {
  const checkout = join(params.bugsInPyHome, 'framework', 'bin', 'bugsinpy-checkout')
  const versionFlag = resolveVersionFlag(params.version)
  return `${shellQuote(checkout)} -p ${shellQuote(params.project)} -i ${params.bugId} -v ${versionFlag} -w ${shellQuote(params.workspaceDir)}`
}

export function getWorkspaceRepoDir(workspaceDir: string, project: string): string {
  return join(workspaceDir, project)
}

export async function assertCheckoutDir(repoDir: string): Promise<void> {
  const required = [
    'bugsinpy_bug.info',
    'bugsinpy_requirements.txt',
    'bugsinpy_run_test.sh',
  ]
  for (const file of required) {
    const path = join(repoDir, file)
    const exists = await stat(path).then(() => true).catch(() => false)
    if (!exists) {
      throw new Error(`invalid BugsInPy checkout: missing ${file} in ${repoDir}`)
    }
  }
}

export async function readBugInfo(repoDir: string): Promise<BugsInPyBugInfo> {
  const path = join(repoDir, 'bugsinpy_bug.info')
  const raw = await readFile(path, 'utf8')
  const map: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-zA-Z0-9_]+)="(.*)"$/)
    if (!match) continue
    map[match[1]!] = match[2]!
  }
  return {
    pythonpathEntries: splitBugList(map.pythonpath),
    testFiles: splitBugList(map.test_file),
    raw: map,
  }
}

export function splitBugList(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(';').map((item) => item.trim()).filter(Boolean)
}

export function computePythonPath(repoDir: string, bugInfo: BugsInPyBugInfo): string {
  const existing = process.env.PYTHONPATH?.trim()
  const next = bugInfo.pythonpathEntries
    .map((entry) => resolve(repoDir, entry))
    .filter((entry) => entry !== '')
  if (existing) next.push(existing)
  return next.join(':')
}

export function getCaseRunRoot(rootDir: string, caseId: string): string {
  return join(rootDir, caseId)
}

export function nowStamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}
