import { sanitizeRenderableText } from './sanitize.ts'
import type { UsageSnapshot } from '../runtime/usage.ts'
import { renderEditDiffLines, summarizeEditDiff } from './diff.ts'
import { buildAssistantRenderPlan, type MessageTone } from './message_content.ts'
import { formatCliStatusLine } from './status.ts'
import { createTuiFrame } from './tui_frame.ts'
import type { ToolUiPayload } from '../tools/types.ts'

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

interface CliExperienceOptions {
  model: string
  sessionId: string
  isRepl: boolean
}

interface ColorSet {
  reset: string
  dim: string
  bold: string
  cyan: string
  blue: string
  magenta: string
  green: string
  red: string
  yellow: string
}

function createColors(enabled: boolean): ColorSet {
  if (!enabled) {
    return {
      reset: '',
      dim: '',
      bold: '',
      cyan: '',
      blue: '',
      magenta: '',
      green: '',
      red: '',
      yellow: '',
    }
  }
  return {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    cyan: '\x1b[36m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
  }
}

function plainLength(text: string): number {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '').length
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
}

function padRight(text: string, length: number): string {
  const visible = plainLength(text)
  if (visible >= length) return text
  return `${text}${' '.repeat(length - visible)}`
}

function wrapLine(line: string, width: number): string[] {
  const normalized = line.trim()
  if (normalized === '') return ['']
  if (normalized.length <= width) return [normalized]

  const words = normalized.split(/\s+/)
  const lines: string[] = []
  let current = ''

  for (const word of words) {
    if (current === '') {
      if (word.length <= width) {
        current = word
        continue
      }
      for (let i = 0; i < word.length; i += width) {
        lines.push(word.slice(i, i + width))
      }
      continue
    }

    if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`
      continue
    }

    lines.push(current)
    if (word.length <= width) {
      current = word
      continue
    }
    for (let i = 0; i < word.length; i += width) {
      const chunk = word.slice(i, i + width)
      if (chunk.length < width) {
        current = chunk
      } else {
        lines.push(chunk)
        current = ''
      }
    }
  }

  if (current !== '') lines.push(current)
  return lines
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = []
  for (const rawLine of text.split('\n')) {
    for (const line of wrapLine(rawLine, width)) {
      lines.push(line)
    }
  }
  return lines.length > 0 ? lines : ['']
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw || raw.trim() === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  const value = Math.floor(parsed)
  return value > 0 ? value : fallback
}

function clipText(text: string, maxChars: number): string {
  if (maxChars < 1) return ''
  if (text.length <= maxChars) return text
  if (maxChars === 1) return '…'
  return `${text.slice(0, maxChars - 1)}…`
}

export class CliExperience {
  private readonly useColor: boolean
  private readonly colors: ColorSet
  private readonly options: CliExperienceOptions
  private readonly tuiEnabled: boolean
  private spinnerTimer: NodeJS.Timeout | null = null
  private spinnerFrame = 0
  private spinnerText = ''
  private spinnerWidth = 0
  private readonly maxDiffLines: number
  private readonly markdownEnabled: boolean
  private toolDetailMode: 'full' | 'compact'
  private readonly tuiLogLines: string[] = []
  private tuiStatusLine = 'ready'

  constructor(options: CliExperienceOptions) {
    this.options = options
    const interactiveTty = Boolean(process.stdout.isTTY) && process.env.TERM !== 'dumb'
    this.tuiEnabled =
      interactiveTty &&
      !options.isRepl &&
      process.env.MERLION_CLI_TUI === '1'
    this.useColor =
      interactiveTty &&
      process.env.NO_COLOR !== '1' &&
      !this.tuiEnabled
    this.colors = createColors(this.useColor)
    this.maxDiffLines = parsePositiveInt(process.env.MERLION_CLI_DIFF_MAX_LINES, 120)
    this.markdownEnabled = process.env.MERLION_CLI_MARKDOWN !== '0'
    this.toolDetailMode = process.env.MERLION_CLI_TOOL_DETAIL === 'compact' ? 'compact' : 'full'
  }

  private c(code: keyof ColorSet, text: string): string {
    const prefix = this.colors[code]
    if (!prefix) return text
    return `${prefix}${text}${this.colors.reset}`
  }

  private getWidth(): number {
    const width = Number(process.stdout.columns ?? 100)
    if (!Number.isFinite(width) || width < 70) return 70
    return Math.min(140, width)
  }

  private getHeight(): number {
    const height = Number(process.stdout.rows ?? 32)
    if (!Number.isFinite(height) || height < 18) return 24
    return Math.min(60, height)
  }

  private clearSpinnerLine(): void {
    if (this.tuiEnabled) return
    if (!this.spinnerTimer) return
    process.stdout.write('\r\x1b[2K')
    this.spinnerWidth = 0
  }

  private printRawLine(text = ''): void {
    if (this.tuiEnabled) {
      const clean = sanitizeRenderableText(stripAnsi(text))
      const lines = clean.split('\n')
      for (const line of lines) this.tuiLogLines.push(line)
      const maxLines = 800
      if (this.tuiLogLines.length > maxLines) {
        this.tuiLogLines.splice(0, this.tuiLogLines.length - maxLines)
      }
      this.renderTuiFrame()
      return
    }
    this.clearSpinnerLine()
    process.stdout.write(`${text}\n`)
  }

  private renderTuiFrame(): void {
    if (!this.tuiEnabled) return
    const frame = createTuiFrame({
      width: this.getWidth(),
      height: this.getHeight(),
      title: 'MERLION COMMAND CONSOLE',
      subtitle: `model ${this.options.model} · session ${this.options.sessionId.slice(0, 8)} · mode=one-shot`,
      status: this.tuiStatusLine,
      bodyLines: this.tuiLogLines
    })
    process.stdout.write('\x1b[2J\x1b[H')
    process.stdout.write(`${frame}\n`)
  }

  private printCard(title: string, body: string, tone: 'info' | 'success' | 'warn' | 'error' = 'info'): void {
    const width = this.getWidth()
    const innerWidth = Math.max(20, width - 8)
    const top = `┌─ ${title}`
    const prefix = tone === 'success'
      ? this.c('green', '│ ')
      : tone === 'warn'
        ? this.c('yellow', '│ ')
        : tone === 'error'
          ? this.c('red', '│ ')
          : this.c('blue', '│ ')
    const lines = wrapText(sanitizeRenderableText(body), innerWidth)

    this.printRawLine(this.c('bold', top))
    for (const line of lines) {
      this.printRawLine(`${prefix}${line}`)
    }
    this.printRawLine(this.c('dim', '└─'))
  }

  private colorForMessageTone(tone: MessageTone): keyof ColorSet | null {
    if (tone === 'heading') return 'cyan'
    if (tone === 'list') return 'yellow'
    if (tone === 'quote') return 'dim'
    if (tone === 'code_meta') return 'yellow'
    if (tone === 'code') return 'cyan'
    if (tone === 'rule') return 'dim'
    if (tone === 'table') return 'magenta'
    return null
  }

  private printAssistantCard(title: string, output: string, tone: 'info' | 'success' | 'warn' | 'error'): void {
    const width = this.getWidth()
    const innerWidth = Math.max(20, width - 8)
    const prefix = tone === 'success'
      ? this.c('green', '│ ')
      : tone === 'warn'
        ? this.c('yellow', '│ ')
        : tone === 'error'
          ? this.c('red', '│ ')
          : this.c('blue', '│ ')
    const plan = buildAssistantRenderPlan(output, { markdownEnabled: this.markdownEnabled })
    this.printRawLine(this.c('bold', `┌─ ${title}`))
    for (const line of plan.lines) {
      const clipped = clipText(line.text, innerWidth)
      if (clipped === '') {
        this.printRawLine(prefix)
        continue
      }
      const colorCode = this.colorForMessageTone(line.tone)
      if (line.tone === 'heading') {
        const text = colorCode ? this.c(colorCode, clipped) : clipped
        this.printRawLine(`${prefix}${this.c('bold', text)}`)
        continue
      }
      if (line.tone === 'code_meta') {
        const text = colorCode ? this.c(colorCode, clipped) : clipped
        this.printRawLine(`${prefix}${this.c('bold', text)}`)
        continue
      }
      if (!colorCode) {
        this.printRawLine(`${prefix}${clipped}`)
        continue
      }
      this.printRawLine(`${prefix}${this.c(colorCode, clipped)}`)
    }
    this.printRawLine(this.c('dim', '└─'))
  }

  private summarizeArgs(raw?: string): string {
    if (!raw || raw.trim() === '') return ''
    const compactRaw = sanitizeRenderableText(raw.replace(/\s+/g, ' ').trim())
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const parts = Object.keys(parsed).slice(0, 2).map((key) => {
        const value = parsed[key]
        if (typeof value === 'string') {
          const compact = sanitizeRenderableText(value.replace(/\s+/g, ' ').trim())
          return `${key}=${compact.length > 28 ? `${compact.slice(0, 28)}...` : compact}`
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
          return `${key}=${String(value)}`
        }
        return `${key}=...`
      })
      return parts.join(', ')
    } catch {
      return compactRaw.length > 60 ? `${compactRaw.slice(0, 60)}...` : compactRaw
    }
  }

  renderBanner(): void {
    if (this.tuiEnabled) {
      this.tuiStatusLine = 'ready'
      this.renderTuiFrame()
      return
    }
    const width = this.getWidth()
    const edge = '═'.repeat(Math.max(20, width - 2))
    const title = this.c('bold', 'MERLION COMMAND CONSOLE')
    const subtitle = `${this.c('dim', 'model')} ${this.c('cyan', this.options.model)}  ${this.c('dim', 'session')} ${this.options.sessionId.slice(0, 8)}`
    const mode = this.options.isRepl ? 'interactive' : 'one-shot'

    this.printRawLine(this.c('magenta', `╔${edge}╗`))
    this.printRawLine(this.c('magenta', '║') + ` ${title}`)
    this.printRawLine(this.c('magenta', '║') + ` ${subtitle}  ${this.c('dim', `mode=${mode}`)}`)
    this.printRawLine(this.c('magenta', `╚${edge}╝`))
    if (this.options.isRepl) {
      this.printRawLine(this.c('dim', 'Commands: :help, :q, :detail full|compact'))
    }
  }

  promptLabel(): string {
    return `${this.c('cyan', '❯')} `
  }

  renderUserPrompt(prompt: string): void {
    this.printCard('YOU', prompt, 'info')
  }

  clearTypedInputLine(): void {
    if (this.tuiEnabled) return
    if (!process.stdout.isTTY) return
    this.stopSpinner()
    process.stdout.write('\r\x1b[2K\x1b[1A\r\x1b[2K')
  }

  renderAssistantOutput(output: string, terminal: string): void {
    const tone = terminal === 'completed' ? 'success' : 'warn'
    this.printAssistantCard('MERLION', output, tone)
    if (terminal !== 'completed') {
      this.printRawLine(this.c('yellow', `terminal state: ${terminal}`))
    }
  }

  private startSpinner(text: string): void {
    if (this.tuiEnabled) {
      this.tuiStatusLine = sanitizeRenderableText(text)
      this.renderTuiFrame()
      return
    }
    this.stopSpinner()
    this.spinnerText = sanitizeRenderableText(text)
    if (!process.stdout.isTTY) {
      this.printRawLine(this.c('dim', this.spinnerText))
      return
    }
    const tick = () => {
      const frame = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length]!
      this.spinnerFrame += 1
      const raw = `${this.c('cyan', frame)} ${this.c('dim', this.spinnerText)}`
      const width = Math.max(this.spinnerWidth, plainLength(raw))
      this.spinnerWidth = width
      process.stdout.write(`\r${padRight(raw, width)}`)
    }
    tick()
    this.spinnerTimer = setInterval(tick, 90)
  }

  stopSpinner(): void {
    if (this.tuiEnabled) return
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer)
      this.spinnerTimer = null
    }
    if (process.stdout.isTTY) {
      process.stdout.write('\r\x1b[2K')
    }
    this.spinnerWidth = 0
  }

  onTurnStart(event: { turn: number }): void {
    this.startSpinner(`thinking (turn ${event.turn})`)
  }

  onAssistantResponse(event: { turn: number; finish_reason: string; tool_calls_count: number }): void {
    this.stopSpinner()
    if (event.finish_reason === 'tool_calls') {
      this.tuiStatusLine = `turn ${event.turn} · queued ${event.tool_calls_count} tool call(s)`
      this.printRawLine(
        this.c('dim', `[turn ${event.turn}] assistant queued ${event.tool_calls_count} tool call(s)`)
      )
      return
    }
    this.tuiStatusLine = `turn ${event.turn} · finish=${event.finish_reason}`
    this.printRawLine(this.c('dim', `[turn ${event.turn}] assistant finish=${event.finish_reason}`))
  }

  onToolStart(event: { index: number; total: number; name: string; summary?: string }): void {
    const summaryText = this.summarizeArgs(event.summary)
    const summary = summaryText !== '' ? ` · ${summaryText}` : ''
    this.printRawLine(
      `${this.c('blue', '●')} ${this.c('bold', `[tool ${event.index}/${event.total}]`)} ${event.name}${this.c('dim', summary)}`
    )
  }

  onToolResult(event: { index: number; total: number; name: string; durationMs: number; isError: boolean; uiPayload?: ToolUiPayload }): void {
    const icon = event.isError ? this.c('red', '✖') : this.c('green', '✔')
    const status = event.isError ? this.c('red', 'error') : this.c('green', 'ok')
    this.printRawLine(
      `${icon} ${this.c('bold', `[tool ${event.index}/${event.total}]`)} ${event.name} ${status} ${this.c('dim', `${event.durationMs}ms`)}`
    )
    this.renderToolUiPayload(event.uiPayload)
  }

  private renderToolUiPayload(payload: ToolUiPayload | undefined): void {
    if (!payload) return
    if (payload.kind === 'edit_diff') {
      const width = this.getWidth()
      const innerWidth = Math.max(20, width - 8)
      const lines = this.toolDetailMode === 'compact'
        ? summarizeEditDiff(payload)
        : renderEditDiffLines(payload, {
            maxLines: this.maxDiffLines,
            maxCharsPerLine: innerWidth
          })
      this.printRawLine(this.c('bold', '┌─ EDIT DIFF'))
      for (const line of lines) {
        const tone = line.tone === 'add'
          ? 'green'
          : line.tone === 'remove'
            ? 'red'
            : line.tone === 'meta'
              ? 'yellow'
              : 'dim'
        this.printRawLine(`${this.c('blue', '│ ')}${this.c(tone, line.text)}`)
      }
      this.printRawLine(this.c('dim', '└─'))
    }
  }

  onUsage(snapshot: UsageSnapshot, estimatedCost?: number): void {
    const line = formatCliStatusLine(snapshot, estimatedCost)
    if (this.tuiEnabled) {
      this.tuiStatusLine = line
      this.renderTuiFrame()
      return
    }
    this.printRawLine(this.c('dim', line))
  }

  setToolDetailMode(mode: 'full' | 'compact'): void {
    this.toolDetailMode = mode
    if (this.tuiEnabled) {
      this.tuiStatusLine = `ui · tool detail mode=${mode}`
      this.renderTuiFrame()
    }
  }
}
