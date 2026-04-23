import test from 'node:test'
import assert from 'node:assert/strict'

import { createDefaultCliFlags, parseCliArgs, printUsage, type CliFlags } from '../src/bootstrap/cli_args.ts'

function expectFlags(value: CliFlags | null | 'help' | 'version'): CliFlags {
  if (value === null || value === 'help' || value === 'version') {
    assert.fail('expected CliFlags result')
  }
  return value
}

test('createDefaultCliFlags defaults to repl mode', () => {
  const flags = createDefaultCliFlags()
  assert.equal(flags.repl, true)
  assert.equal(flags.task, '')
  assert.equal(flags.permissionMode, 'interactive')
  assert.equal(flags.sandboxMode, 'workspace-write')
  assert.equal(flags.approvalPolicy, 'on-failure')
  assert.equal(flags.networkMode, 'off')
})

test('parseCliArgs parses one-shot task and flags', () => {
  const parsed = expectFlags(
    parseCliArgs(['--model', 'gpt-test', '--base-url', 'https://x.test/v1', '--cwd', '/tmp/x', '--auto-allow', '--verify', 'fix', 'bug'])
  )
  assert.equal(parsed.modelFlag, 'gpt-test')
  assert.equal(parsed.baseURLFlag, 'https://x.test/v1')
  assert.equal(parsed.cwd, '/tmp/x')
  assert.equal(parsed.permissionMode, 'auto_allow')
  assert.equal(parsed.approvalPolicy, 'never')
  assert.equal(parsed.verify, true)
  assert.equal(parsed.task, 'fix bug')
})

test('parseCliArgs parses sandbox and policy flags', () => {
  const parsed = expectFlags(
    parseCliArgs([
      '--sandbox', 'read-only',
      '--approval', 'on-request',
      '--network', 'full',
      '--allow-write', 'tmp',
      '--deny-read', '.env',
      '--deny-write', '.merlion',
      'inspect',
    ])
  )

  assert.equal(parsed.sandboxMode, 'read-only')
  assert.equal(parsed.approvalPolicy, 'on-request')
  assert.equal(parsed.networkMode, 'full')
  assert.deepEqual(parsed.writableRoots, ['tmp'])
  assert.deepEqual(parsed.denyRead, ['.env'])
  assert.deepEqual(parsed.denyWrite, ['.merlion'])
})

test('parseCliArgs returns null when no actionable input is provided', () => {
  assert.equal(parseCliArgs([]), null)
})

test('parseCliArgs recognizes config and wechat modes', () => {
  const configFlags = expectFlags(parseCliArgs(['config']))
  assert.equal(configFlags.configMode, true)

  const undoFlags = expectFlags(parseCliArgs(['undo', 'session-123']))
  assert.equal(undoFlags.undoMode, true)
  assert.equal(undoFlags.undoSessionId, 'session-123')

  const wechatFlags = expectFlags(parseCliArgs(['wechat', '--login']))
  assert.equal(wechatFlags.wechatMode, true)
  assert.equal(wechatFlags.wechatLogin, true)
})

test('printUsage writes the current usage string', () => {
  const output: string[] = []
  printUsage((text) => output.push(text))
  assert.match(output.join(''), /Usage: merlion/)
  assert.match(output.join(''), /wechat/)
  assert.match(output.join(''), /undo/)
  assert.match(output.join(''), /cwd is no longer implicitly writable/i)
})
