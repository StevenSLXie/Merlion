import { cwd as currentCwd } from 'node:process'
import type { ApprovalPolicy, NetworkMode, SandboxMode } from '../sandbox/policy.ts'

export interface CliFlags {
  modelFlag: string | undefined
  baseURLFlag: string | undefined
  cwd: string
  permissionMode: 'interactive' | 'auto_allow' | 'auto_deny'
  sandboxMode: SandboxMode
  approvalPolicy: ApprovalPolicy
  networkMode: NetworkMode
  writableRoots: string[]
  denyRead: string[]
  denyWrite: string[]
  resumeSessionId?: string
  repl: boolean
  verify: boolean
  configMode: boolean
  undoMode: boolean
  undoSessionId?: string
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
    sandboxMode: 'workspace-write',
    approvalPolicy: 'on-failure',
    networkMode: 'off',
    writableRoots: [],
    denyRead: [],
    denyWrite: [],
    resumeSessionId: undefined,
    repl: true,
    verify: process.env.MERLION_VERIFY === '1',
    configMode: false,
    undoMode: false,
    undoSessionId: undefined,
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
  let sandboxMode: CliFlags['sandboxMode'] = 'workspace-write'
  let approvalPolicy: CliFlags['approvalPolicy'] = 'on-failure'
  let networkMode: CliFlags['networkMode'] = 'off'
  const writableRoots: string[] = []
  const denyRead: string[] = []
  const denyWrite: string[] = []
  let resumeSessionId: string | undefined
  let repl = false
  let verify = process.env.MERLION_VERIFY === '1'
  let configMode = false
  let undoMode = false
  let undoSessionId: string | undefined
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
      approvalPolicy = 'never'
      continue
    }
    if (arg === '--auto-deny') {
      permissionMode = 'auto_deny'
      approvalPolicy = 'untrusted'
      continue
    }
    if (arg === '--sandbox') {
      const value = args.shift()
      if (value === 'read-only' || value === 'workspace-write' || value === 'danger-full-access') {
        sandboxMode = value
      }
      continue
    }
    if (arg === '--approval') {
      const value = args.shift()
      if (value === 'untrusted' || value === 'on-failure' || value === 'on-request' || value === 'never') {
        approvalPolicy = value
      }
      continue
    }
    if (arg === '--network') {
      const value = args.shift()
      if (value === 'off' || value === 'full') {
        networkMode = value
      }
      continue
    }
    if (arg === '--allow-write') {
      const value = args.shift()
      if (value) writableRoots.push(value)
      continue
    }
    if (arg === '--deny-read') {
      const value = args.shift()
      if (value) denyRead.push(value)
      continue
    }
    if (arg === '--deny-write') {
      const value = args.shift()
      if (value) denyWrite.push(value)
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
    if (arg === 'undo') {
      undoMode = true
      if (args[0] && !args[0]!.startsWith('-')) {
        undoSessionId = args.shift()
      }
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
  if (task.length === 0 && !resumeSessionId && !repl && !configMode && !undoMode && !wechatMode) return null

  return {
    task: task.length === 0 ? 'Continue from the existing session state.' : task,
    modelFlag,
    baseURLFlag,
    cwd,
    permissionMode,
    sandboxMode,
    approvalPolicy,
    networkMode,
    writableRoots,
    denyRead,
    denyWrite,
    resumeSessionId,
    repl,
    verify,
    configMode,
    undoMode,
    undoSessionId,
    wechatMode,
    wechatLogin,
  }
}

export function printUsage(write: (text: string) => void = (text) => process.stdout.write(text)): void {
  write(
    'Usage: merlion [--model <id>] [--base-url <url>] [--cwd <path>] [--sandbox <mode>] [--approval <policy>] [--network <mode>] [--allow-write <path>] [--deny-read <path>] [--deny-write <path>] [--auto-allow|--auto-deny] [--resume <id>] [--repl] [--verify|--no-verify] [config] [undo [session-id]] [wechat [--login]] "<task>"\n'
  )
  write(
    'Note: once any --allow-write path is set, the writable roots become exactly those paths; the cwd is no longer implicitly writable.\n'
  )
}
