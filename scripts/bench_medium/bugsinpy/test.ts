import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertCheckoutDir, computePythonPath, readBugInfo } from './common.ts'

type TestMode = 'relevant' | 'all' | 'single'

interface TestOptions {
  repoDir: string
  mode: TestMode
  singleTest?: string
}

function parseArgs(argv: string[]): TestOptions {
  let repoDir = ''
  let mode: TestMode = 'relevant'
  let singleTest = ''

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repo') repoDir = argv[index + 1] ?? ''
    if (arg === '--mode') mode = (argv[index + 1] as TestMode | undefined) ?? mode
    if (arg === '--single') singleTest = argv[index + 1] ?? ''
  }

  if (repoDir.trim() === '') {
    throw new Error('usage: test.ts --repo <checkout-dir> [--mode relevant|all|single] [--single <test>]')
  }
  if (mode === 'single' && singleTest.trim() === '') {
    throw new Error('single mode requires --single <test>')
  }
  return { repoDir, mode, singleTest }
}

async function runCommand(command: string, cwd: string, extraEnv: NodeJS.ProcessEnv): Promise<number> {
  return await new Promise<number>((resolveRun, rejectRun) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
    })
    child.on('close', (code) => resolveRun(code ?? 1))
    child.on('error', rejectRun)
  })
}

async function readRelevantCommands(repoDir: string): Promise<string[]> {
  const raw = await readFile(join(repoDir, 'bugsinpy_run_test.sh'), 'utf8')
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function usesPytest(commands: string[]): boolean {
  return commands.some((command) => /\b(pytest|py\.test)\b/.test(command))
}

function inferUnittestDiscoverArg(testFiles: string[]): string {
  const first = testFiles[0] ?? ''
  if (first === '') return ''
  const segments = first.split('/').filter(Boolean)
  const prefix: string[] = []
  for (const segment of segments) {
    if (segment.endsWith('.py')) break
    prefix.push(segment)
    if (segment === 'test' || segment === 'tests') break
  }
  return prefix.join('/')
}

export async function runBugsInPyTests(options: TestOptions): Promise<void> {
  await assertCheckoutDir(options.repoDir)
  const compileFlag = join(options.repoDir, 'bugsinpy_compile_flag')
  await readFile(compileFlag, 'utf8').catch(() => {
    throw new Error(`checkout has not been compiled: missing ${compileFlag}`)
  })

  const bugInfo = await readBugInfo(options.repoDir)
  const relevantCommands = await readRelevantCommands(options.repoDir)
  const envPath = join(options.repoDir, 'env')
  const envBin = process.platform === 'win32' ? join(envPath, 'Scripts') : join(envPath, 'bin')
  const pythonPath = computePythonPath(options.repoDir, bugInfo)
  const extraEnv = {
    VIRTUAL_ENV: envPath,
    PATH: `${envBin}:${process.env.PATH ?? ''}`,
    PYTHONPATH: pythonPath,
  }

  if (options.mode === 'relevant') {
    for (const command of relevantCommands) {
      const code = await runCommand(command, options.repoDir, extraEnv)
      if (code !== 0) {
        throw new Error(`relevant test failed (${code}): ${command}`)
      }
    }
    return
  }

  if (options.mode === 'single') {
    const base = usesPytest(relevantCommands) ? `pytest ${options.singleTest}` : `python -m unittest -q ${options.singleTest}`
    const code = await runCommand(base, options.repoDir, extraEnv)
    if (code !== 0) throw new Error(`single test failed (${code}): ${base}`)
    return
  }

  const command = usesPytest(relevantCommands)
    ? 'pytest'
    : `python -m unittest discover ${inferUnittestDiscoverArg(bugInfo.testFiles)}`.trim()
  const code = await runCommand(command, options.repoDir, extraEnv)
  if (code !== 0) {
    throw new Error(`all-tests command failed (${code}): ${command}`)
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  await runBugsInPyTests(options)
}

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
