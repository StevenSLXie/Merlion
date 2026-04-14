import { cwd as currentCwd } from 'node:process'

export interface CliFlags {
  modelFlag: string | undefined
  baseURLFlag: string | undefined
  cwd: string
  permissionMode: 'interactive' | 'auto_allow' | 'auto_deny'
  resumeSessionId?: string
  repl: boolean
  verify: boolean
  configMode: boolean
  wechatMode: boolean
  wechatLogin: boolean
  task: string
}

export function createDefaultCliFlags(): CliFlags {
  return {
    task: '',
    modelFlag: undefined,
    baseURLFlag: undefined,
    cwd: currentCwd(),
    permissionMode: 'interactive',
    resumeSessionId: undefined,
    repl: true,
    verify: process.env.MERLION_VERIFY === '1',
    configMode: false,
    wechatMode: false,
    wechatLogin: false,
  }
}

export function parseCliArgs(argv: string[]): CliFlags | null | 'help' | 'version' {
  const args = [...argv]
  let modelFlag: string | undefined
  let baseURLFlag: string | undefined
  let cwd = currentCwd()
  let permissionMode: CliFlags['permissionMode'] = 'interactive'
  let resumeSessionId: string | undefined
  let repl = false
  let verify = process.env.MERLION_VERIFY === '1'
  let configMode = false
  let wechatMode = false
  let wechatLogin = false
  const taskParts: string[] = []

  while (args.length > 0) {
    const arg = args.shift()!
    if (arg === '--model') {
      modelFlag = args.shift()
      continue
    }
    if (arg === '--base-url') {
      baseURLFlag = args.shift()
      continue
    }
    if (arg === '--cwd') {
      cwd = args.shift() ?? cwd
      continue
    }
    if (arg === '--auto-allow') {
      permissionMode = 'auto_allow'
      continue
    }
    if (arg === '--auto-deny') {
      permissionMode = 'auto_deny'
      continue
    }
    if (arg === '--resume') {
      resumeSessionId = args.shift()
      continue
    }
    if (arg === '--repl') {
      repl = true
      continue
    }
    if (arg === '--verify') {
      verify = true
      continue
    }
    if (arg === '--no-verify') {
      verify = false
      continue
    }
    if (arg === '--help' || arg === '-h') {
      return 'help'
    }
    if (arg === '--config' || arg === 'config') {
      configMode = true
      continue
    }
    if (arg === 'wechat' || arg === 'connect') {
      wechatMode = true
      continue
    }
    if (arg === '--login') {
      wechatLogin = true
      continue
    }
    if (arg === '--version' || arg === '-v') {
      return 'version'
    }
    taskParts.push(arg)
  }

  const task = taskParts.join(' ').trim()
  if (task.length === 0 && !resumeSessionId && !repl && !configMode && !wechatMode) return null

  return {
    task: task.length === 0 ? 'Continue from the existing session state.' : task,
    modelFlag,
    baseURLFlag,
    cwd,
    permissionMode,
    resumeSessionId,
    repl,
    verify,
    configMode,
    wechatMode,
    wechatLogin,
  }
}

export function printUsage(write: (text: string) => void = (text) => process.stdout.write(text)): void {
  write(
    'Usage: merlion [--model <id>] [--base-url <url>] [--cwd <path>] [--auto-allow|--auto-deny] [--resume <id>] [--repl] [--verify|--no-verify] [config] [wechat [--login]] "<task>"\n'
  )
}
