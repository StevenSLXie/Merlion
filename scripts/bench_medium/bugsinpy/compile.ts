import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertCheckoutDir, computePythonPath, readBugInfo } from './common.ts'

interface CompileOptions {
  repoDir: string
  pythonBin: string
}

export function getVenvBootstrapCommands(envPython: string): string[] {
  return [
    `${envPython} -m ensurepip --upgrade`,
  ]
}

function parseArgs(argv: string[]): CompileOptions {
  let repoDir = ''
  let pythonBin = process.env.PYTHON_BIN ?? 'python3'
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repo') repoDir = argv[index + 1] ?? ''
    if (arg === '--python') pythonBin = argv[index + 1] ?? pythonBin
  }
  if (repoDir.trim() === '') {
    throw new Error('usage: compile.ts --repo <checkout-dir> [--python <python-bin>]')
  }
  return { repoDir, pythonBin }
}

async function runCommand(command: string, cwd: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolveRun()
        return
      }
      rejectRun(new Error(`command failed (${code}): ${command}`))
    })
    child.on('error', rejectRun)
  })
}

async function readRequirements(repoDir: string): Promise<string[]> {
  const raw = await readFile(join(repoDir, 'bugsinpy_requirements.txt'), 'utf8')
  return sanitizeRequirements(
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#')),
    repoDir,
  )
}

function rewriteSelfEditableRequirement(line: string, repoDir: string): string {
  const repoName = basename(repoDir).trim().toLowerCase()
  if (repoName === '') return line
  const eggMatch = line.match(/#egg=([A-Za-z0-9_.-]+)/)
  const eggName = eggMatch?.[1]?.trim().toLowerCase()
  if (!eggName || eggName !== repoName) return line
  if (!/^(?:-e\s+)?git\+https?:\/\//i.test(line)) return line
  return '-e .'
}

export function sanitizeRequirements(lines: string[], repoDir = ''): string[] {
  return lines
    .filter((line) => line.toLowerCase() !== 'pkg-resources==0.0.0')
    .map((line) => (repoDir ? rewriteSelfEditableRequirement(line, repoDir) : line))
}

async function readRelevantCommands(repoDir: string): Promise<string[]> {
  const raw = await readFile(join(repoDir, 'bugsinpy_run_test.sh'), 'utf8')
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

export function relevantCommandsNeedPytest(commands: string[]): boolean {
  return commands.some((command) => /\b(pytest|py\.test)\b/.test(command))
}

async function commandExists(command: string, cwd: string, extraEnv: NodeJS.ProcessEnv): Promise<boolean> {
  const checker = process.platform === 'win32'
    ? `${command} --version`
    : `command -v ${command}`
  return await new Promise<boolean>((resolveExists) => {
    const child = spawn(checker, {
      cwd,
      shell: true,
      env: { ...process.env, ...extraEnv },
      stdio: 'ignore',
    })
    child.on('close', (code) => resolveExists(code === 0))
    child.on('error', () => resolveExists(false))
  })
}

export async function compileCheckout(options: CompileOptions): Promise<void> {
  await assertCheckoutDir(options.repoDir)
  const bugInfo = await readBugInfo(options.repoDir)
  const relevantCommands = await readRelevantCommands(options.repoDir)
  const pythonPath = computePythonPath(options.repoDir, bugInfo)
  const envPath = join(options.repoDir, 'env')
  const envBin = process.platform === 'win32' ? join(envPath, 'Scripts') : join(envPath, 'bin')
  const envPython = process.platform === 'win32' ? join(envBin, 'python.exe') : join(envBin, 'python')
  const pipBin = process.platform === 'win32' ? join(envBin, 'pip.exe') : join(envBin, 'pip')
  const extraEnv = {
    VIRTUAL_ENV: envPath,
    PATH: `${envBin}:${process.env.PATH ?? ''}`,
    PYTHONPATH: pythonPath,
  }

  await runCommand(`${options.pythonBin} -m venv env`, options.repoDir)
  for (const command of getVenvBootstrapCommands(envPython)) {
    await runCommand(command, options.repoDir, extraEnv)
  }

  const requirements = await readRequirements(options.repoDir)
  if (requirements.length > 0) {
    const sanitizedPath = join(options.repoDir, '.merlion_bugsinpy_requirements.txt')
    await writeFile(sanitizedPath, `${requirements.join('\n')}\n`, 'utf8')
    await runCommand(`${pipBin} install -r ${sanitizedPath}`, options.repoDir, extraEnv)
  }

  const setupPath = join(options.repoDir, 'bugsinpy_setup.sh')
  const setupExists = await readFile(setupPath, 'utf8').then(() => true).catch(() => false)
  if (setupExists) {
    await runCommand('bash bugsinpy_setup.sh', options.repoDir, extraEnv)
  }

  if (relevantCommandsNeedPytest(relevantCommands)) {
    const hasPytest = await commandExists('pytest', options.repoDir, extraEnv)
    if (!hasPytest) {
      await runCommand(`${pipBin} install pytest`, options.repoDir, extraEnv)
    }
  }

  await writeFile(join(options.repoDir, 'bugsinpy_compile_flag'), '1\n', 'utf8')
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  await compileCheckout(options)
}

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
