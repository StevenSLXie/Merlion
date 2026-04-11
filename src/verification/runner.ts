import { spawn } from 'node:child_process'

import type { VerificationCheck } from './checks.ts'

export type VerificationStatus = 'passed' | 'failed' | 'skipped'

export interface VerificationCheckResult {
  id: string
  name: string
  command: string
  status: VerificationStatus
  durationMs: number
  exitCode: number | null
  output: string
  timedOut: boolean
}

export interface VerificationRunResult {
  allPassed: boolean
  results: VerificationCheckResult[]
}

export interface RunVerificationChecksOptions {
  cwd: string
  checks: VerificationCheck[]
  timeoutMs?: number
  maxOutputChars?: number
  onCheckStart?: (check: VerificationCheck) => Promise<void> | void
  onCheckResult?: (result: VerificationCheckResult) => Promise<void> | void
}

function envMissing(vars?: string[]): string[] {
  return (vars ?? []).filter((key) => {
    const value = process.env[key]
    return value === undefined || value.trim() === ''
  })
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

async function commandExists(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', `command -v ${shellQuote(command)} >/dev/null 2>&1`])
    child.on('close', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

async function commandMissing(commands?: string[]): Promise<string[]> {
  const missing: string[] = []
  for (const command of commands ?? []) {
    const exists = await commandExists(command)
    if (!exists) missing.push(command)
  }
  return missing
}

async function hasAnyCommand(commands?: string[]): Promise<boolean> {
  const candidates = commands ?? []
  if (candidates.length === 0) return true
  for (const command of candidates) {
    if (await commandExists(command)) return true
  }
  return false
}

function trimOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 40))}\n[...verification output truncated...]`
}

async function runCommand(
  cwd: string,
  command: string,
  timeoutMs: number,
  maxOutputChars: number
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', command], { cwd })
    let output = ''
    let timedOut = false
    let settled = false

    const append = (chunk: unknown) => {
      output = trimOutput(`${output}${String(chunk)}`, maxOutputChars)
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 1500).unref()
    }, timeoutMs)

    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode: code, output, timedOut })
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        exitCode: -1,
        output: trimOutput(`${output}\n${String(error)}`, maxOutputChars),
        timedOut: false
      })
    })
  })
}

export async function runVerificationChecks(
  options: RunVerificationChecksOptions
): Promise<VerificationRunResult> {
  const timeoutMs = Math.max(1000, Math.floor(options.timeoutMs ?? 180_000))
  const requestedMax = options.maxOutputChars
  const parsedMax = Number.isFinite(requestedMax) ? Math.floor(requestedMax as number) : 8000
  const maxOutputChars = parsedMax > 0 ? parsedMax : 8000
  const results: VerificationCheckResult[] = []

  for (const check of options.checks) {
    await options.onCheckStart?.(check)
    const missing = envMissing(check.requiresEnv)
    if (missing.length > 0) {
      const skipped: VerificationCheckResult = {
        id: check.id,
        name: check.name,
        command: check.command,
        status: 'skipped',
        durationMs: 0,
        exitCode: null,
        output: `Skipped: missing env ${missing.join(', ')}`,
        timedOut: false
      }
      results.push(skipped)
      await options.onCheckResult?.(skipped)
      continue
    }

    const missingCommands = await commandMissing(check.requiresCommands)
    if (missingCommands.length > 0) {
      const skipped: VerificationCheckResult = {
        id: check.id,
        name: check.name,
        command: check.command,
        status: 'skipped',
        durationMs: 0,
        exitCode: null,
        output: `Skipped: missing command ${missingCommands.join(', ')}`,
        timedOut: false
      }
      results.push(skipped)
      await options.onCheckResult?.(skipped)
      continue
    }

    if (!(await hasAnyCommand(check.requiresAnyCommands))) {
      const skipped: VerificationCheckResult = {
        id: check.id,
        name: check.name,
        command: check.command,
        status: 'skipped',
        durationMs: 0,
        exitCode: null,
        output: `Skipped: missing any command from ${check.requiresAnyCommands?.join(', ') ?? ''}`,
        timedOut: false
      }
      results.push(skipped)
      await options.onCheckResult?.(skipped)
      continue
    }

    const startedAt = Date.now()
    const run = await runCommand(options.cwd, check.command, timeoutMs, maxOutputChars)
    const durationMs = Date.now() - startedAt
    const passed = run.exitCode === 0 && !run.timedOut

    const result: VerificationCheckResult = {
      id: check.id,
      name: check.name,
      command: check.command,
      status: passed ? 'passed' : 'failed',
      durationMs,
      exitCode: run.exitCode,
      output: run.output,
      timedOut: run.timedOut
    }
    results.push(result)
    await options.onCheckResult?.(result)
  }

  return {
    allPassed: results.every((r) => r.status !== 'failed'),
    results
  }
}
