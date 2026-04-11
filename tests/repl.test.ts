import test from 'node:test'
import assert from 'node:assert/strict'

import { parseReplInput, runReplSession } from '../src/cli/repl.ts'

test('parseReplInput handles commands and prompt', () => {
  assert.deepEqual(parseReplInput(':q'), { kind: 'exit' })
  assert.deepEqual(parseReplInput(':quit'), { kind: 'exit' })
  assert.deepEqual(parseReplInput(':help'), { kind: 'help' })
  assert.deepEqual(parseReplInput('   '), { kind: 'empty' })
  assert.deepEqual(parseReplInput('fix auth flow'), { kind: 'prompt', prompt: 'fix auth flow' })
})

test('runReplSession loops prompts and exits', async () => {
  const inputs = ['first task', ':help', 'second task', ':q']
  const outputs: string[] = []
  const prompts: string[] = []

  await runReplSession({
    readLine: async () => inputs.shift() ?? null,
    write: (text) => {
      outputs.push(text)
    },
    runTurn: async (prompt) => {
      prompts.push(prompt)
      return { output: `done:${prompt}`, terminal: 'completed' }
    },
    promptLabel: 'merlion> '
  })

  assert.deepEqual(prompts, ['first task', 'second task'])
  assert.equal(outputs.some((t) => t.includes('done:first task')), true)
  assert.equal(outputs.some((t) => t.includes('done:second task')), true)
  assert.equal(outputs.some((t) => t.includes('Commands: :help, :q')), true)
})

