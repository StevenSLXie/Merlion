export interface RecentCommit {
  hash: string
  date: string
  subject: string
}

export interface AgentsAutoSectionInput {
  generatedAt: string
  directory: string
  recentCommits: RecentCommit[]
  recentChangedFiles: string[]
  highChurnFiles: string[]
}

export const MANUAL_BEGIN = '<!-- BEGIN MANUAL -->'
export const MANUAL_END = '<!-- END MANUAL -->'
export const AUTO_BEGIN = '<!-- BEGIN AUTO -->'
export const AUTO_END = '<!-- END AUTO -->'

function normalizeLines(items: string[], fallback: string): string[] {
  const cleaned = items.map((item) => item.trim()).filter(Boolean)
  return cleaned.length > 0 ? cleaned : [fallback]
}

export function renderAgentsAutoSection(input: AgentsAutoSectionInput): string {
  const recentCommits = normalizeLines(
    input.recentCommits.map((item) => `${item.date} ${item.hash} ${item.subject}`),
    '(none)'
  )
  const recentChangedFiles = normalizeLines(input.recentChangedFiles, '(none)')
  const highChurn = normalizeLines(input.highChurnFiles, '(none)')

  const lines: string[] = []
  lines.push(AUTO_BEGIN)
  lines.push('## Subareas')
  lines.push('- (managed by directory AGENTS files)')
  lines.push('')
  lines.push('## EntryPoints')
  lines.push('- (keep in MANUAL if needed)')
  lines.push('')
  lines.push('## RecentChanges')
  lines.push(...recentChangedFiles.map((item) => `- ${item}`))
  lines.push('')
  lines.push('## HighChurnFiles')
  lines.push(...highChurn.map((item) => `- ${item}`))
  lines.push('')
  lines.push('## RecentCommits')
  lines.push(...recentCommits.map((item) => `- ${item}`))
  lines.push('')
  lines.push('## LastUpdated')
  lines.push(`- ${input.generatedAt}`)
  lines.push(`- directory: ${input.directory}`)
  lines.push(AUTO_END)
  lines.push('')
  return lines.join('\n')
}

function replaceSection(content: string, begin: string, end: string, replacement: string): string {
  const start = content.indexOf(begin)
  const finish = content.indexOf(end)
  if (start === -1 || finish === -1 || finish < start) return content
  const endOffset = finish + end.length
  const before = content.slice(0, start)
  const after = content.slice(endOffset)
  const leading = before.endsWith('\n') ? '' : '\n'
  const trailing = after.startsWith('\n') ? '' : '\n'
  return `${before}${leading}${replacement}${trailing}${after.replace(/^\n+/, '\n')}`.replace(/\n{3,}/g, '\n\n')
}

export function ensureAgentsTemplate(content: string): string {
  const hasManual = content.includes(MANUAL_BEGIN) && content.includes(MANUAL_END)
  const hasAuto = content.includes(AUTO_BEGIN) && content.includes(AUTO_END)

  if (hasManual && hasAuto) return content

  const header = content.trim() === '' ? '# AGENTS Guidance\n\n' : `${content.trimEnd()}\n\n`
  const manualBlock = [
    MANUAL_BEGIN,
    '## Purpose',
    '- Describe this directory scope and boundaries.',
    '',
    '## Key Files / Entry Points',
    '- Add stable entry points for this directory.',
    '',
    '## Local Constraints',
    '- Add non-obvious constraints and compatibility notes.',
    MANUAL_END,
    ''
  ].join('\n')

  const autoBlock = [
    AUTO_BEGIN,
    '## Subareas',
    '- (none)',
    '',
    '## EntryPoints',
    '- (none)',
    '',
    '## RecentChanges',
    '- (none)',
    '',
    '## HighChurnFiles',
    '- (none)',
    '',
    '## RecentCommits',
    '- (none)',
    '',
    '## LastUpdated',
    '- (never)',
    AUTO_END,
    ''
  ].join('\n')

  return `${header}${manualBlock}${autoBlock}`
}

export function upsertAgentsAutoSection(content: string, autoSection: string): string {
  const ensured = ensureAgentsTemplate(content)
  if (!(ensured.includes(AUTO_BEGIN) && ensured.includes(AUTO_END))) {
    return `${ensured.trimEnd()}\n\n${autoSection.trim()}\n`
  }
  return replaceSection(ensured, AUTO_BEGIN, AUTO_END, autoSection.trim())
}

export function validateAgentsSections(content: string): { ok: true } | { ok: false; reason: string } {
  const manualStart = content.indexOf(MANUAL_BEGIN)
  const manualEnd = content.indexOf(MANUAL_END)
  const autoStart = content.indexOf(AUTO_BEGIN)
  const autoEnd = content.indexOf(AUTO_END)

  if (manualStart === -1 || manualEnd === -1) {
    return { ok: false, reason: 'Missing MANUAL section markers.' }
  }
  if (autoStart === -1 || autoEnd === -1) {
    return { ok: false, reason: 'Missing AUTO section markers.' }
  }
  if (manualEnd < manualStart) {
    return { ok: false, reason: 'MANUAL markers are out of order.' }
  }
  if (autoEnd < autoStart) {
    return { ok: false, reason: 'AUTO markers are out of order.' }
  }
  if (manualStart > autoStart) {
    return { ok: false, reason: 'MANUAL section must appear before AUTO section.' }
  }
  return { ok: true }
}
