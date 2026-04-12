import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

import { validateAgentsSections, AUTO_BEGIN, AUTO_END } from '../../src/artifacts/agents_auto.ts'

function gitRoot(cwd: string): string {
  return execSync('git rev-parse --show-toplevel', { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim()
}

async function listAgents(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile() && entry.name === 'AGENTS.md') out.push(full)
    }
  }
  await walk(root)
  return out
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function getAutoSection(content: string): string {
  const begin = content.indexOf(AUTO_BEGIN)
  const end = content.indexOf(AUTO_END)
  if (begin === -1 || end === -1 || end < begin) return ''
  return content.slice(begin, end + AUTO_END.length)
}

async function main(): Promise<void> {
  const root = gitRoot(process.cwd())
  const files = await listAgents(root)
  const failures: string[] = []
  const perFileBudget = Math.max(80, Number(process.env.MERLION_AGENTS_MAX_TOKENS ?? 1200))

  for (const file of files) {
    const content = await readFile(file, 'utf8')
    const section = validateAgentsSections(content)
    const rel = file.slice(root.length + 1)
    if (!section.ok) {
      failures.push(`${rel}: ${section.reason}`)
      continue
    }

    const auto = getAutoSection(content)
    if (!auto.includes('## RecentCommits')) {
      failures.push(`${rel}: AUTO section must include ## RecentCommits`)
    }
    if (!auto.includes('## LastUpdated')) {
      failures.push(`${rel}: AUTO section must include ## LastUpdated`)
    }

    const tokens = estimateTokens(content)
    if (tokens > perFileBudget) {
      failures.push(`${rel}: estimated ${tokens} tokens > budget ${perFileBudget}`)
    }
  }

  if (failures.length > 0) {
    process.stderr.write('[agents] lint failed:\n')
    for (const failure of failures) process.stderr.write(`- ${failure}\n`)
    process.exitCode = 1
    return
  }

  process.stdout.write(`[agents] lint ok (${files.length} files)\n`)
}

main().catch((error) => {
  process.stderr.write(`[agents] lint failed: ${String(error)}\n`)
  process.exitCode = 1
})
