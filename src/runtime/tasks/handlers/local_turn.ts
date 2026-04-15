import type { RuntimeTaskHandler } from '../types.ts'
import type { LocalTurnTaskInput, LocalTurnTaskOutput } from '../types.ts'

export const localTurnTaskHandler: RuntimeTaskHandler<LocalTurnTaskInput, LocalTurnTaskOutput> = {
  type: 'local_turn',
  async run(input, ctx) {
    const envelope = input.envelope
    if (envelope.kind === 'empty') {
      return { output: '', terminal: 'completed' }
    }
    if (envelope.kind === 'local_action') {
      if (envelope.action === 'help') {
        return {
          output: 'Commands: :help, :q, :detail full|compact, :wechat (/wechat, login+listen)',
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
    const loopResult = await ctx.engine.submitPrompt(envelope.text)
    return {
      output: loopResult.finalText,
      terminal: loopResult.terminal,
      loopResult,
    }
  },
}
