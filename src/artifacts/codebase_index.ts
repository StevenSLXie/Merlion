import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export interface CodebaseIndexArtifact {
  path: string
  content: string
}

export interface ReadCodebaseIndexOptions {
  maxTokens?: number
}

const MAX_FILE_MAP_LINES = 80
const MAX_CHANGED_FILES = 50
const IGNORE_DIRS = new Set(['.git', 'node_modules', '.merlion', 'dist', 'build', '.next'])

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

async function listTopLevel(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const rows = entries
    .filter((entry) => !IGNORE_DIRS.has(entry.name))
    .map((entry) => `${entry.isDirectory() ? '[dir]' : '[file]'} ${entry.name}`)
    .sort()
  return rows
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
      result.push(relative(root, full))
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

function renderIndex(params: {
  topLevel: string[]
  scripts: string[]
  fileMap: string[]
  changedFiles?: string[]
}): string {
  const lines: string[] = []
  lines.push('# Codebase Index')
  lines.push('')
  lines.push(`Generated at: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('## Top-level')
  lines.push(...(params.topLevel.length > 0 ? params.topLevel.map((x) => `- ${x}`) : ['- (empty)']))
  lines.push('')
  lines.push('## Dev Scripts')
  lines.push(...(params.scripts.length > 0 ? params.scripts.map((x) => `- ${x}`) : ['- (none)']))
  lines.push('')
  lines.push('## File Map (sample)')
  lines.push(...(params.fileMap.length > 0 ? params.fileMap.map((x) => `- ${x}`) : ['- (none)']))
  lines.push('')

  if (params.changedFiles && params.changedFiles.length > 0) {
    lines.push('## Recent Changed Files')
    lines.push(...params.changedFiles.map((x) => `- changed: ${x}`))
    lines.push('')
  }

  return lines.join('\n')
}

async function resolveIndexPath(cwd: string): Promise<{ root: string; path: string }> {
  const root = await findProjectRoot(cwd)
  return { root, path: join(root, '.merlion', 'codebase_index.md') }
}

export async function ensureCodebaseIndex(cwd: string): Promise<CodebaseIndexArtifact> {
  const { root, path } = await resolveIndexPath(cwd)
  if (!(await fileExists(path))) {
    await mkdir(dirname(path), { recursive: true })
    const topLevel = await listTopLevel(root)
    const scripts = await readScripts(root)
    const fileMap = await walkFiles(root, ['src', 'tests', 'docs'])
    await writeFile(path, renderIndex({ topLevel, scripts, fileMap }), 'utf8')
  }
  const content = await readFile(path, 'utf8')
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

function parseChangedFiles(content: string): string[] {
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
    .filter(Boolean)
}

function replaceOrAppendChangedSection(content: string, changedFiles: string[]): string {
  const marker = '## Recent Changed Files'
  const section = [marker, ...changedFiles.map((x) => `- changed: ${x}`), ''].join('\n')
  const start = content.indexOf(marker)
  if (start === -1) {
    return `${content.trimEnd()}\n\n${section}`
  }
  const afterStart = content.slice(start + marker.length)
  const nextHeadingPos = afterStart.indexOf('\n## ')
  const end = nextHeadingPos === -1 ? content.length : start + marker.length + nextHeadingPos + 1
  return `${content.slice(0, start)}${section}${content.slice(end)}`
}

export async function updateCodebaseIndexWithChangedFiles(
  cwd: string,
  changedPaths: string[]
): Promise<CodebaseIndexArtifact> {
  const artifact = await ensureCodebaseIndex(cwd)
  const { root, path } = await resolveIndexPath(cwd)
  const existing = parseChangedFiles(artifact.content)
  const normalized = changedPaths
    .map((p) => relative(root, resolve(cwd, p)))
    .map((p) => p.replace(/\\/g, '/'))
    .filter((p) => !p.startsWith('..') && p !== '')

  const merged: string[] = []
  for (const item of [...normalized, ...existing]) {
    if (!merged.includes(item)) merged.push(item)
    if (merged.length >= MAX_CHANGED_FILES) break
  }

  const updated = replaceOrAppendChangedSection(artifact.content, merged)
  await writeFile(path, updated, 'utf8')
  return { path, content: updated }
}
