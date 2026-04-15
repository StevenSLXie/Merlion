function splitPromptClauses(prompt: string): string[] {
  return prompt
    .split(/[\n\r]+|(?<=[。！？.!?;；])/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

function normalizeClause(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

const BACKTICK_PATH_RE = /`([^`\n]+\/[^`\n]+)`/g
const BARE_PATH_RE = /(?:^|[\s(])((?:\.{1,2}\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+)(?=$|[\s).,;:])/g

function looksLikeConstraint(text: string): boolean {
  return (
    /(^|[\s，,])(不要|别|勿|不必|先别|只能|仅|只|务必|必须|先)([\s，,]|$)/.test(text) ||
    /\b(don't|do not|avoid|only|just|must|should|first|without)\b/i.test(text)
  )
}

function looksLikeExplicitPath(text: string): boolean {
  const value = text.trim()
  if (value === '') return false
  if (/^https?:\/\//i.test(value)) return false
  if (value.startsWith('~/') || value.startsWith('~\\')) return false
  if (!value.includes('/')) return false
  if (value.includes('{{') || value.includes('}}') || value.includes('${')) return false
  return /^[./A-Za-z0-9_-][A-Za-z0-9._/\-]*$/.test(value)
}

export function extractExplicitTargetPaths(userPrompt: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string) => {
    const normalized = raw.trim().replace(/^[("'`]+|[)"'`.,;:]+$/g, '')
    if (!looksLikeExplicitPath(normalized)) return
    if (seen.has(normalized)) return
    seen.add(normalized)
    out.push(normalized)
  }

  for (const match of userPrompt.matchAll(BACKTICK_PATH_RE)) {
    if (match[1]) push(match[1])
  }
  for (const match of userPrompt.matchAll(BARE_PATH_RE)) {
    if (match[1]) push(match[1])
  }
  return out
}

export function buildIntentContract(userPrompt: string): string | null {
  const trimmed = userPrompt.trim()
  if (trimmed === '') return null

  const clauses = splitPromptClauses(trimmed).map(normalizeClause)
  if (clauses.length === 0) return null

  const objective = clauses[0]!.slice(0, 240)
  const constraints = clauses.filter(looksLikeConstraint).slice(0, 4)
  const explicitPaths = extractExplicitTargetPaths(trimmed).slice(0, 6)

  const lines: string[] = []
  lines.push(`Primary objective: ${objective}`)
  if (constraints.length > 0) {
    lines.push('Explicit constraints from user:')
    for (const item of constraints) {
      lines.push(`- ${item}`)
    }
  }
  if (explicitPaths.length > 0) {
    lines.push('Explicit target paths from user:')
    for (const item of explicitPaths) {
      lines.push(`- ${item}`)
    }
    lines.push(
      'Path-first rule: inspect these paths, or their nearest directories/tests, before any repo-wide recursive exploration.'
    )
  }
  lines.push(
    'Guardrail: stay in scope, keep changes minimal, and ask before destructive or release actions unless explicitly requested by the user.'
  )
  return lines.join('\n')
}
