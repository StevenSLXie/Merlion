/**
 * Integration E2E: AGENTS AUTO maintenance scripts (no LLM required).
 *
 * Verifies:
 * 1) update script writes RecentCommits + LastUpdated (date-based, deterministic).
 * 2) lint script passes after update.
 * 3) check-drift passes immediately after update.
 */
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'merlion-e2e-agents-auto-'))

  execFileSync('git', ['init'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Merlion Test'], { cwd: root })

  await mkdir(join(root, 'src', 'runtime'), { recursive: true })
  await writeFile(
    join(root, 'AGENTS.md'),
    [
      '# AGENTS Guidance',
      '',
      '<!-- BEGIN MANUAL -->',
      '## Purpose',
      '- root scope',
      '<!-- END MANUAL -->',
      '',
      '<!-- BEGIN AUTO -->',
      '## LastUpdated',
      '- (never)',
      '<!-- END AUTO -->',
      ''
    ].join('\n'),
    'utf8'
  )

  await writeFile(join(root, 'src', 'runtime', 'loop.ts'), 'export const v = 1\n', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'seed agents e2e'], { cwd: root })

  await writeFile(join(root, 'src', 'runtime', 'loop.ts'), 'export const v = 2\n', 'utf8')
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'runtime tweak'], { cwd: root })

  return root
}

test('agents scripts update/lint/check-drift lifecycle', async () => {
  const repo = await makeRepo()
  const updateScript = new URL('../../scripts/agents/update.ts', import.meta.url)
  const lintScript = new URL('../../scripts/agents/lint.ts', import.meta.url)

  execFileSync('node', ['--experimental-strip-types', updateScript.pathname, '--all'], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const content = await readFile(join(repo, 'AGENTS.md'), 'utf8')
  assert.match(content, /## RecentCommits/)
  assert.match(content, /runtime tweak|seed agents e2e/)
  assert.match(content, /## LastUpdated/)
  assert.match(content, /- \d{4}-\d{2}-\d{2}/)

  execFileSync('node', ['--experimental-strip-types', lintScript.pathname], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  execFileSync('node', ['--experimental-strip-types', updateScript.pathname, '--all', '--check'], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe']
  })
})
