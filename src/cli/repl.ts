export type ReplInput =
  | { kind: 'exit' }
  | { kind: 'help' }
  | { kind: 'empty' }
  | { kind: 'prompt'; prompt: string }

export function parseReplInput(input: string): ReplInput {
  const trimmed = input.trim()
  if (trimmed === '') return { kind: 'empty' }
  if (trimmed === ':q' || trimmed === ':quit' || trimmed === ':exit') return { kind: 'exit' }
  if (trimmed === ':help') return { kind: 'help' }
  return { kind: 'prompt', prompt: trimmed }
}

export interface RunReplSessionOptions {
  readLine: () => Promise<string | null>
  write: (text: string) => void
  runTurn: (prompt: string) => Promise<{ output: string; terminal: string }>
  promptLabel?: string
}

export async function runReplSession(options: RunReplSessionOptions): Promise<void> {
  options.write('REPL started. Commands: :help, :q\n')
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
      options.write('Commands: :help, :q\n')
      continue
    }
    if (parsed.kind === 'empty') continue

    const result = await options.runTurn(parsed.prompt)
    options.write(`${result.output}\n`)
    if (result.terminal !== 'completed') {
      options.write(`[terminal: ${result.terminal}]\n`)
    }
  }
}

