import type { PermissionDecision, PermissionRequest, PermissionStore } from '../tools/types.js'
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import type { ApprovalPolicy } from '../sandbox/policy.ts'

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

function permissionScope(tool: string, request?: PermissionRequest): string {
  const scope = request?.sessionScope?.trim()
  return scope && scope !== '' ? scope : tool
}

export function createPermissionStore(
  mode: 'interactive' | 'auto_allow' | 'auto_deny' | ApprovalPolicy,
  io: PermissionPromptIo = createDefaultPromptIo()
): PermissionStore {
  if (mode === 'auto_allow' || mode === 'never') {
    return { ask: async () => 'allow_session' }
  }
  if (mode === 'auto_deny' || mode === 'untrusted') {
    return { ask: async () => 'deny' }
  }

  const sessionAllowScopes = new Set<string>()

  return {
    async ask(tool: string, description: string, request?: PermissionRequest): Promise<PermissionDecision> {
      const scope = permissionScope(tool, request)
      if (sessionAllowScopes.has(scope)) return 'allow_session'

      io.write(`Permission required for ${tool}: ${description}\n`)
      io.write('1) yes\n')
      io.write('2) no\n')
      io.write(
        scope === tool
          ? '3) yes and do not ask again for this tool in this session\n'
          : '3) yes and do not ask again for this permission type in this session\n'
      )
      io.write('Choose [y/n/a] (default: n): ')

      const answer = (await io.readLine()).trim().toLowerCase()
      if (answer === 'a' || answer === 'always' || answer === '3') {
        sessionAllowScopes.add(scope)
        return 'allow_session'
      }
      if (answer === 'y' || answer === 'yes' || answer === '1') {
        return 'allow'
      }
      return 'deny'
    }
  }
}
