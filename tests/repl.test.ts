import test from 'node:test'
import assert from 'node:assert/strict'

import { parseReplInput, runReplSession } from '../src/cli/repl.ts'

test('parseReplInput handles commands and prompt', () => {
  assert.deepEqual(parseReplInput(':q'), { kind: 'exit' })
  assert.deepEqual(parseReplInput(':quit'), { kind: 'exit' })
  assert.deepEqual(parseReplInput(':help'), { kind: 'help' })
  assert.deepEqual(parseReplInput(':detail compact'), { kind: 'set_detail', mode: 'compact' })
  assert.deepEqual(parseReplInput(':detail FULL'), { kind: 'set_detail', mode: 'full' })
  assert.deepEqual(parseReplInput('   '), { kind: 'empty' })
  assert.deepEqual(parseReplInput('fix auth flow'), { kind: 'prompt', prompt: 'fix auth flow' })
})

test('runReplSession loops prompts and exits', async () => {
  const inputs = ['first task', ':help', ':detail compact', 'second task', ':q']
  const outputs: string[] = []
  const prompts: string[] = []
  const detailModes: Array<'full' | 'compact'> = []

  await runReplSession({
    readLine: async () => inputs.shift() ?? null,
    write: (text) => {
      outputs.push(text)
    },
    runTurn: async (prompt) => {
      prompts.push(prompt)
      return { output: `done:${prompt}`, terminal: 'completed' }
    },
    onSetDetailMode: (mode) => {
      detailModes.push(mode)
    },
    promptLabel: 'merlion> '
  })

  assert.deepEqual(prompts, ['first task', 'second task'])
  assert.deepEqual(detailModes, ['compact'])
  assert.equal(outputs.some((t) => t.includes('done:first task')), true)
  assert.equal(outputs.some((t) => t.includes('done:second task')), true)
  assert.equal(outputs.some((t) => t.includes('Commands: :help, :q, :detail full|compact')), true)
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
