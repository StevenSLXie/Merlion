#!/usr/bin/env node
const stdoutIsTTY = Boolean(process.stdout?.isTTY)
const noColor = process.env.NO_COLOR === '1' || process.env.NO_COLOR?.toLowerCase() === 'true'
const forceColorRaw = process.env.FORCE_COLOR
const hasForceColor = typeof forceColorRaw === 'string' && forceColorRaw.trim() !== ''

if (stdoutIsTTY && !noColor && !hasForceColor) {
  process.env.FORCE_COLOR = '1'
}

await import('../dist/index.js')
