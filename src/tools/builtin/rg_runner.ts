import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { rgPath } from '@vscode/ripgrep'

import { runProcess, type RunProcessResult } from './process_common.ts'

export interface RipgrepRunResult extends RunProcessResult {
  engine: 'bundled' | 'system'
}

async function resolveBundledRipgrepPath(): Promise<string | null> {
  if (typeof rgPath !== 'string' || rgPath.trim() === '') return null
  try {
    await access(rgPath, constants.X_OK)
    return rgPath
  } catch {
    return null
  }
}

export async function runRipgrep(
  args: string[],
  cwd: string,
  options?: { timeoutMs?: number; maxOutputChars?: number }
): Promise<RipgrepRunResult> {
  const bundledPath = await resolveBundledRipgrepPath()
  if (bundledPath) {
    const bundled = await runProcess(bundledPath, args, cwd, options)
    if (bundled.exitCode !== -1) {
      return { ...bundled, engine: 'bundled' }
    }
  }

  const system = await runProcess('rg', args, cwd, options)
  return { ...system, engine: 'system' }
}
