import { execSync } from 'node:child_process'

function parseToolArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

export function extractChangedPathsFromToolCall(toolName: string, rawArgs: string): string[] {
  const args = parseToolArgs(rawArgs)
  const out: string[] = []
  const push = (value: unknown) => {
    const path = nonEmptyString(value)
    if (path) out.push(path)
  }

  if (
    toolName === 'create_file' ||
    toolName === 'write_file' ||
    toolName === 'append_file' ||
    toolName === 'edit_file' ||
    toolName === 'delete_file' ||
    toolName === 'mkdir'
  ) {
    push(args.path ?? args.file_path)
  } else if (toolName === 'copy_file') {
    push(args.to_path ?? args.path)
  } else if (toolName === 'move_file') {
    push(args.from_path)
    push(args.to_path)
  }

  return out
}

function decodePorcelainPath(value: string): string {
  const text = value.trim()
  if (!text.startsWith('"')) return text
  try {
    return JSON.parse(text) as string
  } catch {
    return text.slice(1, text.endsWith('"') ? -1 : undefined)
  }
}

export function collectGitWorkingTreePaths(cwd: string): string[] {
  try {
    const output = execSync('git status --porcelain', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim()
    if (output === '') return []

    const out: string[] = []
    for (const line of output.split('\n')) {
      if (line.length < 4) continue
      const payload = line.slice(3).trim()
      const arrow = payload.lastIndexOf(' -> ')
      const target = arrow >= 0 ? payload.slice(arrow + 4) : payload
      const normalized = decodePorcelainPath(target).replace(/\\/g, '/')
      if (normalized !== '') out.push(normalized)
      if (out.length >= 120) break
    }
    return out
  } catch {
    return []
  }
}

export function collectLatestCommitPaths(cwd: string): string[] {
  try {
    const output = execSync('git show --name-only --pretty=format: --diff-filter=ACMR --no-renames -n 1 HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim()
    if (output === '') return []
    const out: string[] = []
    for (const raw of output.split('\n')) {
      const normalized = decodePorcelainPath(raw).replace(/\\/g, '/').trim()
      if (normalized === '' || normalized.startsWith('..')) continue
      if (!out.includes(normalized)) out.push(normalized)
      if (out.length >= 80) break
    }
    return out
  } catch {
    return []
  }
}
