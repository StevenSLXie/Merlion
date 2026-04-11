export type ReplInput =
  | { kind: 'exit' }
  | { kind: 'help' }
  | { kind: 'empty' }
  | { kind: 'set_detail'; mode: 'full' | 'compact' }
  | { kind: 'prompt'; prompt: string }

export function parseReplInput(input: string): ReplInput {
  const trimmed = input.trim()
  if (trimmed === '') return { kind: 'empty' }
  if (trimmed === ':q' || trimmed === ':quit' || trimmed === ':exit') return { kind: 'exit' }
  if (trimmed === ':help') return { kind: 'help' }
  const detailMatch = trimmed.match(/^:detail\s+(full|compact)$/i)
  if (detailMatch) {
    return { kind: 'set_detail', mode: detailMatch[1]!.toLowerCase() as 'full' | 'compact' }
  }
  return { kind: 'prompt', prompt: trimmed }
}

export interface RunReplSessionOptions {
  readLine: () => Promise<string | null>
  write: (text: string) => void
  runTurn: (prompt: string) => Promise<{ output: string; terminal: string }>
  promptLabel?: string
  startupMessage?: string | false
  onPromptSubmitted?: (prompt: string) => Promise<void> | void
  onTurnResult?: (
    result: { output: string; terminal: string },
    prompt: string
  ) => Promise<void> | void
  onSetDetailMode?: (mode: 'full' | 'compact') => Promise<void> | void
}

export async function runReplSession(options: RunReplSessionOptions): Promise<void> {
  if (options.startupMessage !== false) {
    options.write(options.startupMessage ?? 'REPL started. Commands: :help, :q, :detail full|compact\n')
  }
  const promptLabel = options.promptLabel ?? 'merlion> '

  for (;;) {
    options.write(promptLabel)
    const line = await options.readLine()
    if (line === null) break

    const parsed = parseReplInput(line)
    if (parsed.kind === 'exit') {
      options.write('Bye.\n')
      break
    }
    if (parsed.kind === 'help') {
      options.write('Commands: :help, :q, :detail full|compact\n')
      continue
    }
    if (parsed.kind === 'set_detail') {
      await options.onSetDetailMode?.(parsed.mode)
      options.write(`[ui] tool detail mode = ${parsed.mode}\n`)
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
