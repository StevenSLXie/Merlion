import { clipToWidth, padToWidth } from './char_width.ts'

export interface TuiFrameInput {
  width: number
  height: number
  title: string
  subtitle: string
  status: string
  bodyLines: string[]
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
    `║ ${padToWidth(clipToWidth(input.title, contentWidth), contentWidth)} ║`,
    `║ ${padToWidth(clipToWidth(input.subtitle, contentWidth), contentWidth)} ║`,
    `╠${'═'.repeat(inner)}╣`,
  ]

  for (const line of body) {
    lines.push(`║ ${padToWidth(clipToWidth(line, contentWidth), contentWidth)} ║`)
  }

  lines.push(`╠${'═'.repeat(inner)}╣`)
  lines.push(`║ ${padToWidth(clipToWidth(input.status, contentWidth), contentWidth)} ║`)
  lines.push(`╚${'═'.repeat(inner)}╝`)
  return lines.join('\n')
}
