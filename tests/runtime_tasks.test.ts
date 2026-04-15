import test from 'node:test'
import assert from 'node:assert/strict'

import { localTurnTaskHandler } from '../src/runtime/tasks/handlers/local_turn.ts'
import { RuntimeTaskRegistry } from '../src/runtime/tasks/registry.ts'

test('RuntimeTaskRegistry registers and resolves handlers', () => {
  const registry = new RuntimeTaskRegistry()
  registry.register(localTurnTaskHandler)
  assert.equal(registry.get('local_turn')?.type, 'local_turn')
})

test('localTurnTaskHandler routes shell and slash locally before engine submission', async () => {
  const observed: string[] = []
  const engine = {
    async submitPrompt(prompt: string) {
      observed.push(`prompt:${prompt}`)
      return {
        terminal: 'completed' as const,
        finalText: `done:${prompt}`,
        state: {
          messages: [],
          turnCount: 1,
          maxOutputTokensRecoveryCount: 0,
          hasAttemptedReactiveCompact: false,
          nudgeCount: 0,
        },
      }
    },
  }

  const shell = await localTurnTaskHandler.run(
    {
      envelope: { kind: 'shell_shortcut', command: 'echo ok' },
      executeSlashCommand: async () => ({ output: 'slash', terminal: 'completed' }),
      executeShellShortcut: async (command) => ({ output: `shell:${command}`, terminal: 'completed' }),
    },
    { engine: engine as never },
  )
  assert.deepEqual(shell, { output: 'shell:echo ok', terminal: 'completed' })

  const slash = await localTurnTaskHandler.run(
    {
      envelope: { kind: 'slash_command', name: 'wechat', raw: '/wechat' },
      executeSlashCommand: async (name) => ({ output: `slash:${name}`, terminal: 'completed' }),
      executeShellShortcut: async () => ({ output: 'shell', terminal: 'completed' }),
    },
    { engine: engine as never },
  )
  assert.deepEqual(slash, { output: 'slash:wechat', terminal: 'completed' })

  const prompt = await localTurnTaskHandler.run(
    {
      envelope: { kind: 'prompt', text: 'fix auth flow' },
      executeSlashCommand: async () => ({ output: 'slash', terminal: 'completed' }),
      executeShellShortcut: async () => ({ output: 'shell', terminal: 'completed' }),
    },
    { engine: engine as never },
  )
  assert.equal(prompt.output, 'done:fix auth flow')
  assert.deepEqual(observed, ['prompt:fix auth flow'])
})
