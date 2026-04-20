import { readFile } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileExists, findProjectRoot } from './project_root.ts'

export interface AgentsGuidance {
  text: string
  files: string[]
  tokensEstimate: number
  truncated: boolean
}

export interface LoadAgentsGuidanceOptions {
  maxTokens?: number
  includeMajorScopes?: boolean
  maxMajorScopes?: number
}

export const GUIDANCE_FILENAMES = ['MERLION.md', 'AGENTS.md'] as const

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}


function ancestorsFromRoot(projectRoot: string, cwd: string): string[] {
  const root = resolve(projectRoot)
  const target = resolve(cwd)
  if (!target.startsWith(root)) {
    return [root]
  }

  const rel = relative(root, target)
  if (rel === '') return [root]

  const segments = rel.split(sep).filter(Boolean)
  const paths = [root]
  let cursor = root
  for (const segment of segments) {
    cursor = join(cursor, segment)
    paths.push(cursor)
  }
  return paths
}

function generatedGuidancePathForDirectory(
  projectRoot: string,
  directory: string,
  filename: string
): string {
  const rel = relative(projectRoot, directory)
  if (rel === '') return join(projectRoot, '.merlion', 'maps', filename)
  return join(projectRoot, '.merlion', 'maps', rel, filename)
}

export interface ResolvedAgentsGuidanceFile {
  path: string
  source: 'project' | 'generated'
}

export async function resolveAgentsGuidanceFileForDirectory(
  projectRoot: string,
  directory: string
): Promise<ResolvedAgentsGuidanceFile | null> {
  for (const filename of GUIDANCE_FILENAMES) {
    const realPath = join(directory, filename)
    if (await fileExists(realPath)) {
      return { path: realPath, source: 'project' }
    }
  }

  for (const filename of GUIDANCE_FILENAMES) {
    const generatedPath = generatedGuidancePathForDirectory(projectRoot, directory, filename)
    if (await fileExists(generatedPath)) {
      return { path: generatedPath, source: 'generated' }
    }
  }

  return null
}

async function listMajorScopeDirectories(
  projectRoot: string,
  maxMajorScopes: number
): Promise<string[]> {
  if (maxMajorScopes <= 0) return []
  const preferred = ['src', 'app', 'packages', 'services', 'lib', 'libs', 'docs', 'tests']
  const out: string[] = []
  for (const name of preferred) {
    const candidate = join(projectRoot, name)
    if (!(await fileExists(candidate))) continue
    if (!out.includes(candidate)) out.push(candidate)
    if (out.length >= maxMajorScopes) break
  }
  return out
}

function truncateByTokenBudget(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: '', truncated: text.length > 0 }
  const maxChars = maxTokens * 4
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: `${text.slice(0, Math.max(0, maxChars - 48))}\n\n[...AGENTS guidance truncated by budget...]`,
    truncated: true,
  }
}

export async function loadAgentsGuidance(
  cwd: string,
  options?: LoadAgentsGuidanceOptions
): Promise<AgentsGuidance> {
  const maxTokens = options?.maxTokens ?? 500
  const includeMajorScopes = options?.includeMajorScopes === true
  const maxMajorScopes = Math.max(0, Math.floor(options?.maxMajorScopes ?? 4))
  const projectRoot = await findProjectRoot(cwd)
  const searchDirs = ancestorsFromRoot(projectRoot, cwd)
  if (includeMajorScopes) {
    for (const dir of await listMajorScopeDirectories(projectRoot, maxMajorScopes)) {
      if (!searchDirs.includes(dir)) searchDirs.push(dir)
    }
  }

  const files: string[] = []
  const blocks: string[] = []
  for (const dir of searchDirs) {
    const resolved = await resolveAgentsGuidanceFileForDirectory(projectRoot, dir)
    if (!resolved) continue
    const content = await readFile(resolved.path, 'utf8')
    files.push(resolved.path)
    const relDir = relative(projectRoot, dir).replace(/\\/g, '/')
    const filename = basename(resolved.path)
    const rel = relDir === '' ? filename : `${relDir}/${filename}`
    const sourceLabel = resolved.source === 'generated' ? ' (generated map)' : ''
    blocks.push(`## ${rel}${sourceLabel}\n${content.trim()}`)
  }

  const merged = blocks.join('\n\n')
  const clipped = truncateByTokenBudget(merged, maxTokens)

  return {
    text: clipped.text,
    files,
    tokensEstimate: estimateTokens(clipped.text),
    truncated: clipped.truncated
  }
}
