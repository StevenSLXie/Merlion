import { askLine } from './ask.ts'
import type { SlashCommand } from './commands.ts'
import { formatInlineCompletionPreview, getSlashSuggestions } from './completion.ts'

function sanitizeControlInput(char: string): string {
  return char.replace(/[\u0000-\u001f\u007f]/g, '')
}

function renderLine(output: NodeJS.WriteStream, promptLabel: string, buffer: string, commands: SlashCommand[]): void {
  const preview = buffer.startsWith('/')
    ? formatInlineCompletionPreview(getSlashSuggestions(buffer, commands))
    : ''
  output.write(`\r\x1b[2K${promptLabel}${buffer}${preview}`)
}

export function resolveSubmittedReplInput(buffer: string, commands: SlashCommand[]): string {
  const trimmed = buffer.trim()
  if (!trimmed.startsWith('/')) return buffer
  if (/\s/.test(trimmed.slice(1))) return buffer

  const suggestions = getSlashSuggestions(trimmed, commands)
  if (suggestions.length !== 1) return buffer
  return suggestions[0]!.name
}

export async function readReplInputLine(options: {
  promptLabel: string
  slashCommands: SlashCommand[]
  input?: NodeJS.ReadStream
  output?: NodeJS.WriteStream
}): Promise<string | null> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout

  if (!input.isTTY || typeof input.setRawMode !== 'function' || !output.isTTY) {
    return askLine(options.promptLabel)
  }

  return new Promise((resolve) => {
    let buffer = ''

    const cleanup = (): void => {
      input.off('data', onData)
      input.setRawMode(false)
      output.write('\r\x1b[2K')
    }

    const finish = (value: string | null): void => {
      cleanup()
      if (value !== null) {
        output.write(`${options.promptLabel}${value}\n`)
      } else {
        output.write('\n')
      }
      resolve(value)
    }

    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')

      if (text === '\u0003' || text === '\u0004') {
        finish(null)
        return
      }
      if (text === '\r' || text === '\n') {
        finish(resolveSubmittedReplInput(buffer, options.slashCommands))
        return
      }
      if (text === '\u007f') {
        buffer = buffer.slice(0, -1)
        renderLine(output, options.promptLabel, buffer, options.slashCommands)
        return
      }

      const normalized = sanitizeControlInput(text)
      if (normalized === '') return
      buffer += normalized
      renderLine(output, options.promptLabel, buffer, options.slashCommands)
    }

    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
    renderLine(output, options.promptLabel, buffer, options.slashCommands)
  })
}
