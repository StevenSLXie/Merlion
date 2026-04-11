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
  assert.deepEqual(checks.find((c) => c.id === 'python_test')?.requiresAnyCommands, ['python3', 'python'])
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
  assert.deepEqual(checks[0]?.requiresCommands, ['go'])
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

test('discoverVerificationChecks discovers mainstream ecosystems', async () => {
  const dir = await makeDir()
  await writeFile(join(dir, 'go.mod'), 'module example.com/app\n', 'utf8')
  await writeFile(join(dir, 'Cargo.toml'), '[package]\nname="x"\nversion="0.1.0"\n', 'utf8')
  await writeFile(join(dir, 'app.sln'), 'Microsoft Visual Studio Solution File\n', 'utf8')
  await writeFile(join(dir, 'composer.json'), JSON.stringify({ scripts: { test: 'phpunit' } }), 'utf8')
  await writeFile(join(dir, 'Gemfile'), 'source "https://rubygems.org"\n', 'utf8')
  await mkdir(join(dir, 'spec'))
  await writeFile(join(dir, 'mix.exs'), 'defmodule App.MixProject do end\n', 'utf8')
  await writeFile(join(dir, 'Package.swift'), 'import PackageDescription\n', 'utf8')
  await writeFile(join(dir, 'pubspec.yaml'), 'name: app\nenvironment:\n  sdk: \">=3.0.0 <4.0.0\"\n', 'utf8')

  const checks = await discoverVerificationChecks(dir)
  const ids = new Set(checks.map((c) => c.id))
  assert.ok(ids.has('go_test'))
  assert.ok(ids.has('rust_test'))
  assert.ok(ids.has('dotnet_test'))
  assert.ok(ids.has('php_test'))
  assert.ok(ids.has('ruby_test_rspec'))
  assert.ok(ids.has('elixir_test'))
  assert.ok(ids.has('swift_test'))
  assert.ok(ids.has('dart_test'))
})

test('discoverVerificationChecks uses CI commands as language-agnostic source', async () => {
  const dir = await makeDir()
  await mkdir(join(dir, '.github'))
  await mkdir(join(dir, '.github', 'workflows'))
  await writeFile(
    join(dir, '.github', 'workflows', 'ci.yml'),
    [
      'name: ci',
      'on: [push]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: npm test',
      '      - run: echo "prepare"',
      '      - run: |',
      '          cargo test',
      '          cargo clippy -- -D warnings'
    ].join('\n'),
    'utf8'
  )
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8')

  const checks = await discoverVerificationChecks(dir)
  assert.deepEqual(
    checks.map((c) => c.command),
    ['npm test', 'cargo test && cargo clippy -- -D warnings']
  )
  assert.equal(checks[0]?.id, 'ci_1')
})

test('discoverVerificationChecks treats explicit empty config as disable-all', async () => {
  const dir = await makeDir()
  await mkdir(join(dir, '.merlion'))
  await writeFile(
    join(dir, '.merlion', 'verify.json'),
    JSON.stringify({ checks: [] }, null, 2),
    'utf8'
  )
  await writeFile(join(dir, 'go.mod'), 'module example.com/app\n', 'utf8')
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8')

  const checks = await discoverVerificationChecks(dir)
  assert.deepEqual(checks, [])
})

test('discoverVerificationChecks python checks support python3-only env via any-command dependency', async () => {
  const dir = await makeDir()
  await writeFile(join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\naddopts = \"-q\"\n', 'utf8')
  await mkdir(join(dir, 'tests'))
  await writeFile(join(dir, 'tests', 'test_sample.py'), 'def test_ok():\n  assert 1 == 1\n', 'utf8')

  const checks = await discoverVerificationChecks(dir)
  const py = checks.find((item) => item.id === 'python_test')
  assert.ok(py, 'python_test should be discovered')
  assert.deepEqual(py?.requiresAnyCommands, ['python3', 'python'])
  assert.match(py?.command ?? '', /python3/)
  assert.match(py?.command ?? '', /python -m pytest -q/)
})

test('discoverVerificationChecks uses alternate merlion.verify.json path', async () => {
  const dir = await makeDir()
  await writeFile(
    join(dir, 'merlion.verify.json'),
    JSON.stringify({ checks: [{ id: 'alt_custom', name: 'Alt Custom', command: 'make lint' }] }),
    'utf8'
  )
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8')

  const checks = await discoverVerificationChecks(dir)
  assert.equal(checks.length, 1)
  assert.equal(checks[0]?.id, 'alt_custom')
})

test('discoverVerificationChecks falls through on malformed verify.json', async () => {
  const dir = await makeDir()
  await mkdir(join(dir, '.merlion'))
  await writeFile(join(dir, '.merlion', 'verify.json'), '{not valid json', 'utf8')
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8')

  const checks = await discoverVerificationChecks(dir)
  // Malformed JSON should not crash — falls through to auto-discovery
  assert.ok(checks.some((c) => c.id === 'test'), 'Should fall through to node discovery')
})

test('discoverVerificationChecks detects bun.lock (not only bun.lockb)', async () => {
  const dir = await makeDir()
  await writeFile(join(dir, 'bun.lock'), '', 'utf8')
  await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }), 'utf8')

  const checks = await discoverVerificationChecks(dir)
  const testCheck = checks.find((c) => c.id === 'test')
  assert.ok(testCheck, 'Should discover test check')
  assert.match(testCheck!.command, /^bun run /, 'Should use bun runner when bun.lock exists')
})

test('discoverVerificationChecks discovers GitLab CI checks', async () => {
  const dir = await makeDir()
  await writeFile(
    join(dir, '.gitlab-ci.yml'),
    [
      'test:',
      '  script:',
      '    - npm test',
      '    - npm run lint',
      'deploy:',
      '  script:',
      '    - docker push myimage',
    ].join('\n'),
    'utf8'
  )

  const checks = await discoverVerificationChecks(dir)
  // npm test matches; docker push must be filtered out by noisy pattern
  assert.ok(checks.some((c) => c.command === 'npm test'), 'npm test should be discovered')
  assert.ok(!checks.some((c) => c.command.includes('docker push')), 'docker push should be filtered')
})

test('discoverVerificationChecks disambiguates Flutter from Dart', async () => {
  const dir = await makeDir()
  await writeFile(
    join(dir, 'pubspec.yaml'),
    'name: my_flutter_app\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\nflutter:\n  uses-material-design: true\n',
    'utf8'
  )

  const checks = await discoverVerificationChecks(dir)
  const dartLike = checks.find((c) => c.id === 'dart_test' || c.id === 'flutter_test')
  assert.ok(dartLike, 'Should discover a test check')
  assert.equal(dartLike!.id, 'flutter_test', 'Flutter project should use flutter test')
  assert.match(dartLike!.command, /flutter test/)
})

test('discoverVerificationChecks discovers python ruff from pyproject.toml [tool.ruff]', async () => {
  const dir = await makeDir()
  await writeFile(
    join(dir, 'pyproject.toml'),
    '[tool.ruff]\nline-length = 120\n',
    'utf8'
  )
  await writeFile(join(dir, 'main.py'), 'print("hello")\n', 'utf8')

  const checks = await discoverVerificationChecks(dir)
  const ruff = checks.find((c) => c.id === 'python_lint')
  assert.ok(ruff, 'Should discover python_lint check')
  assert.match(ruff!.command, /ruff check/)
})

test('discoverVerificationChecks infers requiresCommands from CI env-prefixed command', async () => {
  const dir = await makeDir()
  await mkdir(join(dir, '.github'))
  await mkdir(join(dir, '.github', 'workflows'))
  await writeFile(
    join(dir, '.github', 'workflows', 'ci.yml'),
    [
      'name: ci',
      'on: [push]',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: NODE_ENV=test npm test',
    ].join('\n'),
    'utf8'
  )

  const checks = await discoverVerificationChecks(dir)
  assert.equal(checks.length, 1)
  // Binary should be inferred as 'npm' (env assignment skipped)
  assert.deepEqual(checks[0]?.requiresCommands, ['npm'])
})

test('discoverVerificationChecks infers requiresCommands for custom config when omitted', async () => {
  const dir = await makeDir()
  await mkdir(join(dir, '.merlion'))
  await writeFile(
    join(dir, '.merlion', 'verify.json'),
    JSON.stringify({
      checks: [{ id: 'custom_npm_test', name: 'Custom NPM Test', command: 'NODE_ENV=test npm test' }]
    }),
    'utf8'
  )

  const checks = await discoverVerificationChecks(dir)
  assert.equal(checks.length, 1)
  assert.deepEqual(checks[0]?.requiresCommands, ['npm'])
})

test('discoverVerificationChecks skips checks with missing required fields in custom config', async () => {
  const dir = await makeDir()
  await mkdir(join(dir, '.merlion'))
  await writeFile(
    join(dir, '.merlion', 'verify.json'),
    JSON.stringify({
      checks: [
        { id: 'no_name', command: 'npm test' },          // missing name
        { id: '', name: 'Empty ID', command: 'npm test' }, // empty id
        { id: 'ok', name: 'OK Check', command: 'echo ok' } // valid
      ]
    }),
    'utf8'
  )

  const checks = await discoverVerificationChecks(dir)
  assert.equal(checks.length, 1)
  assert.equal(checks[0]?.id, 'ok')
})
