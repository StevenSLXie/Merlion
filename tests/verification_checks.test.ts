import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { discoverVerificationChecks } from '../src/verification/checks.ts'

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'merlion-checks-'))
}

test('discoverVerificationChecks returns checks in fixed order', async () => {
  const dir = await makeDir()
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          lint: 'eslint .',
          test: 'node --test',
          typecheck: 'tsc --noEmit',
          'test:e2e': 'node --test tests/e2e/*.test.ts',
        },
      },
      null,
      2
    ),
    'utf8'
  )

  const checks = await discoverVerificationChecks(dir)
  assert.deepEqual(
    checks.map((c) => c.id),
    ['typecheck', 'test', 'test_e2e', 'lint']
  )
  assert.deepEqual(checks.find((c) => c.id === 'test_e2e')?.requiresEnv, ['OPENROUTER_API_KEY'])
})

test('discoverVerificationChecks returns empty when no package scripts', async () => {
  const dir = await makeDir()
  await writeFile(join(dir, 'package.json'), JSON.stringify({}), 'utf8')
  const checks = await discoverVerificationChecks(dir)
  assert.equal(checks.length, 0)
})
