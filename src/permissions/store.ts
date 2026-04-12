import type { PermissionDecision, PermissionStore } from '../tools/types.js'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

export interface PermissionPromptIo {
  write: (text: string) => void
  readLine: () => Promise<string>
}

function createDefaultPromptIo(): PermissionPromptIo {
  return {
    write(text: string) {
      process.stdout.write(text)
    },
    async readLine() {
      const rl = createInterface({ input: stdin, output: stdout })
      try {
        return await rl.question('')
      } finally {
        rl.close()
      }
    }
  }
}

export function createPermissionStore(
  mode: 'interactive' | 'auto_allow' | 'auto_deny',
  io: PermissionPromptIo = createDefaultPromptIo()
): PermissionStore {
  if (mode === 'auto_allow') {
    return { ask: async () => 'allow_session' }
  }
  if (mode === 'auto_deny') {
    return { ask: async () => 'deny' }
  }

  const sessionAllowByTool = new Set<string>()

  return {
    async ask(tool: string, description: string): Promise<PermissionDecision> {
      if (sessionAllowByTool.has(tool)) return 'allow_session'

      io.write(`Permission required for ${tool}: ${description}\n`)
      io.write('1) yes\n')
      io.write('2) no\n')
      io.write('3) yes and do not ask again for this tool in this session\n')
      io.write('Choose [y/n/a] (default: n): ')

      const answer = (await io.readLine()).trim().toLowerCase()
      if (answer === 'a' || answer === 'always' || answer === '3') {
        sessionAllowByTool.add(tool)
        return 'allow_session'
      }
      if (answer === 'y' || answer === 'yes' || answer === '1') {
        return 'allow'
      }
      return 'deny'
    }
  }
}
