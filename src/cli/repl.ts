export type ReplInput =
  | { kind: 'exit' }
  | { kind: 'help' }
  | { kind: 'wechat_login' }
  | { kind: 'empty' }
  | { kind: 'shell'; command: string }
  | { kind: 'set_detail'; mode: 'full' | 'compact' }
  | { kind: 'prompt'; prompt: string }

const REPL_HELP_TEXT = 'Commands: :help, :q, :detail full|compact, :wechat (/wechat, login+listen)\n'

export function parseReplInput(input: string): ReplInput {
  const trimmed = input.trim()
  if (trimmed === '') return { kind: 'empty' }
  if (trimmed === ':q' || trimmed === ':quit' || trimmed === ':exit') return { kind: 'exit' }
  if (trimmed === ':help') return { kind: 'help' }
  if (/^[:/]wechat(?:\s+login)?$/i.test(trimmed)) return { kind: 'wechat_login' }
  const shellMatch = input.match(/^!\s+(.+)$/)
  if (shellMatch) {
    const command = shellMatch[1]!.trim()
    if (command !== '') return { kind: 'shell', command }
  }
  const detailMatch = trimmed.match(/^:detail\s+(full|compact)$/i)
  if (detailMatch) {
    return { kind: 'set_detail', mode: detailMatch[1]!.toLowerCase() as 'full' | 'compact' }
  }
  return { kind: 'prompt', prompt: trimmed }
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
    if (parsed.kind === 'exit') {
      options.write('Bye.\n')
      break
    }
    if (parsed.kind === 'help') {
      options.write(REPL_HELP_TEXT)
      continue
    }
    if (parsed.kind === 'wechat_login') {
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
    if (parsed.kind === 'set_detail') {
      await options.onSetDetailMode?.(parsed.mode)
      options.write(`[ui] tool detail mode = ${parsed.mode}\n`)
      continue
    }
    if (parsed.kind === 'shell') {
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

    await options.onPromptSubmitted?.(parsed.prompt)
    const result = await options.runTurn(parsed.prompt)
    if (options.onTurnResult) {
      await options.onTurnResult(result, parsed.prompt)
    } else {
      options.write(`${result.output}\n`)
      if (result.terminal !== 'completed') {
        options.write(`[terminal: ${result.terminal}]\n`)
      }
    }
  }
}
