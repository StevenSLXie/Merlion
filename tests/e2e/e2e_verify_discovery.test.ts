/**
 * Integration: Verification check discovery (no LLM required).
 *
 * Exercises discoverVerificationChecks against a sandbox that resembles a real
 * Node project, verifying:
 *   1. Standard npm scripts (typecheck, test, test:e2e, lint) are discovered.
 *   2. Custom .merlion/verify.json overrides auto-discovery entirely.
 *   3. CI workflow commands (GitHub Actions) take priority over language detection.
 *
 * Does NOT require an API key.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSandbox, rmSandbox } from './helpers.ts'
import { discoverVerificationChecks } from '../../src/verification/checks.ts'

test('verify discovery: npm scripts discovered in correct priority order', async () => {
  const sandbox = await makeSandbox()
  try {
    await writeFile(
      join(sandbox, 'package.json'),
      JSON.stringify({
        scripts: {
          typecheck: 'tsc --noEmit',
          test: 'node --test',
          'test:e2e': 'node --test tests/e2e/*.test.ts',
          lint: 'eslint .',
        },
      }),
      'utf8',
    )

    const checks = await discoverVerificationChecks(sandbox)
    const ids = checks.map((c) => c.id)

    assert.deepEqual(ids, ['typecheck', 'test', 'test_e2e', 'lint'], 'Checks must appear in fixed priority order')
    assert.deepEqual(
      checks.find((c) => c.id === 'test_e2e')?.requiresEnv,
      ['OPENROUTER_API_KEY'],
      'test:e2e must declare OPENROUTER_API_KEY as required env',
    )
    assert.ok(
      checks.find((c) => c.id === 'typecheck')?.requiresCommands?.includes('npm'),
      'typecheck must declare npm as required command',
    )
  } finally {
    await rmSandbox(sandbox)
  }
})

test('verify discovery: custom .merlion/verify.json overrides language detection', async () => {
  const sandbox = await makeSandbox()
  try {
    // Both package.json (auto-discovery) and .merlion/verify.json (custom) exist.
    await writeFile(
      join(sandbox, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test' } }),
      'utf8',
    )
    await mkdir(join(sandbox, '.merlion'), { recursive: true })
    await writeFile(
      join(sandbox, '.merlion', 'verify.json'),
      JSON.stringify({
        checks: [
          { id: 'custom_lint', name: 'Custom Lint', command: 'echo lint-ok' },
          { id: 'custom_test', name: 'Custom Test', command: 'echo test-ok' },
        ],
      }),
      'utf8',
    )

    const checks = await discoverVerificationChecks(sandbox)
    assert.equal(checks.length, 2, 'Custom config must suppress auto-discovery entirely')
    assert.equal(checks[0]?.id, 'custom_lint')
    assert.equal(checks[1]?.id, 'custom_test')
    // No auto-discovered 'test' check should leak through
    assert.ok(!checks.some((c) => c.id === 'test'), 'npm test must not appear when custom config is present')
  } finally {
    await rmSandbox(sandbox)
  }
})

test('verify discovery: GitHub Actions CI commands take priority over npm scripts', async () => {
  const sandbox = await makeSandbox()
  try {
    await mkdir(join(sandbox, '.github', 'workflows'), { recursive: true })
    await writeFile(
      join(sandbox, '.github', 'workflows', 'ci.yml'),
      [
        'name: CI',
        'on: [push]',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: npm ci',           // non-verification — should be filtered
        '      - run: npm test',          // verification — must be included
        '      - run: npm run typecheck', // verification — must be included
      ].join('\n'),
      'utf8',
    )
    // Also add package.json — CI must take priority
    await writeFile(
      join(sandbox, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }),
      'utf8',
    )

    const checks = await discoverVerificationChecks(sandbox)
    const commands = checks.map((c) => c.command)

    assert.ok(commands.includes('npm test'), 'npm test from CI must be included')
    assert.ok(commands.includes('npm run typecheck'), 'npm run typecheck from CI must be included')
    // lint was only in package.json, not in CI — must not appear
    assert.ok(!commands.includes('npm run lint') && !commands.some((cmd) => cmd.includes('eslint')),
      'lint from package.json must be absent when CI checks are present')
    // All discovered checks must have ci_ IDs
    assert.ok(checks.every((c) => c.id.startsWith('ci_')), 'All CI-sourced checks must have ci_ ID prefix')
  } finally {
    await rmSandbox(sandbox)
  }
})
