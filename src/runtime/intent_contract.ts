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
const BUGFIX_PROMPT_PATTERNS: RegExp[] = [
  /\b(bug|buggy|fix|broken|failing|failure|regression|error|traceback|exception|repair|patch)\b/i,
  /(修复|缺陷|报错|异常|失败|回归|补丁)/,
]
const TEST_EDIT_REQUEST_PATTERNS: RegExp[] = [
  /\b(add|write|create|update|edit|adjust|rewrite|refactor|migrate|fix)\b[\s\S]{0,40}\b(test|tests|spec|specs|unit test|integration test|pytest|jest|vitest|mocha)\b/i,
  /\b(test|tests|spec|specs|unit test|integration test|pytest|jest|vitest|mocha)\b[\s\S]{0,40}\b(add|write|create|update|edit|adjust|rewrite|refactor|migrate|fix)\b/i,
  /(新增|添加|补|写|更新|修改|修复|重写|重构|迁移)[\s\S]{0,20}(测试|用例|单测|集成测试|spec)/,
  /(测试|用例|单测|集成测试|spec)[\s\S]{0,20}(新增|添加|补|写|更新|修改|修复|重写|重构|迁移)/,
]

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

function looksLikeTestPath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  return (
    normalized.includes('/test/') ||
    normalized.includes('/tests/') ||
    normalized.includes('/spec/') ||
    normalized.includes('/specs/') ||
    /(?:^|\/)test_[^/]+\.[a-z0-9]+$/i.test(normalized) ||
    /(?:^|\/)[^/]+_test\.[a-z0-9]+$/i.test(normalized) ||
    /(?:^|\/)[^/]+(?:\.test|\.spec)\.[a-z0-9]+$/i.test(normalized)
  )
}

export function isExplicitTestEditRequest(userPrompt: string): boolean {
  const trimmed = userPrompt.trim()
  if (trimmed === '') return false
  if (TEST_EDIT_REQUEST_PATTERNS.some((pattern) => pattern.test(trimmed))) {
    return true
  }
  return extractExplicitTargetPaths(trimmed).some(looksLikeTestPath)
}

export function isBugFixPrompt(userPrompt: string): boolean {
  const trimmed = userPrompt.trim()
  if (trimmed === '') return false
  if (isExplicitTestEditRequest(trimmed)) return false
  return BUGFIX_PROMPT_PATTERNS.some((pattern) => pattern.test(trimmed))
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
  if (isBugFixPrompt(trimmed)) {
    lines.push('Bug-fix guidance:')
    lines.push('- Treat failing tests, error logs, and reproduction steps as specification for expected behavior.')
    lines.push('- Inspect the nearest implementation/source files before broad edits or broad mutation attempts.')
    lines.push('- Prefer implementation/source changes before editing tests.')
    lines.push('- Only edit tests first when the user explicitly requests test changes or strong evidence shows the tests are wrong.')
  }
  lines.push(
    'Guardrail: stay in scope, keep changes minimal, and ask before destructive or release actions unless explicitly requested by the user.'
  )
  return lines.join('\n')
}
