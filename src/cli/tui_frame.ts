export interface TuiFrameInput {
  width: number
  height: number
  title: string
  subtitle: string
  status: string
  bodyLines: string[]
}

function clip(text: string, maxWidth: number): string {
  if (maxWidth < 1) return ''
  if (text.length <= maxWidth) return text
  if (maxWidth === 1) return '…'
  return `${text.slice(0, maxWidth - 1)}…`
}

function pad(text: string, width: number): string {
  if (text.length >= width) return text
  return `${text}${' '.repeat(width - text.length)}`
}

function normalizeDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.floor(value)))
}

export function createTuiFrame(input: TuiFrameInput): string {
  const width = normalizeDimension(input.width, 70, 240)
  const height = normalizeDimension(input.height, 18, 100)
  const inner = width - 2
  const contentWidth = inner - 2
  const bodyHeight = Math.max(4, height - 7)
  const recent = input.bodyLines.slice(-bodyHeight)
  const body = [...recent]
  while (body.length < bodyHeight) body.push('')

  const lines: string[] = [
    `╔${'═'.repeat(inner)}╗`,
    `║ ${pad(clip(input.title, contentWidth), contentWidth)} ║`,
    `║ ${pad(clip(input.subtitle, contentWidth), contentWidth)} ║`,
    `╠${'═'.repeat(inner)}╣`,
  ]

  for (const line of body) {
    lines.push(`║ ${pad(clip(line, contentWidth), contentWidth)} ║`)
  }

  lines.push(`╠${'═'.repeat(inner)}╣`)
  lines.push(`║ ${pad(clip(input.status, contentWidth), contentWidth)} ║`)
  lines.push(`╚${'═'.repeat(inner)}╝`)
  return lines.join('\n')
}
