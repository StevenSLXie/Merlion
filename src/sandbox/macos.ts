import { existsSync, realpathSync } from 'node:fs'

import { runProcess } from '../tools/builtin/process_common.ts'
import type { SandboxBackend, SandboxCommand, SandboxRunResult } from './backend.ts'
import type { ResolvedSandboxPolicy } from './policy.ts'

function quoteSeatbelt(input: string): string {
  return JSON.stringify(input)
}

function expandSeatbeltPaths(paths: string[]): string[] {
  const expanded = new Set<string>()
  for (const path of paths) {
    expanded.add(path)
    if (existsSync(path)) {
      expanded.add(realpathSync.native(path))
    } else if (path.startsWith('/tmp/')) {
      expanded.add(`/private${path}`)
    } else if (path === '/tmp') {
      expanded.add('/private/tmp')
    } else if (path.startsWith('/var/')) {
      expanded.add(`/private${path}`)
    } else if (path === '/var') {
      expanded.add('/private/var')
    }
  }
  return [...expanded].sort()
}

function allowRules(operations: string, paths: string[]): string[] {
  const rules: string[] = []
  for (const path of expandSeatbeltPaths(paths)) {
    rules.push(`(allow ${operations} (literal ${quoteSeatbelt(path)}) (subpath ${quoteSeatbelt(path)}))`)
  }
  return rules
}

function denyRules(operations: string, paths: string[]): string[] {
  const rules: string[] = []
  for (const path of expandSeatbeltPaths(paths)) {
    rules.push(`(deny ${operations} (literal ${quoteSeatbelt(path)}) (subpath ${quoteSeatbelt(path)}))`)
  }
  return rules
}

function buildProfile(policy: ResolvedSandboxPolicy): string {
  const lines = [
    '(version 1)',
    '(deny default)',
    '(import "system.sb")',
    '(allow process*)',
    '(allow file-read*)',
  ]
  if (policy.networkMode === 'off') {
    lines.push('(deny network*)')
  }
  if (policy.mode === 'workspace-write') {
    lines.push(...allowRules('file-write*', policy.writableRoots))
  }
  if (policy.denyRead.length > 0) {
    lines.push(...denyRules('file-read*', policy.denyRead))
  }
  if (policy.denyWrite.length > 0) {
    lines.push(...denyRules('file-write*', policy.denyWrite))
  }
  return lines.join('\n')
}

export function inferMacOSSandboxViolation(
  command: string,
  stderr: string,
): SandboxRunResult['violation'] | undefined {
  if (/Could not resolve host|Name or service not known|Network is unreachable|nodename nor servname provided/i.test(stderr)) {
    return {
      kind: 'network',
      detail: 'macOS sandbox blocked network access',
    }
  }
  if (/Read-only file system/i.test(stderr)) {
    return {
      kind: 'fs-write',
      detail: 'macOS sandbox blocked file writes',
    }
  }
  if (/sandbox-exec:/i.test(stderr) || /Operation not permitted/i.test(stderr)) {
    if (/\b(touch|mkdir|rm|mv|cp|tee|install|git\s+(add|commit|clean|checkout|switch|restore|reset)|sed\s+-i|perl\s+-i|npm\s+(install|ci|update))\b/i.test(command) || />/.test(command)) {
      return {
        kind: 'fs-write',
        detail: 'macOS sandbox blocked file writes',
      }
    }
    if (/\b(cat|grep|head|tail|find|ls|stat|sed|awk)\b/i.test(command)) {
      return {
        kind: 'fs-read',
        detail: 'macOS sandbox blocked file reads',
      }
    }
    return {
      kind: 'policy',
      detail: 'macOS sandbox denied the command',
    }
  }
  return undefined
}

export class MacOSSandboxBackend implements SandboxBackend {
  name(): string {
    return 'macos-sandbox-exec'
  }

  async isAvailableForPolicy(_policy: ResolvedSandboxPolicy): Promise<boolean> {
    return process.platform === 'darwin'
  }

  async run(command: SandboxCommand, policy: ResolvedSandboxPolicy): Promise<SandboxRunResult> {
    const profile = buildProfile(policy)
    const result = await runProcess(
      'sandbox-exec',
      ['-p', profile, '/bin/bash', '--noprofile', '--norc', '-o', 'pipefail', '-c', command.command],
      command.cwd,
      { timeoutMs: command.timeoutMs, maxOutputChars: command.maxOutputChars },
    )
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      violation: inferMacOSSandboxViolation(command.command, result.stderr),
    }
  }
}
