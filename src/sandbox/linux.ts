import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import type { SandboxBackend, SandboxCommand, SandboxRunResult } from './backend.ts'
import type { ResolvedSandboxPolicy } from './policy.ts'
import { runProcess } from '../tools/builtin/process_common.ts'

export interface BubblewrapInvocation {
  argv: string[]
  cleanupDir: string
}

async function commandExists(binary: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-lc', `command -v ${binary} >/dev/null 2>&1`])
    child.on('exit', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

function pushMount(args: string[], flag: '--bind' | '--ro-bind', source: string, dest: string): void {
  args.push(flag, source, dest)
}

function ensureMaskPath(maskRoot: string, sourcePath: string): string {
  const pathInfo = existsSync(sourcePath) ? statSync(sourcePath) : null
  const safeName = sourcePath.replace(/[^A-Za-z0-9._-]+/g, '_')
  const target = join(maskRoot, safeName)
  if (pathInfo?.isDirectory()) {
    mkdirSync(target, { recursive: true })
    return target
  }
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, '')
  return target
}

export async function buildBubblewrapInvocation(
  command: SandboxCommand,
  policy: ResolvedSandboxPolicy,
): Promise<BubblewrapInvocation> {
  const cleanupDir = await mkdtemp(join(tmpdir(), 'merlion-bwrap-'))
  const args: string[] = [
    '--die-with-parent',
    '--new-session',
    '--ro-bind', '/', '/',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--tmpfs', '/var/tmp',
    '--tmpfs', '/run',
  ]

  if (policy.networkMode === 'off') {
    args.push('--unshare-net')
  }

  if (policy.mode === 'workspace-write') {
    for (const root of policy.writableRoots) {
      pushMount(args, '--bind', root, root)
    }
  }

  for (const deniedPath of policy.denyWrite) {
    if (!existsSync(deniedPath)) continue
    pushMount(args, '--ro-bind', deniedPath, deniedPath)
  }

  for (const deniedPath of policy.denyRead) {
    if (!existsSync(deniedPath)) continue
    const maskPath = ensureMaskPath(cleanupDir, deniedPath)
    pushMount(args, '--ro-bind', maskPath, deniedPath)
  }

  args.push(
    '--chdir', command.cwd,
    '/bin/bash',
    '--noprofile',
    '--norc',
    '-o',
    'pipefail',
    '-c',
    command.command,
  )

  return { argv: args, cleanupDir }
}

function inferViolation(stderr: string): SandboxRunResult['violation'] | undefined {
  if (/Temporary failure in name resolution|Could not resolve host|Network is unreachable|Name or service not known/i.test(stderr)) {
    return {
      kind: 'network',
      detail: 'bubblewrap blocked network access',
    }
  }
  if (/Read-only file system|EROFS/i.test(stderr)) {
    return {
      kind: 'fs-write',
      detail: 'bubblewrap blocked file writes',
    }
  }
  if (/(bwrap|bubblewrap):.*(Operation not permitted|Permission denied)/i.test(stderr)) {
    return {
      kind: 'policy',
      detail: 'bubblewrap denied the command',
    }
  }
  return undefined
}

export class LinuxBubblewrapBackend implements SandboxBackend {
  name(): string {
    return 'bubblewrap'
  }

  async isAvailableForPolicy(_policy: ResolvedSandboxPolicy): Promise<boolean> {
    if (process.platform !== 'linux') return false
    return await commandExists('bwrap')
  }

  async run(command: SandboxCommand, policy: ResolvedSandboxPolicy): Promise<SandboxRunResult> {
    const invocation = await buildBubblewrapInvocation(command, policy)
    try {
      const result = await runProcess('bwrap', invocation.argv, command.cwd, {
        timeoutMs: command.timeoutMs,
        maxOutputChars: command.maxOutputChars,
      })
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        violation: inferViolation(result.stderr),
      }
    } finally {
      await rm(invocation.cleanupDir, { recursive: true, force: true })
    }
  }
}
