import type { SubagentRole } from './subagent_types.ts'
import { extractExplicitTargetPaths } from './intent_contract.ts'
import { detectCorrection } from './correction.ts'

export type TaskKind =
  | 'question'
  | 'analysis'
  | 'review'
  | 'implementation'
  | 'verification'
  | 'meta_correction'

export type TaskRequiredEvidence = 'light' | 'codebacked' | 'diffbacked' | 'verified'

export interface TaskState {
  kind: TaskKind
  activeObjective: string
  expectedDeliverable: string
  mayMutateFiles: boolean
  requiredEvidence: TaskRequiredEvidence
  reviewScope?: 'last_turn' | 'working_tree' | 'branch'
  correctionOfPreviousTurn: boolean
  replacesPreviousObjective: boolean
  inheritedObjective?: string
  explicitPaths: string[]
  openQuestions: string[]
  correctionNotes?: string[]
}

export type CapabilityProfileName =
  | 'readonly_question'
  | 'readonly_analysis'
  | 'readonly_review'
  | 'verification_readonly'
  | 'implementation_scoped'
  | 'meta_control'

export interface MutationPolicy {
  mayMutateFiles: boolean
  mayRunDestructiveShell: boolean
  writableScopes?: string[]
  reason: string
}

export interface TaskControlDecision {
  taskState: TaskState
  capabilityProfile: CapabilityProfileName
  mutationPolicy: MutationPolicy
}

export type SchemaChangeReason =
  | 'initial_epoch'
  | 'user_correction'
  | 'phase_switch'
  | 'resume_rehydration'
  | 'safety_override'

export interface CapabilityProfileEpochResolution {
  capabilityProfile: CapabilityProfileName
  schemaChangeReason: SchemaChangeReason | null
}

const IMPLEMENTATION_PATTERNS: RegExp[] = [
  /\b(?:fix|implement|add|create|update|modify|change|refactor|patch|write|edit|rename|remove|delete)\b/i,
  /(修复|实现|新增|添加|创建|更新|修改|改成|重构|补上|删除)/,
]

const REVIEW_PATTERNS: RegExp[] = [
  /\b(?:code review|review (?:this|the|my)?\s*(?:diff|change|changes|patch|pr)?|audit this diff)\b/i,
  /(代码评审|代码审查|评审|审查|看改动|看一下 diff|review)/i,
]

const VERIFICATION_PATTERNS: RegExp[] = [
  /\b(?:verify|verification|validate|validation|double-check|recheck|confirm|check(?: for regressions)?|run tests?)\b/i,
  /(验证|复核|复查|确认|检查|回归测试|跑测试)/,
]

const ANALYSIS_PATTERNS: RegExp[] = [
  /\b(?:analy[sz]e|analysis|evaluate|assessment|assess|compare|trade-?off|strength|weakness|pros? and cons?|drawback|risk|audit|summari[sz]e)\b/i,
  /(分析|调研|评估|比较|优缺点|缺点|风险|总结|怎么看|评价)/,
]

const QUESTION_PATTERNS: RegExp[] = [
  /\b(?:what|why|how|which|when|where|explain|help me understand)\b/i,
  /(什么|为什么|怎么|如何|解释|介绍|说明)/,
]

const EXPLICIT_PHASE_SWITCH_PATTERNS: RegExp[] = [
  /\b(?:instead|switch|move on|phase|step|for this turn|for this phase|review\b|verify\b|implement\b|fix\b)\b/i,
  /(改为|切换|转到|这一轮|这个阶段|评审|验证|实现|修复)/,
]

const WHOLE_PROJECT_PATTERNS: RegExp[] = [
  /\b(?:whole|entire)\s+(?:project|repo|repository|codebase)\b/i,
  /(整个项目|整个仓库|全仓|项目维度|仓库维度|全局)/,
]

const READ_ONLY_SHELL_BLOCKLIST: RegExp[] = [
  /\btouch\b/i,
  /\bmkdir\b/i,
  /\brm\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\binstall\b/i,
  /\btee\b/i,
  /(^|[^>])>(?!>)/,
  /\bgit\s+(?:add|commit|push|checkout|switch|restore|reset|clean)\b/i,
  /\bsed\s+-i\b/i,
  /\bperl\s+-i\b/i,
]

const SAFE_READONLY_SCRIPT_PATTERN = /\b(?:test|tests|lint|check|verify|validation|typecheck|ci)\b/i

const PROFILE_SUBAGENT_ROLES: Record<CapabilityProfileName, SubagentRole[]> = {
  readonly_question: [],
  readonly_analysis: ['explorer', 'verifier'],
  readonly_review: ['explorer', 'verifier'],
  verification_readonly: ['explorer', 'verifier'],
  implementation_scoped: ['explorer', 'worker', 'verifier'],
  meta_control: [],
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function firstSentence(prompt: string): string {
  const trimmed = prompt.trim()
  if (trimmed === '') return ''
  const split = trimmed.split(/[\n\r]+|(?<=[。！？.!?;；])/).map((part) => normalizeWhitespace(part)).filter(Boolean)
  return (split[0] ?? trimmed).slice(0, 240)
}

function classifyTaskKind(prompt: string): TaskKind {
  const trimmed = prompt.trim()
  if (trimmed === '') return 'question'
  if (REVIEW_PATTERNS.some((pattern) => pattern.test(trimmed))) return 'review'
  if (VERIFICATION_PATTERNS.some((pattern) => pattern.test(trimmed))) return 'verification'
  if (IMPLEMENTATION_PATTERNS.some((pattern) => pattern.test(trimmed))) return 'implementation'
  if (ANALYSIS_PATTERNS.some((pattern) => pattern.test(trimmed))) return 'analysis'
  if (QUESTION_PATTERNS.some((pattern) => pattern.test(trimmed))) return 'question'
  return 'question'
}

function defaultDeliverable(kind: TaskKind): string {
  switch (kind) {
    case 'analysis':
      return 'Provide a code-backed analysis. Do not change files.'
    case 'review':
      return 'Provide findings first, with concrete file references when possible. Do not change files.'
    case 'implementation':
      return 'Implement the requested change with minimal necessary edits and verification.'
    case 'verification':
      return 'Run verification and report what passed, failed, or remains unverified. Do not implement fixes.'
    case 'meta_correction':
      return 'Reframe the task correctly before proceeding.'
    case 'question':
    default:
      return 'Answer the question directly and stay read-only.'
  }
}

function defaultEvidence(kind: TaskKind): TaskRequiredEvidence {
  switch (kind) {
    case 'analysis':
    case 'implementation':
      return 'codebacked'
    case 'review':
      return 'diffbacked'
    case 'verification':
      return 'verified'
    case 'meta_correction':
      return 'light'
    case 'question':
    default:
      return 'light'
  }
}

function detectReviewScope(prompt: string): TaskState['reviewScope'] {
  if (/\bbranch\b/i.test(prompt) || /(分支|branch)/i.test(prompt)) return 'branch'
  if (/\bworking tree\b/i.test(prompt) || /(工作区|未提交)/.test(prompt)) return 'working_tree'
  return 'last_turn'
}

function mayMutate(kind: TaskKind): boolean {
  return kind === 'implementation'
}

function mutationReason(kind: TaskKind): string {
  return kind === 'implementation'
    ? 'Implementation tasks may mutate files within sandbox policy.'
    : `${kind} tasks are runtime-enforced read-only by default.`
}

export function selectCapabilityProfile(taskState: TaskState): CapabilityProfileName {
  switch (taskState.kind) {
    case 'analysis':
      return 'readonly_analysis'
    case 'review':
      return 'readonly_review'
    case 'verification':
      return 'verification_readonly'
    case 'implementation':
      return 'implementation_scoped'
    case 'meta_correction':
      return 'meta_control'
    case 'question':
    default:
      return 'readonly_question'
  }
}

export function buildMutationPolicy(taskState: TaskState): MutationPolicy {
  if (taskState.kind === 'implementation') {
    return {
      mayMutateFiles: true,
      mayRunDestructiveShell: true,
      writableScopes: taskState.explicitPaths.length > 0 ? [...taskState.explicitPaths] : undefined,
      reason: mutationReason(taskState.kind),
    }
  }

  if (taskState.kind === 'verification') {
    return {
      mayMutateFiles: false,
      mayRunDestructiveShell: false,
      reason: mutationReason(taskState.kind),
    }
  }

  return {
    mayMutateFiles: false,
    mayRunDestructiveShell: false,
    reason: mutationReason(taskState.kind),
  }
}

function baseTaskState(prompt: string): TaskState {
  const kind = classifyTaskKind(prompt)
  const objective = firstSentence(prompt)
  return {
    kind,
    activeObjective: objective === '' ? 'Answer the user request.' : objective,
    expectedDeliverable: defaultDeliverable(kind),
    mayMutateFiles: mayMutate(kind),
    requiredEvidence: WHOLE_PROJECT_PATTERNS.some((pattern) => pattern.test(prompt)) && kind === 'question'
      ? 'codebacked'
      : defaultEvidence(kind),
    reviewScope: kind === 'review' ? detectReviewScope(prompt) : undefined,
    correctionOfPreviousTurn: false,
    replacesPreviousObjective: false,
    explicitPaths: extractExplicitTargetPaths(prompt).slice(0, 8),
    openQuestions: [],
  }
}

export function deriveTaskState(prompt: string, previousTask?: TaskState | null): TaskState {
  const correction = detectCorrection(prompt, previousTask)
  if (correction && previousTask) {
    const correctedKind = classifyTaskKind(prompt)
    const nextKind = correctedKind !== 'question' ? correctedKind : previousTask.kind
    return {
      ...previousTask,
      kind: nextKind,
      activeObjective: correction.objective,
      expectedDeliverable: correction.deliverable ?? defaultDeliverable(nextKind),
      mayMutateFiles: mayMutate(nextKind),
      requiredEvidence: correction.requiredEvidence ?? defaultEvidence(nextKind),
      reviewScope: nextKind === 'review' ? detectReviewScope(prompt) : undefined,
      correctionOfPreviousTurn: true,
      replacesPreviousObjective: true,
      inheritedObjective: correction.inheritedObjective,
      explicitPaths: [
        ...new Set([...previousTask.explicitPaths, ...extractExplicitTargetPaths(prompt).slice(0, 8)]),
      ],
      openQuestions: [],
      correctionNotes: correction.notes,
    }
  }

  return baseTaskState(prompt)
}

export function deriveTaskControl(prompt: string, previousTask?: TaskState | null): TaskControlDecision {
  const taskState = deriveTaskState(prompt, previousTask)
  const capabilityProfile = selectCapabilityProfile(taskState)
  const mutationPolicy = buildMutationPolicy(taskState)
  return {
    taskState,
    capabilityProfile,
    mutationPolicy,
  }
}

export function commandLooksDestructiveForReadonly(command: string): boolean {
  const trimmed = normalizeWhitespace(command)
  return trimmed !== '' && READ_ONLY_SHELL_BLOCKLIST.some((pattern) => pattern.test(trimmed))
}

export function scriptAllowedForReadonlyVerification(script: string): boolean {
  return SAFE_READONLY_SCRIPT_PATTERN.test(script)
}

export function allowedSubagentRolesForProfile(profile: CapabilityProfileName): Set<SubagentRole> {
  return new Set(PROFILE_SUBAGENT_ROLES[profile])
}

export function profileAllowsSubagentRole(profile: CapabilityProfileName, role: SubagentRole): boolean {
  return allowedSubagentRolesForProfile(profile).has(role)
}

function isExplicitPhaseSwitch(params: {
  prompt: string
  previousTask?: TaskState | null
  candidateTaskState: TaskState
}): boolean {
  const { prompt, previousTask, candidateTaskState } = params
  if (!previousTask) return true
  if (previousTask.kind === candidateTaskState.kind) return false
  if (candidateTaskState.correctionOfPreviousTurn) return false
  return EXPLICIT_PHASE_SWITCH_PATTERNS.some((pattern) => pattern.test(prompt.trim()))
}

export function resolveCapabilityProfileEpoch(params: {
  prompt: string
  previousTask?: TaskState | null
  previousCapabilityProfile?: CapabilityProfileName | null
  candidateTaskState: TaskState
  pendingResumeRehydration?: boolean
}): CapabilityProfileEpochResolution {
  const candidateProfile = selectCapabilityProfile(params.candidateTaskState)

  if (params.pendingResumeRehydration) {
    return {
      capabilityProfile: params.previousCapabilityProfile ?? candidateProfile,
      schemaChangeReason: 'resume_rehydration',
    }
  }

  if (!params.previousCapabilityProfile) {
    return {
      capabilityProfile: candidateProfile,
      schemaChangeReason: 'initial_epoch',
    }
  }

  if (candidateProfile === params.previousCapabilityProfile) {
    return {
      capabilityProfile: params.previousCapabilityProfile,
      schemaChangeReason: null,
    }
  }

  if (params.candidateTaskState.correctionOfPreviousTurn) {
    return {
      capabilityProfile: candidateProfile,
      schemaChangeReason: 'user_correction',
    }
  }

  if (isExplicitPhaseSwitch(params)) {
    return {
      capabilityProfile: candidateProfile,
      schemaChangeReason: 'phase_switch',
    }
  }

  return {
    capabilityProfile: params.previousCapabilityProfile,
    schemaChangeReason: null,
  }
}
