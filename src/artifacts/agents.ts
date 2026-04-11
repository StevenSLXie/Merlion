import { access, readFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { constants } from 'node:fs'

export interface AgentsGuidance {
  text: string
  files: string[]
  tokensEstimate: number
  truncated: boolean
}

export interface LoadAgentsGuidanceOptions {
  maxTokens?: number
}

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
    const gitPath = join(cursor, '.git')
    if (await fileExists(gitPath)) return cursor
    const parent = resolve(cursor, '..')
    if (parent === cursor) return resolve(startCwd)
    cursor = parent
  }
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
  const projectRoot = await findProjectRoot(cwd)
  const searchDirs = ancestorsFromRoot(projectRoot, cwd)

  const files: string[] = []
  const blocks: string[] = []
  for (const dir of searchDirs) {
    const path = join(dir, 'AGENTS.md')
    if (!(await fileExists(path))) continue
    const content = await readFile(path, 'utf8')
    files.push(path)
    const rel = relative(projectRoot, path) || 'AGENTS.md'
    blocks.push(`## ${rel}\n${content.trim()}`)
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
