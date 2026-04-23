import type { ResolvedSandboxPolicy } from './policy.ts'

export interface SandboxCommand {
  command: string
  cwd: string
  timeoutMs: number
  maxOutputChars?: number
}

export interface SandboxViolation {
  kind: 'fs-write' | 'fs-read' | 'network' | 'policy' | 'backend'
  detail: string
}

export interface SandboxRunResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  violation?: SandboxViolation
}

export interface SandboxBackend {
  name(): string
  isAvailableForPolicy(policy: ResolvedSandboxPolicy): Promise<boolean>
  run(command: SandboxCommand, policy: ResolvedSandboxPolicy): Promise<SandboxRunResult>
}
