function splitPromptClauses(prompt: string): string[] {
  return prompt
    .split(/[\n\r]+|(?<=[。！？.!?;；])/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

function normalizeClause(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function looksLikeConstraint(text: string): boolean {
  return (
    /(^|[\s，,])(不要|别|勿|不必|先别|只能|仅|只|务必|必须|先)([\s，,]|$)/.test(text) ||
    /\b(don't|do not|avoid|only|just|must|should|first|without)\b/i.test(text)
  )
}

export function buildIntentContract(userPrompt: string): string | null {
  const trimmed = userPrompt.trim()
  if (trimmed === '') return null

  const clauses = splitPromptClauses(trimmed).map(normalizeClause)
  if (clauses.length === 0) return null

  const objective = clauses[0]!.slice(0, 240)
  const constraints = clauses.filter(looksLikeConstraint).slice(0, 4)

  const lines: string[] = []
  lines.push(`Primary objective: ${objective}`)
  if (constraints.length > 0) {
    lines.push('Explicit constraints from user:')
    for (const item of constraints) {
      lines.push(`- ${item}`)
    }
  }
  lines.push(
    'Guardrail: stay in scope, keep changes minimal, and ask before destructive or release actions unless explicitly requested by the user.'
  )
  return lines.join('\n')
}

