import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { GUIDANCE_FILENAMES } from './agents.ts'
import { collectDirectorySignals, inferDirectoryPurpose } from './repo_semantics.ts'

export interface CodebaseIndexArtifact {
  path: string
  content: string
}

export interface ReadCodebaseIndexOptions {
  maxTokens?: number
}

interface TopLevelEntry {
  name: string
  isDirectory: boolean
}

interface ChangedRecord {
  path: string
  note: string
}

const MAX_FILE_MAP_LINES = 80
const MAX_CHANGED_FILES = 50
const MAX_DIRECTORY_SUMMARIES = 10
const MAX_GUIDANCE_SCOPES = 20

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  '.merlion',
  'dist',
  'build',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
  '.idea',
  '.vscode',
  'coverage',
  '.coverage',
])

const IGNORE_FILE_SUFFIXES = ['.pyc', '.pyo', '.tmp', '.swp', '.swo', '.log', '.lock']

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function findProjectRoot(startCwd: string): Promise<string> {
  let cursor = resolve(startCwd)
  for (;;) {
    if (await fileExists(join(cursor, '.git'))) return cursor
    const parent = resolve(cursor, '..')
    if (parent === cursor) return resolve(startCwd)
    cursor = parent
  }
}

function runGit(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: root,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim()
  } catch {
    return ''
  }
}

async function listTopLevelEntries(root: string): Promise<TopLevelEntry[]> {
  const entries = await readdir(root, { withFileTypes: true })
  return entries
    .filter((entry) => !entry.name.startsWith('.') && !IGNORE_DIRS.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

function renderTopLevel(entries: TopLevelEntry[]): string[] {
  return entries.map((entry) => `${entry.isDirectory ? '[dir]' : '[file]'} ${entry.name}`)
}

async function readScripts(root: string): Promise<string[]> {
  const pkgPath = join(root, 'package.json')
  if (!(await fileExists(pkgPath))) return []
  try {
    const text = await readFile(pkgPath, 'utf8')
    const parsed = JSON.parse(text) as { scripts?: Record<string, string> }
    const scripts = parsed.scripts ?? {}
    return Object.keys(scripts)
      .sort()
      .map((name) => `${name}: ${scripts[name]}`)
  } catch {
    return []
  }
}

function pickFileMapRoots(entries: TopLevelEntry[]): string[] {
  const preferred = ['src', 'app', 'packages', 'services', 'lib', 'tests', 'docs']
  const available = new Set(entries.filter((entry) => entry.isDirectory).map((entry) => entry.name))
  const roots = preferred.filter((name) => available.has(name))
  if (roots.length > 0) return roots

  const fallback = entries
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.'))
    .slice(0, 4)
  return fallback
}

async function walkFiles(root: string, includeDirs: string[]): Promise<string[]> {
  const result: string[] = []

  async function walk(dir: string): Promise<void> {
    if (result.length >= MAX_FILE_MAP_LINES) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (result.length >= MAX_FILE_MAP_LINES) return
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue
        await walk(full)
        continue
      }
      if (!entry.isFile()) continue
      if (IGNORE_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue
      result.push(relative(root, full).replace(/\\/g, '/'))
    }
  }

  for (const dir of includeDirs) {
    const full = join(root, dir)
    if (!(await fileExists(full))) continue
    const st = await stat(full)
    if (!st.isDirectory()) continue
    await walk(full)
  }

  return result.sort()
}

function scopeForPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/').replace(/^\//, '')
  if (!normalized.includes('/')) return 'root'
  return normalized.split('/')[0] ?? 'root'
}

function formatFileMapLine(relPath: string): string {
  return `${relPath} (scope: ${scopeForPath(relPath)})`
}

async function summarizeTopLevelDirectories(root: string, entries: TopLevelEntry[]): Promise<string[]> {
  const dirs = entries.filter((entry) => entry.isDirectory).map((entry) => entry.name).slice(0, MAX_DIRECTORY_SUMMARIES)
  const out: string[] = []

  for (const dir of dirs) {
    try {
      const abs = join(root, dir)
      const signals = await collectDirectorySignals(abs, 90)
      const purpose = inferDirectoryPurpose({
        root,
        directory: abs,
        signals,
      })
      const extHint = signals.topExtensions.length > 0 ? ` top-types=${signals.topExtensions.join('/')}` : ''
      out.push(`${dir}: ${purpose}${extHint}`)
    } catch {
      out.push(`${dir}: Directory summary unavailable.`)
    }
  }

  return out
}

async function walkGuidanceFiles(
  root: string,
  directory: string,
  maxDepth: number,
  depth: number,
  out: string[],
): Promise<void> {
  if (depth > maxDepth || out.length >= MAX_GUIDANCE_SCOPES * 2) return
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (out.length >= MAX_GUIDANCE_SCOPES * 2) return
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await walkGuidanceFiles(root, full, maxDepth, depth + 1, out)
      continue
    }
    if (!entry.isFile()) continue
    if (!GUIDANCE_FILENAMES.includes(entry.name as (typeof GUIDANCE_FILENAMES)[number])) continue
    out.push(relative(root, full).replace(/\\/g, '/'))
  }
}

async function listGuidanceScopes(root: string): Promise<string[]> {
  const found: string[] = []

  // project guidance files
  await walkGuidanceFiles(root, root, 2, 0, found)

  // generated fallback maps
  const mapsRoot = join(root, '.merlion', 'maps')
  if (await fileExists(mapsRoot)) {
    const generated: string[] = []
    await walkGuidanceFiles(root, mapsRoot, 4, 0, generated)
    for (const relPath of generated) {
      const normalized = relPath.replace(/\\/g, '/')
      const prefix = '.merlion/maps/'
      if (!normalized.startsWith(prefix)) continue
      const logical = normalized.slice(prefix.length)
      const scope = logical.includes('/') ? logical.slice(0, logical.lastIndexOf('/')) : '.'
      const filename = basename(logical)
      found.push(`${scope}: generated ${filename}`)
    }
  }

  const normalized = found.map((entry) => {
    if (entry.includes(': generated')) return entry
    const scope = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/')) : '.'
    const filename = basename(entry)
    return `${scope}: project ${filename}`
  })

  const unique: string[] = []
  for (const item of normalized) {
    if (!unique.includes(item)) unique.push(item)
    if (unique.length >= MAX_GUIDANCE_SCOPES) break
  }
  return unique
}

function parseChangedRecords(content: string): ChangedRecord[] {
  const marker = '## Recent Changed Files'
  const start = content.indexOf(marker)
  if (start === -1) return []
  const afterStart = content.slice(start + marker.length)
  const nextHeadingPos = afterStart.indexOf('\n## ')
  const block = (nextHeadingPos === -1 ? afterStart : afterStart.slice(0, nextHeadingPos)).trim()

  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- changed: '))
    .map((line) => line.slice('- changed: '.length).trim())
    .map((payload) => {
      const splitIdx = payload.indexOf(' — ')
      if (splitIdx === -1) {
        return { path: payload, note: 'working tree (uncommitted)' }
      }
      return {
        path: payload.slice(0, splitIdx).trim(),
        note: payload.slice(splitIdx + 3).trim() || 'working tree (uncommitted)',
      }
    })
    .filter((item) => item.path !== '')
}

function latestChangeNote(root: string, relPath: string): string {
  const commit = runGit(root, ['log', '--date=short', '--pretty=format:%ad %h %s', '-n', '1', '--', relPath])
  if (commit !== '') return commit.replace(/\s+/g, ' ').trim()
  return 'working tree (uncommitted)'
}

function renderIndex(params: {
  topLevel: string[]
  scripts: string[]
  directorySummary: string[]
  fileMap: string[]
  guidanceScopes: string[]
  changedRecords?: ChangedRecord[]
}): string {
  const lines: string[] = []
  lines.push('# Codebase Index')
  lines.push('')
  lines.push(`Generated at: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('## Top-level')
  lines.push(...(params.topLevel.length > 0 ? params.topLevel.map((x) => `- ${x}`) : ['- (empty)']))
  lines.push('')
  lines.push('## Directory Summary')
  lines.push(
    ...(params.directorySummary.length > 0
      ? params.directorySummary.map((x) => `- ${x}`)
      : ['- (none)'])
  )
  lines.push('')
  lines.push('## Dev Scripts')
  lines.push(...(params.scripts.length > 0 ? params.scripts.map((x) => `- ${x}`) : ['- (none)']))
  lines.push('')
  lines.push('## Guidance Scopes')
  lines.push(...(params.guidanceScopes.length > 0 ? params.guidanceScopes.map((x) => `- ${x}`) : ['- (none)']))
  lines.push('')
  lines.push('## File Map (sample)')
  lines.push(...(params.fileMap.length > 0 ? params.fileMap.map((x) => `- ${formatFileMapLine(x)}`) : ['- (none)']))
  lines.push('')

  if (params.changedRecords && params.changedRecords.length > 0) {
    lines.push('## Recent Changed Files')
    lines.push(...params.changedRecords.map((x) => `- changed: ${x.path} — ${x.note}`))
    lines.push('')
  }

  return lines.join('\n')
}

async function resolveIndexPath(cwd: string): Promise<{ root: string; path: string }> {
  const root = await findProjectRoot(cwd)
  return { root, path: join(root, '.merlion', 'codebase_index.md') }
}

async function buildIndexContent(root: string, changedRecords?: ChangedRecord[]): Promise<string> {
  const entries = await listTopLevelEntries(root)
  const topLevel = renderTopLevel(entries)
  const scripts = await readScripts(root)
  const directorySummary = await summarizeTopLevelDirectories(root, entries)
  const fileMapRoots = pickFileMapRoots(entries)
  const fileMap = await walkFiles(root, fileMapRoots)
  const guidanceScopes = await listGuidanceScopes(root)

  return renderIndex({
    topLevel,
    scripts,
    directorySummary,
    fileMap,
    guidanceScopes,
    changedRecords: changedRecords && changedRecords.length > 0 ? changedRecords : undefined,
  })
}

export async function ensureCodebaseIndex(cwd: string): Promise<CodebaseIndexArtifact> {
  const { root, path } = await resolveIndexPath(cwd)
  if (!(await fileExists(path))) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, await buildIndexContent(root), 'utf8')
  }
  const content = await readFile(path, 'utf8')
  return { path, content }
}

export async function refreshCodebaseIndex(cwd: string): Promise<CodebaseIndexArtifact> {
  const { root, path } = await resolveIndexPath(cwd)
  await mkdir(dirname(path), { recursive: true })
  const existing = (await fileExists(path)) ? await readFile(path, 'utf8') : ''
  const changed = parseChangedRecords(existing)
  const content = await buildIndexContent(root, changed)
  await writeFile(path, content, 'utf8')
  return { path, content }
}

function truncate(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: '', truncated: text.length > 0 }
  const maxChars = maxTokens * 4
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: `${text.slice(0, Math.max(0, maxChars - 44))}\n\n[...codebase_index truncated...]`,
    truncated: true,
  }
}

export async function readCodebaseIndex(
  cwd: string,
  options?: ReadCodebaseIndexOptions
): Promise<{ path: string; text: string; tokensEstimate: number; truncated: boolean }> {
  const artifact = await ensureCodebaseIndex(cwd)
  const clipped = truncate(artifact.content, options?.maxTokens ?? 400)
  return {
    path: artifact.path,
    text: clipped.text,
    tokensEstimate: estimateTokens(clipped.text),
    truncated: clipped.truncated,
  }
}

export async function updateCodebaseIndexWithChangedFiles(
  cwd: string,
  changedPaths: string[]
): Promise<CodebaseIndexArtifact> {
  const { root, path } = await resolveIndexPath(cwd)
  await mkdir(dirname(path), { recursive: true })
  const existingContent = (await fileExists(path)) ? await readFile(path, 'utf8') : ''
  const existing = parseChangedRecords(existingContent)

  const normalized = changedPaths
    .map((p) => relative(root, resolve(cwd, p)))
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => !p.startsWith('..') && p !== '')

  const notesCache = new Map<string, string>()
  const mergedByPath = new Map<string, ChangedRecord>()

  for (const relPath of normalized) {
    const note = notesCache.get(relPath) ?? latestChangeNote(root, relPath)
    notesCache.set(relPath, note)
    mergedByPath.set(relPath, { path: relPath, note })
  }

  for (const item of existing) {
    if (!mergedByPath.has(item.path)) {
      mergedByPath.set(item.path, item)
    }
    if (mergedByPath.size >= MAX_CHANGED_FILES) break
  }

  const merged = [...mergedByPath.values()].slice(0, MAX_CHANGED_FILES)
  const updated = await buildIndexContent(root, merged)
  await writeFile(path, updated, 'utf8')
  return { path, content: updated }
}
