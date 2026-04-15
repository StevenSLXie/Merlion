import { processUserInput } from '../runtime/input/process.ts'
import type { UserInputEnvelope } from '../runtime/input/types.ts'

export type ReplInput = UserInputEnvelope

const REPL_HELP_TEXT = 'Commands: :help, :q, :detail full|compact, :wechat (/wechat, login+listen)\n'

export function parseReplInput(input: string): ReplInput {
  return processUserInput(input)
}

export interface RunReplSessionOptions {
  readLine: (promptLabel: string) => Promise<string | null>
  write: (text: string) => void
  runTurn: (prompt: string) => Promise<{ output: string; terminal: string }>
  runShellCommand?: (command: string) => Promise<{ output: string; terminal: string }>
  promptLabel?: string
  startupMessage?: string | false
  onPromptSubmitted?: (prompt: string) => Promise<void> | void
  onTurnResult?: (
    result: { output: string; terminal: string },
    prompt: string
  ) => Promise<void> | void
  onSetDetailMode?: (mode: 'full' | 'compact') => Promise<void> | void
  onWechatLogin?: () => Promise<void> | void
}

export async function runReplSession(options: RunReplSessionOptions): Promise<void> {
  if (options.startupMessage !== false) {
    options.write(options.startupMessage ?? `REPL started. ${REPL_HELP_TEXT}`)
  }
  const promptLabel = options.promptLabel ?? 'merlion> '

  for (;;) {
    const line = await options.readLine(promptLabel)
    if (line === null) break

    const parsed = parseReplInput(line)
    if (parsed.kind === 'local_action' && parsed.action === 'exit') {
      options.write('Bye.\n')
      break
    }
    if (parsed.kind === 'local_action' && parsed.action === 'help') {
      options.write(REPL_HELP_TEXT)
      continue
    }
    if (parsed.kind === 'slash_command' && parsed.name === 'wechat') {
      if (!options.onWechatLogin) {
        options.write('[wechat] command unavailable in this mode.\n')
        continue
      }
      try {
        await options.onWechatLogin()
      } catch (error) {
        options.write(`[wechat] login failed: ${String(error)}\n`)
      }
      continue
    }
    if (parsed.kind === 'local_action' && parsed.action === 'set_detail') {
      const mode = parsed.payload as 'full' | 'compact'
      await options.onSetDetailMode?.(mode)
      options.write(`[ui] tool detail mode = ${mode}\n`)
      continue
    }
    if (parsed.kind === 'shell_shortcut') {
      if (!options.runShellCommand) {
        options.write('[shell] command unavailable in this mode.\n')
        continue
      }
      const result = await options.runShellCommand(parsed.command)
      if (options.onTurnResult) {
        await options.onTurnResult(result, `! ${parsed.command}`)
      } else {
        options.write(`${result.output}\n`)
        if (result.terminal !== 'completed') {
          options.write(`[terminal: ${result.terminal}]\n`)
        }
      }
      continue
    }
    if (parsed.kind === 'empty') continue

    if (parsed.kind !== 'prompt') {
      options.write('[input] unsupported input envelope in REPL.\n')
      continue
    }

    await options.onPromptSubmitted?.(parsed.text)
    const result = await options.runTurn(parsed.text)
    if (options.onTurnResult) {
      await options.onTurnResult(result, parsed.text)
    } else {
      options.write(`${result.output}\n`)
      if (result.terminal !== 'completed') {
        options.write(`[terminal: ${result.terminal}]\n`)
      }
    }
  }
}
