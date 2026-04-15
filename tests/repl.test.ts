import test from 'node:test'
import assert from 'node:assert/strict'

import { parseReplInput, runReplSession } from '../src/cli/repl.ts'

test('parseReplInput handles commands and prompt', () => {
  assert.deepEqual(parseReplInput(':q'), { kind: 'local_action', action: 'exit' })
  assert.deepEqual(parseReplInput(':quit'), { kind: 'local_action', action: 'exit' })
  assert.deepEqual(parseReplInput(':help'), { kind: 'local_action', action: 'help' })
  assert.deepEqual(parseReplInput(':wechat'), { kind: 'slash_command', name: 'wechat', raw: ':wechat' })
  assert.deepEqual(parseReplInput('/wechat'), { kind: 'slash_command', name: 'wechat', raw: '/wechat' })
  assert.deepEqual(parseReplInput('! echo ok'), { kind: 'shell_shortcut', command: 'echo ok' })
  assert.deepEqual(parseReplInput(':detail compact'), { kind: 'local_action', action: 'set_detail', payload: 'compact' })
  assert.deepEqual(parseReplInput(':detail FULL'), { kind: 'local_action', action: 'set_detail', payload: 'full' })
  assert.deepEqual(parseReplInput('   '), { kind: 'empty' })
  assert.deepEqual(parseReplInput('fix auth flow'), { kind: 'prompt', text: 'fix auth flow' })
})

test('runReplSession loops prompts and exits', async () => {
  const inputs = ['first task', ':wechat', ':help', ':detail compact', '! echo ok', 'second task', ':q']
  const outputs: string[] = []
  const prompts: string[] = []
  const shellCommands: string[] = []
  const detailModes: Array<'full' | 'compact'> = []
  let wechatLoginCalls = 0

  await runReplSession({
    readLine: async () => inputs.shift() ?? null,
    write: (text) => {
      outputs.push(text)
    },
    runTurn: async (prompt) => {
      prompts.push(prompt)
      return { output: `done:${prompt}`, terminal: 'completed' }
    },
    runShellCommand: async (command) => {
      shellCommands.push(command)
      return { output: `shell:${command}`, terminal: 'completed' }
    },
    onSetDetailMode: (mode) => {
      detailModes.push(mode)
    },
    onWechatLogin: () => {
      wechatLoginCalls += 1
    },
    promptLabel: 'merlion> '
  })

  assert.deepEqual(prompts, ['first task', 'second task'])
  assert.deepEqual(shellCommands, ['echo ok'])
  assert.deepEqual(detailModes, ['compact'])
  assert.equal(wechatLoginCalls, 1)
  assert.equal(outputs.some((t) => t.includes('shell:echo ok')), true)
  assert.equal(outputs.some((t) => t.includes('done:first task')), true)
  assert.equal(outputs.some((t) => t.includes('done:second task')), true)
  assert.equal(outputs.some((t) => t.includes('Commands: :help, :q, :detail full|compact, :wechat (/wechat, login+listen)')), true)
  assert.equal(outputs.some((t) => t.includes('[ui] tool detail mode = compact')), true)
})

test('runReplSession supports custom turn renderer hooks', async () => {
  const inputs = ['hello', ':q']
  const outputs: string[] = []
  const rendered: string[] = []

  await runReplSession({
    readLine: async () => inputs.shift() ?? null,
    write: (text) => {
      outputs.push(text)
    },
    runTurn: async () => ({ output: 'raw-output', terminal: 'completed' }),
    startupMessage: false,
    onPromptSubmitted: (prompt) => {
      rendered.push(`user:${prompt}`)
    },
    onTurnResult: (result) => {
      rendered.push(`assistant:${result.output}`)
    },
  })

  assert.equal(rendered.includes('user:hello'), true)
  assert.equal(rendered.includes('assistant:raw-output'), true)
  assert.equal(outputs.some((t) => t.includes('raw-output')), false)
})
