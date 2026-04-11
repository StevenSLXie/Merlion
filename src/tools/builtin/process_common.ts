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
    const trim = (text: string): string => (
      text.length > maxOutputChars
        ? `${text.slice(0, maxOutputChars)}\n[output truncated]`
        : text
    )

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
    child.on('error', (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ exitCode: -1, stdout, stderr: trim(`${stderr}\n${String(error)}`), timedOut: false })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut })
    })
  })
}
