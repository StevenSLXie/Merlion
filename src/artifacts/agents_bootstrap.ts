import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

import { fileExists, findProjectRoot, GUIDANCE_FILENAMES } from './agents.ts'
import {
  bootstrapDepthForFileCount,
  collectDirectorySignals,
  estimateRepositoryFileCount,
  inferDirectoryPurpose,
} from './repo_semantics.ts'

export interface AgentsBootstrapOptions {
  maxTopDirs?: number
  maxSecondLevelDirs?: number
  force?: boolean
}

export interface AgentsBootstrapResult {
  created: boolean
  generatedFiles: string[]
  reason: 'generated' | 'up_to_date'
}

interface BootstrapMeta {
  version: number
  head: string
  generatedAt: string
  files: string[]
}

const BOOTSTRAP_META_VERSION = 1
const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.merlion'])
const GENERATED_GUIDANCE_FILENAME = 'MERLION.md'
const DEFAULTS: Required<AgentsBootstrapOptions> = {
  maxTopDirs: 12,
  maxSecondLevelDirs: 10,
  force: false,
}

function runGit(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8'
    }).trim()
  } catch {
    return ''
  }
}

function generatedMapPath(root: string, directory: string, filename: string): string {
  const rel = relative(root, directory)
  if (rel === '') return join(root, '.merlion', 'maps', filename)
  return join(root, '.merlion', 'maps', rel, filename)
}

function summarizeCommits(raw: string): string[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 5)
}

function uniqueNonEmpty(lines: string[], limit: number): string[] {
  const out: string[] = []
  for (const line of lines.map((x) => x.trim()).filter(Boolean)) {
    if (!out.includes(line)) out.push(line)
    if (out.length >= limit) break
  }
  return out
}

async function hasGuidanceFileInDirectory(dir: string): Promise<boolean> {
  for (const filename of GUIDANCE_FILENAMES) {
    if (await fileExists(join(dir, filename))) return true
  }
  return false
}

async function hasAllFiles(root: string, files: string[]): Promise<boolean> {
  for (const rel of files) {
    if (!(await fileExists(join(root, rel)))) return false
  }
  return true
}

async function hasCoverageForTargets(root: string, targets: string[]): Promise<boolean> {
  for (const dir of targets) {
    if (await hasGuidanceFileInDirectory(dir)) continue
    const generated = generatedMapPath(root, dir, GENERATED_GUIDANCE_FILENAME)
    if (!(await fileExists(generated))) return false
  }
  return true
}

async function readBootstrapMeta(path: string): Promise<BootstrapMeta | null> {
  if (!(await fileExists(path))) return null
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as BootstrapMeta
    if (parsed && typeof parsed === 'object' && parsed.version === BOOTSTRAP_META_VERSION) return parsed
  } catch {
    return null
  }
  return null
}

async function listChildrenDirs(directory: string, limit: number): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !IGNORE_DIRS.has(entry.name) && !entry.name.startsWith('.'))
    .map((entry) => join(directory, entry.name))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit)
}

async function detectEntryPoints(directory: string, root: string): Promise<string[]> {
  const candidates: string[] = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (entry.name.startsWith('.')) continue
    const name = entry.name.toLowerCase()
    if (
      name.startsWith('index.') ||
      name.startsWith('main.') ||
      name.startsWith('app.') ||
      name.includes('router') ||
      name.includes('entry')
    ) {
      candidates.push(relative(root, join(directory, entry.name)).replace(/\\/g, '/'))
    }
  }
  return candidates.slice(0, 6)
}

function renderGeneratedGuidance(params: {
  root: string
  directory: string
  purpose: string
  subareas: string[]
  entryPoints: string[]
  recentChanges: string[]
  recentCommits: string[]
  generatedAt: string
}): string {
  const relDir = relative(params.root, params.directory).replace(/\\/g, '/') || '.'
  const lines: string[] = []
  lines.push('# Generated MERLION Guidance')
  lines.push('')
  lines.push('## Scope')
  lines.push(`- directory: ${relDir}`)
  lines.push('- source: generated map bootstrap (verify with tools before edits)')
  lines.push('')
  lines.push('## Purpose')
  lines.push(`- ${params.purpose}`)
  lines.push('')
  lines.push('## Subareas')
  lines.push(...(params.subareas.length > 0 ? params.subareas.map((x) => `- ${x}`) : ['- (none)']))
  lines.push('')
  lines.push('## EntryPoints')
  lines.push(...(params.entryPoints.length > 0 ? params.entryPoints.map((x) => `- ${x}`) : ['- (none detected)']))
  lines.push('')
  lines.push('## RecentChanges')
  lines.push(...(params.recentChanges.length > 0 ? params.recentChanges.map((x) => `- ${x}`) : ['- (none)']))
  lines.push('')
  lines.push('## RecentCommits')
  lines.push(...(params.recentCommits.length > 0 ? params.recentCommits.map((x) => `- ${x}`) : ['- (none)']))
  lines.push('')
  lines.push('## LastUpdated')
  lines.push(`- ${params.generatedAt}`)
  return `${lines.join('\n')}\n`
}

async function buildTargetDirectories(root: string, options: Required<AgentsBootstrapOptions>): Promise<string[]> {
  const targets: string[] = [root]
  const topDirs = await listChildrenDirs(root, options.maxTopDirs)

  for (const dir of topDirs) {
    if (!targets.includes(dir)) targets.push(dir)
  }

  const parents = topDirs.filter((dir) => {
    const name = basename(dir)
    return name === 'src' || name === 'app' || name === 'packages' || name === 'services'
  })

  let secondLevelCount = 0
  for (const parent of parents) {
    if (secondLevelCount >= options.maxSecondLevelDirs) break
    const children = await listChildrenDirs(parent, options.maxSecondLevelDirs - secondLevelCount)
    for (const child of children) {
      if (!targets.includes(child)) targets.push(child)
      secondLevelCount += 1
      if (secondLevelCount >= options.maxSecondLevelDirs) break
    }
  }

  return targets
}

export async function ensureGeneratedAgentsMaps(
  cwd: string,
  options?: AgentsBootstrapOptions
): Promise<AgentsBootstrapResult> {
  const root = await findProjectRoot(cwd)
  const estimatedFileCount = await estimateRepositoryFileCount(root, 3000)
  const adaptive = bootstrapDepthForFileCount(estimatedFileCount)
  const merged = {
    maxTopDirs: Math.max(0, Math.floor(options?.maxTopDirs ?? adaptive.maxTopDirs ?? DEFAULTS.maxTopDirs)),
    maxSecondLevelDirs: Math.max(
      0,
      Math.floor(options?.maxSecondLevelDirs ?? adaptive.maxSecondLevelDirs ?? DEFAULTS.maxSecondLevelDirs)
    ),
    force: options?.force === true,
  }

  const targets = await buildTargetDirectories(root, merged)
  const mapsDir = join(root, '.merlion', 'maps')
  const metaPath = join(mapsDir, '.meta.json')
  const head = runGit(root, ['rev-parse', 'HEAD']) || 'no-head'
  const meta = await readBootstrapMeta(metaPath)
  if (!merged.force && meta && meta.head === head) {
    const allPresent = await hasAllFiles(root, meta.files)
    const covered = allPresent ? await hasCoverageForTargets(root, targets) : false
    if (allPresent && covered) {
      return { created: false, generatedFiles: meta.files, reason: 'up_to_date' }
    }
  }

  const generatedAt = new Date().toISOString().slice(0, 10)
  const generatedFiles: string[] = []

  for (const dir of targets) {
    if (await hasGuidanceFileInDirectory(dir)) continue

    const relDir = relative(root, dir).replace(/\\/g, '/')
    const pathArg = relDir === '' ? '.' : relDir

    const subareas = (await listChildrenDirs(dir, 8)).map((child) => relative(root, child).replace(/\\/g, '/'))
    const entryPoints = await detectEntryPoints(dir, root)
    const signals = await collectDirectorySignals(dir, 90)
    const purpose = inferDirectoryPurpose({
      root,
      directory: dir,
      signals,
    })
    const recentChanges = uniqueNonEmpty(
      runGit(root, ['log', '--name-only', '--pretty=format:', '-n', '20', '--', pathArg]).split('\n'),
      8
    )
    const recentCommits = summarizeCommits(
      runGit(root, ['log', '--date=short', '--pretty=format:%h%x20%ad%x20%s', '-n', '5', '--', pathArg])
    )

    const content = renderGeneratedGuidance({
      root,
      directory: dir,
      purpose,
      subareas,
      entryPoints,
      recentChanges,
      recentCommits,
      generatedAt,
    })

    const mapPath = generatedMapPath(root, dir, GENERATED_GUIDANCE_FILENAME)
    await mkdir(dirname(mapPath), { recursive: true })
    await writeFile(mapPath, content, 'utf8')
    generatedFiles.push(relative(root, mapPath).replace(/\\/g, '/'))
  }

  await mkdir(mapsDir, { recursive: true })
  const metaOut: BootstrapMeta = {
    version: BOOTSTRAP_META_VERSION,
    head,
    generatedAt,
    files: generatedFiles,
  }
  await writeFile(metaPath, `${JSON.stringify(metaOut, null, 2)}\n`, 'utf8')

  return {
    created: generatedFiles.length > 0,
    generatedFiles,
    reason: generatedFiles.length > 0 ? 'generated' : 'up_to_date'
  }
}
