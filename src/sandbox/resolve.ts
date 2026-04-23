import type { SandboxBackend } from './backend.ts'
import { LinuxBubblewrapBackend } from './linux.ts'
import { MacOSSandboxBackend } from './macos.ts'
import { NoSandboxBackend } from './no_sandbox.ts'
import type { ResolvedSandboxPolicy } from './policy.ts'

export async function resolveSandboxBackend(policy: ResolvedSandboxPolicy): Promise<SandboxBackend> {
  if (policy.mode === 'danger-full-access') {
    return new NoSandboxBackend()
  }
  if (process.platform === 'darwin') {
    return new MacOSSandboxBackend()
  }
  if (process.platform === 'linux') {
    const backend = new LinuxBubblewrapBackend()
    if (await backend.isAvailableForPolicy(policy)) return backend
    throw new Error('Sandbox backend unavailable: bubblewrap is required for sandboxed Linux execution.')
  }
  throw new Error(`Sandbox backend unavailable on platform: ${process.platform}`)
}
