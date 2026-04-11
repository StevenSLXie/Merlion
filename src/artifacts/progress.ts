import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, resolve } from 'node:path'

export interface ProgressArtifact {
  path: string
  content: string
}

export interface ProgressUpdatePatch {
  objective?: string
  done?: string[]
  next?: string[]
  blockers?: string[]
  decisions?: string[]
}

export interface ReadProgressOptions {
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
    if (await fileExists(join(cursor, '.git'))) return cursor
    const parent = resolve(cursor, '..')
    if (parent === cursor) return resolve(startCwd)
    cursor = parent
  }
}

function sectionLines(items?: string[]): string[] {
  const cleaned = (items ?? []).map((item) => item.trim()).filter((item) => item !== '')
  if (cleaned.length === 0) return ['- (none)']
  return cleaned.map((item) => `- ${item}`)
}

function renderTemplate(objective?: string): string {
  return [
    '# Merlion Progress',
    '',
    '## Objective',
    objective && objective.trim() !== '' ? objective.trim() : '(not set)',
    '',
    '## Done',
    ...sectionLines(),
    '',
    '## Next',
    ...sectionLines(),
    '',
    '## Blockers',
    ...sectionLines(),
    '',
    '## Decisions',
    ...sectionLines(),
    '',
  ].join('\n')
}

function extractSection(content: string, heading: string): string[] {
  const marker = `## ${heading}`
  const start = content.indexOf(marker)
  if (start === -1) return []
  const afterStart = content.slice(start + marker.length)
  const nextHeadingPos = afterStart.indexOf('\n## ')
  const block = nextHeadingPos === -1 ? afterStart : afterStart.slice(0, nextHeadingPos)
  return block
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line !== '' && line !== '(none)')
}

function extractObjective(content: string): string {
  const marker = '## Objective'
  const start = content.indexOf(marker)
  if (start === -1) return '(not set)'
  const afterStart = content.slice(start + marker.length)
  const nextHeadingPos = afterStart.indexOf('\n## ')
  const block = (nextHeadingPos === -1 ? afterStart : afterStart.slice(0, nextHeadingPos)).trim()
  return block === '' ? '(not set)' : block
}

function mergeSection(existing: string[], incoming?: string[]): string[] {
  if (!incoming || incoming.length === 0) return existing
  const merged = [...existing]
  for (const item of incoming.map((s) => s.trim()).filter(Boolean)) {
    if (!merged.includes(item)) merged.push(item)
  }
  return merged
}

function truncate(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: '', truncated: text.length > 0 }
  const maxChars = maxTokens * 4
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: `${text.slice(0, Math.max(0, maxChars - 44))}\n\n[...progress truncated...]`,
    truncated: true,
  }
}

async function resolveProgressPath(cwd: string): Promise<string> {
  const root = await findProjectRoot(cwd)
  return join(root, '.merlion', 'progress.md')
}

export async function ensureProgressArtifact(
  cwd: string,
  initialObjective?: string
): Promise<ProgressArtifact> {
  const path = await resolveProgressPath(cwd)
  await mkdir(join(path, '..'), { recursive: true })
  if (!(await fileExists(path))) {
    await writeFile(path, renderTemplate(initialObjective), 'utf8')
  }
  const content = await readFile(path, 'utf8')
  return { path, content }
}

export async function readProgressArtifact(
  cwd: string,
  options?: ReadProgressOptions
): Promise<{ path: string; text: string; tokensEstimate: number; truncated: boolean }> {
  const { path, content } = await ensureProgressArtifact(cwd)
  const clipped = truncate(content, options?.maxTokens ?? 300)
  return {
    path,
    text: clipped.text,
    tokensEstimate: estimateTokens(clipped.text),
    truncated: clipped.truncated,
  }
}

export async function updateProgressArtifact(
  cwd: string,
  patch: ProgressUpdatePatch
): Promise<ProgressArtifact> {
  const { path, content } = await ensureProgressArtifact(cwd)
  const objective = patch.objective?.trim() || extractObjective(content)
  const done = mergeSection(extractSection(content, 'Done'), patch.done)
  const next = mergeSection(extractSection(content, 'Next'), patch.next)
  const blockers = mergeSection(extractSection(content, 'Blockers'), patch.blockers)
  const decisions = mergeSection(extractSection(content, 'Decisions'), patch.decisions)

  const updated = [
    '# Merlion Progress',
    '',
    '## Objective',
    objective || '(not set)',
    '',
    '## Done',
    ...sectionLines(done),
    '',
    '## Next',
    ...sectionLines(next),
    '',
    '## Blockers',
    ...sectionLines(blockers),
    '',
    '## Decisions',
    ...sectionLines(decisions),
    '',
  ].join('\n')

  await writeFile(path, updated, 'utf8')
  return { path, content: updated }
}
