import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'merlion-agents-script-'))
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
      '- root guidance',
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
  await writeFile(join(root, 'src', 'runtime', 'loop.ts'), 'export const x = 1\n', 'utf8')

  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'seed runtime map'], { cwd: root })
  return root
}

test('agents update script writes recent commit/date and lint passes', async () => {
  const repo = await makeRepo()
  const updateScript = new URL('../scripts/agents/update.ts', import.meta.url)
  const lintScript = new URL('../scripts/agents/lint.ts', import.meta.url)

  execFileSync('node', ['--experimental-strip-types', updateScript.pathname, '--all'], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  const content = await readFile(join(repo, 'AGENTS.md'), 'utf8')
  assert.match(content, /## RecentCommits/)
  assert.match(content, /seed runtime map/)
  assert.match(content, /## LastUpdated/)

  execFileSync('node', ['--experimental-strip-types', lintScript.pathname], {
    cwd: repo,
    stdio: ['ignore', 'pipe', 'pipe']
  })
})
