import type { PermissionDecision, PermissionStore } from '../tools/types.js'

export function createPermissionStore(mode: 'interactive' | 'auto_allow' | 'auto_deny'): PermissionStore {
  if (mode === 'auto_allow') {
    return { ask: async () => 'allow_session' }
  }
  if (mode === 'auto_deny') {
    return { ask: async () => 'deny' }
  }

  return {
    async ask(tool: string, description: string): Promise<PermissionDecision> {
      process.stdout.write(`Permission required for ${tool}: ${description}\n`)
      process.stdout.write('Allow? [y/N]: ')
      const answer = await new Promise<string>((resolve) => {
        process.stdin.resume()
        process.stdin.once('data', (data) => {
          resolve(String(data).trim().toLowerCase())
        })
      })
      return answer === 'y' || answer === 'yes' ? 'allow' : 'deny'
    }
  }
}

