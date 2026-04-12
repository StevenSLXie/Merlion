import { readFile, writeFile, access, readdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { execSync } from 'node:child_process'

import {
  renderAgentsAutoSection,
  upsertAgentsAutoSection,
  type RecentCommit,
} from '../../src/artifacts/agents_auto.ts'

interface Args {
  staged: boolean
  all: boolean
  check: boolean
  files: string[]
}

function parseArgs(argv: string[]): Args {
  const out: Args = { staged: false, all: false, check: false, files: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--staged') out.staged = true
    else if (arg === '--all') out.all = true
    else if (arg === '--check') out.check = true
    else if (arg === '--files') {
      const raw = argv[i + 1] ?? ''
      i += 1
      out.files.push(...raw.split(',').map((x) => x.trim()).filter(Boolean))
    }
  }
  return out
}

function runGit(cwd: string, command: string): string {
  return execSync(command, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim()
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function listAgentsFiles(root: string): Promise<string[]> {
  const result: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile() && entry.name === 'AGENTS.md') {
        result.push(full)
      }
    }
  }
  await walk(root)
  return result
}

function ancestors(pathRel: string): string[] {
  const clean = pathRel.replace(/\\/g, '/')
  const parts = clean.split('/').filter(Boolean)
  const dirs = new Set<string>(['.'])
  if (parts.length <= 1) return [...dirs]

  let cursor = '.'
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]!
    cursor = cursor === '.' ? part : `${cursor}/${part}`
    dirs.add(cursor)
  }
  return [...dirs]
}

function parseRecentCommits(text: string): RecentCommit[] {
  if (text.trim() === '') return []
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [hash, date, ...subjectParts] = line.split('|')
      return {
        hash: hash ?? '',
        date: date ?? '',
        subject: subjectParts.join('|') || '(no subject)'
      }
    })
    .filter((x) => x.hash !== '' && x.date !== '')
}

function uniqueLines(lines: string[], max: number): string[] {
  const out: string[] = []
  for (const line of lines.map((x) => x.trim()).filter(Boolean)) {
    if (!out.includes(line)) out.push(line)
    if (out.length >= max) break
  }
  return out
}

function countTop(lines: string[], max: number): string[] {
  const counts = new Map<string, number>()
  for (const line of lines.map((x) => x.trim()).filter(Boolean)) {
    counts.set(line, (counts.get(line) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([path, n]) => `${path} (changes=${n})`)
}

async function collectTargetAgentFiles(root: string, args: Args): Promise<string[]> {
  if (args.all) return listAgentsFiles(root)

  let changedFiles: string[] = []
  if (args.files.length > 0) {
    changedFiles = args.files
  } else if (args.staged) {
    const out = runGit(root, 'git diff --cached --name-only --diff-filter=ACMR')
    changedFiles = out.split('\n').map((x) => x.trim()).filter(Boolean)
  } else {
    const out = runGit(root, 'git diff --name-only --diff-filter=ACMR')
    changedFiles = out.split('\n').map((x) => x.trim()).filter(Boolean)
  }

  const targets = new Set<string>()
  for (const file of changedFiles) {
    for (const ancestor of ancestors(file)) {
      const candidate = resolve(root, ancestor, 'AGENTS.md')
      if (await exists(candidate)) targets.add(candidate)
    }
  }

  return [...targets]
}

async function updateOne(root: string, agentsPath: string): Promise<boolean> {
  const absolute = resolve(agentsPath)
  const dir = dirname(absolute)
  const relDir = relative(root, dir).replace(/\\/g, '/') || '.'

  const recentCommitsRaw = runGit(
    root,
    relDir === '.'
      ? 'git log --date=short --pretty=format:%h%x7C%ad%x7C%s -n 5'
      : `git log --date=short --pretty=format:%h%x7C%ad%x7C%s -n 5 -- ${JSON.stringify(relDir)}`
  )
  const changedRaw = runGit(
    root,
    relDir === '.'
      ? 'git log --name-only --pretty=format: -n 25'
      : `git log --name-only --pretty=format: -n 25 -- ${JSON.stringify(relDir)}`
  )
  const churnRaw = runGit(
    root,
    relDir === '.'
      ? 'git log --name-only --pretty=format: --since=180.days'
      : `git log --name-only --pretty=format: --since=180.days -- ${JSON.stringify(relDir)}`
  )

  const recentCommits = parseRecentCommits(recentCommitsRaw)
  const recentChangedFiles = uniqueLines(changedRaw.split('\n'), 8)
  const highChurnFiles = countTop(churnRaw.split('\n'), 6)

  const current = await readFile(absolute, 'utf8')
  const autoBlock = renderAgentsAutoSection({
    generatedAt: recentCommits[0]?.date ?? new Date().toISOString().slice(0, 10),
    directory: relDir,
    recentCommits,
    recentChangedFiles,
    highChurnFiles,
  })
  const next = upsertAgentsAutoSection(current, autoBlock)

  if (next === current) return false
  await writeFile(absolute, next, 'utf8')
  return true
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const root = runGit(process.cwd(), 'git rev-parse --show-toplevel')
  const targets = await collectTargetAgentFiles(root, args)

  if (targets.length === 0) {
    process.stdout.write('[agents] no AGENTS.md targets found\n')
    return
  }

  let changed = 0
  const dirtyTargets: string[] = []

  for (const target of targets.sort()) {
    const before = await readFile(target, 'utf8')
    const updated = await updateOne(root, target)
    if (!updated) continue
    changed += 1
    dirtyTargets.push(target)
    if (args.check) {
      // restore file to avoid modifying workspace during check mode
      await writeFile(target, before, 'utf8')
    }
  }

  if (args.check) {
    if (changed > 0) {
      process.stderr.write('[agents] drift detected in AUTO sections:\n')
      for (const target of dirtyTargets) {
        process.stderr.write(`- ${relative(root, target)}\n`)
      }
      process.exitCode = 1
      return
    }
    process.stdout.write('[agents] AUTO sections are up to date\n')
    return
  }

  process.stdout.write(`[agents] updated ${changed}/${targets.length} AGENTS.md files\n`)
  for (const target of dirtyTargets) {
    process.stdout.write(`- ${relative(root, target)}\n`)
  }
}

main().catch((error) => {
  process.stderr.write(`[agents] update failed: ${String(error)}\n`)
  process.exitCode = 1
})
