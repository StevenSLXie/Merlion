import { runProcess } from '../tools/builtin/process_common.ts'
import type { SandboxBackend, SandboxCommand, SandboxRunResult } from './backend.ts'
import type { ResolvedSandboxPolicy } from './policy.ts'

export class NoSandboxBackend implements SandboxBackend {
  name(): string {
    return 'none'
  }

  async isAvailableForPolicy(_policy: ResolvedSandboxPolicy): Promise<boolean> {
    return true
  }

  async run(command: SandboxCommand, _policy: ResolvedSandboxPolicy): Promise<SandboxRunResult> {
    const result = await runProcess(
      '/bin/bash',
      ['--noprofile', '--norc', '-o', 'pipefail', '-c', command.command],
      command.cwd,
      { timeoutMs: command.timeoutMs, maxOutputChars: command.maxOutputChars },
    )
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    }
  }
}
