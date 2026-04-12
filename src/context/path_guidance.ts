import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { findProjectRoot, resolveAgentsGuidanceFileForDirectory } from '../artifacts/agents.ts'

export interface PathGuidanceState {
  loadedAgentFiles: Set<string>
}

export interface PathGuidanceOptions {
  totalTokens?: number
  perFileTokens?: number
  maxFiles?: number
}

export interface PathGuidanceDelta {
  text: string
  loadedFiles: string[]
  truncated: boolean
}

export interface PathSignalToolEvent {
  call: {
    function: {
      arguments: string
    }
  }
  message?: {
    content?: string | null
  }
}

const PATH_ARG_KEYS = new Set([
  'path',
  'file',
  'file_path',
  'from',
  'to',
  'cwd',
  'dir',
  'directory',
  'target',
  'root',
])

const DEFAULT_OPTIONS: Required<PathGuidanceOptions> = {
  totalTokens: 700,
  perFileTokens: 220,
  maxFiles: 4,
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function truncateToTokens(text: string, maxTokens: number, marker: string): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: '', truncated: text.length > 0 }
  const maxChars = maxTokens * 4
  if (text.length <= maxChars) return { text, truncated: false }
  const markerText = `\n\n${marker}`
  const keep = Math.max(0, maxChars - markerText.length)
  return {
    text: `${text.slice(0, keep)}${markerText}`,
    truncated: true,
  }
}

function looksPathLike(value: string): boolean {
  if (value.trim() === '') return false
  if (/^https?:\/\//i.test(value)) return false
  if (value.includes('..') || value.startsWith('./') || value.startsWith('../') || value.startsWith('/') || value.startsWith('~')) return true
  return value.includes('/')
}

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function normalizePathCandidate(raw: string, cwd: string, root: string): string | null {
  const value = raw.trim()
  if (!looksPathLike(value)) return null
  if (value.startsWith('~')) return null
  const resolved = value.startsWith('/') ? resolve(value) : resolve(cwd, value)
  if (!isWithinRoot(root, resolved)) return null
  return resolved
}

function walkJsonPaths(value: unknown, cwd: string, root: string, out: Set<string>, keyHint?: string): void {
  if (typeof value === 'string') {
    if (keyHint && !PATH_ARG_KEYS.has(keyHint)) return
    const normalized = normalizePathCandidate(value, cwd, root)
    if (normalized) out.add(normalized)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walkJsonPaths(item, cwd, root, out, keyHint)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      walkJsonPaths(item, cwd, root, out, key)
    }
  }
}

function extractPathsFromMessageContent(content: string, cwd: string, root: string, out: Set<string>): void {
  const regex = /(?:\.{1,2}\/|\/)[^\s'"`]+/g
  const matches = content.match(regex)
  if (!matches) return
  for (const match of matches) {
    const normalized = normalizePathCandidate(match, cwd, root)
    if (normalized) out.add(normalized)
  }
}

function directoryChainFromRoot(root: string, targetDir: string): string[] {
  const chain: string[] = []
  let cursor = resolve(targetDir)
  if (!isWithinRoot(root, cursor)) return chain
  for (;;) {
    chain.push(cursor)
    if (cursor === root) break
    const parent = resolve(cursor, '..')
    if (!isWithinRoot(root, parent) || parent === cursor) break
    cursor = parent
  }
  chain.reverse()
  return chain
}

function logicalGuidancePath(root: string, directory: string, absoluteGuidancePath: string): string {
  const relDir = relative(root, directory).replace(/\\/g, '/')
  const filename = basename(absoluteGuidancePath)
  return relDir === '' ? filename : `${relDir}/${filename}`
}

export function createPathGuidanceState(initialAgentFiles?: string[]): PathGuidanceState {
  return {
    loadedAgentFiles: new Set((initialAgentFiles ?? []).map((x) => resolve(x)))
  }
}

export async function extractCandidatePathsFromToolEvent(
  cwd: string,
  event: PathSignalToolEvent
): Promise<string[]> {
  const root = await findProjectRoot(cwd)
  const out = new Set<string>()

  const rawArgs = event.call.function.arguments
  try {
    const parsed = JSON.parse(rawArgs) as unknown
    walkJsonPaths(parsed, cwd, root, out)
  } catch {
    // Ignore malformed tool arguments.
  }

  const content = event.message?.content
  if (typeof content === 'string' && content.trim() !== '') {
    extractPathsFromMessageContent(content, cwd, root, out)
  }

  return [...out]
}

export async function buildPathGuidanceDelta(
  cwd: string,
  candidatePaths: string[],
  state: PathGuidanceState,
  options?: PathGuidanceOptions,
): Promise<PathGuidanceDelta> {
  const root = await findProjectRoot(cwd)
  const merged: Required<PathGuidanceOptions> = {
    totalTokens: Math.max(0, Math.floor(options?.totalTokens ?? DEFAULT_OPTIONS.totalTokens)),
    perFileTokens: Math.max(0, Math.floor(options?.perFileTokens ?? DEFAULT_OPTIONS.perFileTokens)),
    maxFiles: Math.max(0, Math.floor(options?.maxFiles ?? DEFAULT_OPTIONS.maxFiles)),
  }

  const targetDirs: string[] = []
  for (const path of candidatePaths) {
    const normalized = normalizePathCandidate(path, cwd, root)
    if (!normalized) continue
    const dir = normalized.split('/').pop()?.includes('.') ? dirname(normalized) : normalized
    const resolvedDir = resolve(dir)
    if (!isWithinRoot(root, resolvedDir)) continue
    if (!targetDirs.includes(resolvedDir)) targetDirs.push(resolvedDir)
  }

  const orderedChains: string[] = []
  for (const dir of targetDirs) {
    for (const candidateDir of directoryChainFromRoot(root, dir)) {
      if (!orderedChains.includes(candidateDir)) orderedChains.push(candidateDir)
    }
  }

  const sections: string[] = []
  const loadedFiles: string[] = []
  let usedTokens = 0
  let truncated = false

  for (const dir of orderedChains) {
    if (loadedFiles.length >= merged.maxFiles) {
      truncated = true
      break
    }

    const resolvedGuidance = await resolveAgentsGuidanceFileForDirectory(root, dir)
    if (!resolvedGuidance) continue
    const normalizedAgentsPath = resolve(resolvedGuidance.path)
    if (state.loadedAgentFiles.has(normalizedAgentsPath)) continue

    const raw = await readFile(resolvedGuidance.path, 'utf8')
    const clipped = truncateToTokens(raw.trim(), merged.perFileTokens, '[...AGENTS path section truncated...]')
    const rel = logicalGuidancePath(root, dir, normalizedAgentsPath)
    const sourceLabel = resolvedGuidance.source === 'generated' ? ' (generated map)' : ''
    const block = `## ${rel}${sourceLabel}\n${clipped.text}`

    const blockTokens = estimateTokens(block)
    if (usedTokens + blockTokens > merged.totalTokens) {
      const remaining = Math.max(0, merged.totalTokens - usedTokens)
      if (remaining <= 0) {
        truncated = true
        break
      }
      const clippedBlock = truncateToTokens(block, remaining, '[...path guidance budget exhausted...]')
      if (clippedBlock.text.trim() !== '') {
        sections.push(clippedBlock.text)
      }
      usedTokens += estimateTokens(clippedBlock.text)
      loadedFiles.push(rel)
      state.loadedAgentFiles.add(normalizedAgentsPath)
      truncated = true
      break
    }

    sections.push(block)
    usedTokens += blockTokens
    loadedFiles.push(rel)
    state.loadedAgentFiles.add(normalizedAgentsPath)
    if (clipped.truncated) truncated = true
  }

  return {
    text: sections.join('\n\n').trim(),
    loadedFiles,
    truncated,
  }
}
