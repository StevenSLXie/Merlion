import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
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

test('discoverVerificationChecks discovers python/java/make checks', async () => {
  const dir = await makeDir()
  await writeFile(join(dir, 'pyproject.toml'), '[tool.mypy]\nfiles = ["."]\n', 'utf8')
  await mkdir(join(dir, 'tests'))
  await writeFile(join(dir, 'tests', 'test_sample.py'), 'def test_ok():\n  assert 1 == 1\n', 'utf8')
  await writeFile(join(dir, 'pom.xml'), '<project></project>\n', 'utf8')
  await writeFile(join(dir, 'Makefile'), 'test:\n\t@echo ok\n', 'utf8')

  const checks = await discoverVerificationChecks(dir)
  const ids = checks.map((c) => c.id)
  assert.ok(ids.includes('python_test'))
  assert.ok(ids.includes('python_typecheck'))
  assert.ok(ids.includes('java_test_maven'))
  assert.ok(ids.includes('make_test'))
  assert.deepEqual(checks.find((c) => c.id === 'python_test')?.requiresCommands, ['python'])
  assert.deepEqual(checks.find((c) => c.id === 'java_test_maven')?.requiresCommands, ['mvn'])
})

test('discoverVerificationChecks prefers custom verify config when present', async () => {
  const dir = await makeDir()
  await mkdir(join(dir, '.merlion'))
  await writeFile(
    join(dir, '.merlion', 'verify.json'),
    JSON.stringify(
      {
        checks: [
          {
            id: 'custom_go',
            name: 'Go Test',
            command: 'go test ./...',
            requiresCommands: ['go']
          }
        ]
      },
      null,
      2
    ),
    'utf8'
  )
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8')

  const checks = await discoverVerificationChecks(dir)
  assert.equal(checks.length, 1)
  assert.equal(checks[0]?.id, 'custom_go')
  assert.equal(checks[0]?.command, 'go test ./...')
})

test('discoverVerificationChecks detects gradle wrapper', async () => {
  const dir = await makeDir()
  const gradlew = join(dir, 'gradlew')
  await writeFile(gradlew, '#!/usr/bin/env bash\necho ok\n', 'utf8')
  await chmod(gradlew, 0o755)
  await writeFile(join(dir, 'build.gradle.kts'), 'plugins {}\n', 'utf8')

  const checks = await discoverVerificationChecks(dir)
  const gradle = checks.find((c) => c.id === 'java_test_gradle')
  assert.equal(gradle?.command, './gradlew test --console=plain')
  assert.equal(gradle?.requiresCommands, undefined)
})
