import type { TaskRequiredEvidence, TaskState } from './task_state.ts'

export interface CorrectionDetection {
  inheritedObjective: string
  objective: string
  deliverable?: string
  requiredEvidence?: TaskRequiredEvidence
  notes: string[]
}

const CORRECTION_PATTERNS: RegExp[] = [
  /\b(?:you (?:did not|didn't|haven't|have not)|you missed|not what i asked|i asked|i mean|i meant|i'm asking|i am asking|focus on|the point is)\b/i,
  /(你没有回答|不是这个意思|我问的是|重点是|我的问题是|结合整个项目|整个项目维度|不要继续解释|直接回答)/,
]

const WHOLE_PROJECT_PATTERNS: RegExp[] = [
  /\b(?:whole|entire)\s+(?:project|repo|repository|codebase)\b/i,
  /\bproject-wide\b/i,
  /(整个项目|整个仓库|全仓|项目维度|仓库维度|全局)/,
]

const DIRECT_ANSWER_PATTERNS: RegExp[] = [
  /\b(?:answer directly|just answer|don't keep explaining|stop explaining)\b/i,
  /(直接回答|不要继续解释|别继续解释|直接说结论)/,
]

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function tightenDeliverable(deliverable: string): string {
  if (/\bdirect/i.test(deliverable)) return deliverable
  return `${deliverable} Answer directly instead of discussing the misunderstanding.`
}

function rewriteWholeProjectObjective(previousObjective: string): string {
  const trimmed = normalizeWhitespace(previousObjective)
  if (trimmed === '') return 'Re-evaluate the original request across the whole repository.'
  if (/whole repository/i.test(trimmed) || /整个仓库|全仓/.test(trimmed)) return trimmed
  return `Re-evaluate the original request across the whole repository: ${trimmed}`
}

function extractCorrectedObjective(prompt: string): string | null {
  const englishMatch = prompt.match(/\b(?:i asked|i mean|i meant|i'm asking|i am asking|focus on|the point is)\s+(?:for|about)?\s*([^.!?\n]+)/i)
  if (englishMatch?.[1]) {
    const candidate = normalizeWhitespace(englishMatch[1])
    if (candidate !== '') return candidate
  }

  const chineseMatch = prompt.match(/(?:我问的是|我的问题是|重点是)\s*([^。！？\n]+)/)
  if (chineseMatch?.[1]) {
    const candidate = normalizeWhitespace(chineseMatch[1])
    if (candidate !== '') return candidate
  }

  return null
}

function looksLikeCorrection(prompt: string): boolean {
  const trimmed = prompt.trim()
  return trimmed !== '' && CORRECTION_PATTERNS.some((pattern) => pattern.test(trimmed))
}

export function detectCorrection(prompt: string, previousTask?: TaskState | null): CorrectionDetection | null {
  if (!previousTask || !looksLikeCorrection(prompt)) return null

  const notes: string[] = []
  let objective = previousTask.activeObjective
  let deliverable = previousTask.expectedDeliverable
  let requiredEvidence: TaskRequiredEvidence | undefined

  const explicitObjective = extractCorrectedObjective(prompt)
  if (explicitObjective) {
    objective = explicitObjective
    notes.push('User explicitly corrected the task objective.')
  }

  if (WHOLE_PROJECT_PATTERNS.some((pattern) => pattern.test(prompt))) {
    objective = rewriteWholeProjectObjective(previousTask.activeObjective)
    requiredEvidence = previousTask.requiredEvidence === 'light' ? 'codebacked' : previousTask.requiredEvidence
    notes.push('Evidence scope widened to the whole repository.')
  }

  if (DIRECT_ANSWER_PATTERNS.some((pattern) => pattern.test(prompt))) {
    deliverable = tightenDeliverable(deliverable)
    notes.push('Respond directly instead of debating the misunderstanding.')
  }

  if (notes.length === 0 && explicitObjective === null) {
    notes.push('User corrected the previous task framing.')
  }

  return {
    inheritedObjective: previousTask.activeObjective,
    objective,
    deliverable,
    requiredEvidence,
    notes,
  }
}
