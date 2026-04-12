import { spawn } from 'node:child_process'

export interface RunProcessResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

export async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  options?: { timeoutMs?: number; maxOutputChars?: number }
): Promise<RunProcessResult> {
  const timeoutMs = options?.timeoutMs ?? 30_000
  const maxOutputChars = options?.maxOutputChars ?? 120_000
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let done = false
    let exitCode: number | null = null
    const trim = (text: string): string => (
      text.length > maxOutputChars
        ? `${text.slice(0, maxOutputChars)}\n[output truncated]`
        : text
    )

    const settle = (code: number): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ exitCode: code, stdout, stderr, timedOut })
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout = trim(stdout + String(chunk))
    })
    child.stderr.on('data', (chunk) => {
      stderr = trim(stderr + String(chunk))
    })
    child.on('exit', (code) => {
      exitCode = code
      settle(code ?? -1)
    })
    // Fallback path when `exit` is not observed first.
    child.on('close', (code) => {
      settle(code ?? exitCode ?? -1)
    })
    child.on('error', (error) => {
      stderr = trim(`${stderr}\n${String(error)}`)
      settle(-1)
    })
  })
}
