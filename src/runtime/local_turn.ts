import type { RunLoopResult } from './loop.ts'
import type { UserInputEnvelope } from './input/types.ts'
import type { QueryEngine } from './query_engine.ts'

export interface LocalTurnRequest {
  envelope: UserInputEnvelope
  executeSlashCommand: (name: string, raw: string) => Promise<{ output: string; terminal: string }>
  executeShellShortcut: (command: string) => Promise<{ output: string; terminal: string }>
}

export interface LocalTurnResult {
  output: string
  terminal: string
  loopResult?: RunLoopResult
}

export async function executeLocalTurn(
  input: LocalTurnRequest,
  engine: QueryEngine,
): Promise<LocalTurnResult> {
  const envelope = input.envelope
  if (envelope.kind === 'empty') {
    return { output: '', terminal: 'completed' }
  }
  if (envelope.kind === 'local_action') {
    if (envelope.action === 'help') {
      return {
        output: 'Commands: :help, :q, :detail full|compact, :wechat (/wechat, login+listen), :undo (/undo, restore session checkpoint)',
        terminal: 'completed',
      }
    }
    if (envelope.action === 'exit') {
      return { output: 'Bye.', terminal: 'completed' }
    }
    if (envelope.action === 'set_detail') {
      return { output: `[ui] tool detail mode = ${String(envelope.payload)}`, terminal: 'completed' }
    }
  }
  if (envelope.kind === 'shell_shortcut') {
    return await input.executeShellShortcut(envelope.command)
  }
  if (envelope.kind === 'slash_command') {
    return await input.executeSlashCommand(envelope.name, envelope.raw)
  }
  if (envelope.kind !== 'prompt') {
    return { output: '[input] unsupported envelope', terminal: 'model_error' }
  }

  const loopResult = await engine.submitPrompt(envelope.text)
  return {
    output: loopResult.finalText,
    terminal: loopResult.terminal,
    loopResult,
  }
}
