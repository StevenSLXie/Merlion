import { resolve } from 'node:path'

import type { LoopState, ToolCall } from '../types.js'
import type { ToolCallResultEvent } from './executor.ts'

// Action-plan detection intentionally combines intent + action + output
// exemptions so it generalizes across phrasing/languages and avoids overfit.
const ACTION_INTENT_PATTERNS: RegExp[] = [
  /\bi('ll| will)\b/i,
  /\blet me\b/i,
  /\bi('m| am)\s+going\s+to\b/i,
  /\b(i|we)\s+(need|should|can)\s+to\b/i,
  /\b(first|next|then|after that|to start)\b/i,
  /(我来|让我|我会|我将|我先|首先|接下来|下一步|准备)/,
]

const ACTION_VERB_PATTERNS: RegExp[] = [
  /\b(start|begin|look|check|read|analy[sz]e|examine|fix|help|try|write|create|update|run|search|find|inspect|review|explore|open|verify|test|list)\b/i,
  /(查看|检查|读取|搜索|查找|分析|修复|修改|创建|运行|执行|看看|浏览|审查|定位|测试|列出|打开)/,
]

export const REPEATED_TOOL_ERROR_THRESHOLD = 3
export const MAX_AUTO_TOOL_ERROR_HINTS = 3
export const MAX_TOOL_ARGUMENT_HINTS = 3
export const NO_PROGRESS_BATCH_THRESHOLD = 3
export const MAX_NO_PROGRESS_HINTS = 2
export const NO_MUTATION_BATCH_THRESHOLD = 4
export const BUGFIX_NO_MUTATION_BATCH_THRESHOLD = 3
export const MAX_NO_MUTATION_HINTS = 2
export const MAX_MUTATION_OSCILLATION_HINTS = 2
export const MAX_EXPLORATION_HINTS = 2
export const MAX_VERIFICATION_HINTS = 1
export const TODO_ONLY_BATCH_THRESHOLD = 2
export const MAX_TODO_DRIFT_HINTS = 1
export const MAX_LARGE_DIFF_HINTS = 2
export const LARGE_DIFF_LINE_THRESHOLD = 40
export const LARGE_WRITE_LINE_THRESHOLD = 80
export const MAX_OVERWRITE_AFTER_EDIT_HINTS = 1

const COMPLETION_HINT_PATTERNS: RegExp[] = [
  /\b(done|finished|completed)\b/i,
  /\b(all set|resolved|fixed)\b/i,
  /已(完成|处理|修复|解决)/,
  /已经(完成|处理|修复|解决)/,
]

const ACK_HINT_PATTERNS: RegExp[] = [
  /^\s*(ok|okay|yes|yep|got it|sure|在|在的|好的|明白)\s*[\.\!\?。！？]*\s*$/i,
]

const CONCRETE_OUTPUT_PATTERNS: RegExp[] = [
  /```/,
  /\b(found|identified|updated|created|edited|ran|implemented)\b/i,
  /(已(找到|读取|更新|修复)|已经(找到|读取|更新|修复)|发现了|已定位)/,
]

function hasAnyPattern(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text))
}

function looksLikeAuthError(message: string): boolean {
  const normalized = message.toLowerCase()
  if (/\b(401|403)\b/.test(normalized)) return true
  return (
    normalized.includes('unauthorized') ||
    normalized.includes('invalid api key') ||
    normalized.includes('incorrect api key') ||
    normalized.includes('authentication')
  )
}

export function formatProviderErrorText(error: unknown): string {
  const raw = String(error ?? '').trim()
  if (looksLikeAuthError(raw)) {
    return [
      'Provider authentication failed (401/403).',
      'Your API key may be invalid, expired, or revoked.',
      '',
      'How to fix:',
      '1. Run `merlion config` to reopen the setup wizard.',
      '2. Or update key/model/provider in `~/.config/merlion/config.json`.',
      '3. Or export env vars and retry: `MERLION_API_KEY` / `OPENROUTER_API_KEY` / `OPENAI_API_KEY`.',
      '',
      `Raw error: ${raw || '(empty error message)'}`
    ].join('\n')
  }
  if (raw !== '') return raw
  return 'Model provider request failed.'
}

/**
 * Returns true when the model's response looks like a false start:
 * it promised to take action but produced no tool calls.
 *
 * Deliberately conservative to avoid nudging genuine short completions
 * ("done", "在", "yes") or complete summaries.
 */
export function shouldNudge(text: string, state: LoopState): boolean {
  if (state.nudgeCount >= 2) return false

  const trimmed = text.trim()
  if (trimmed.length < 8) return false
  if (hasAnyPattern(trimmed, ACK_HINT_PATTERNS)) return false
  if (hasAnyPattern(trimmed, COMPLETION_HINT_PATTERNS)) return false
  if (hasAnyPattern(trimmed, CONCRETE_OUTPUT_PATTERNS)) return false

  const hasIntent = hasAnyPattern(trimmed, ACTION_INTENT_PATTERNS)
  const hasAction = hasAnyPattern(trimmed, ACTION_VERB_PATTERNS)
  return hasIntent && hasAction
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function toolCallSignature(call: ToolCall): string {
  const raw = call.function.arguments
  try {
    const parsed = JSON.parse(raw) as unknown
    return `${call.function.name}:${stableStringify(parsed)}`
  } catch {
    return `${call.function.name}:${raw.trim()}`
  }
}

export function formatToolErrorHint(call: ToolCall, count: number, cwd: string): string {
  return (
    `Repeated tool failure detected: \`${call.function.name}\` with the same arguments failed ${count} times. ` +
    `Do not repeat the same call again. Re-check paths from workspace root (${cwd}). ` +
    'Use `list_dir` on `.` first, then call tools with real project paths. ' +
    `If you need Merlion artifacts, only use project-local paths under \`${cwd}/.merlion\`. ` +
    'Do not use `~/.merlion` and do not construct `.merlion/<project>/...` paths.'
  )
}

export function isToolArgumentValidationError(message: string): boolean {
  return message.startsWith('Tool argument validation failed:')
}

export function formatToolArgumentHint(call: ToolCall): string {
  return (
    `Tool arguments were invalid for \`${call.function.name}\`. ` +
    'Rebuild the next call from the tool schema: send strict JSON, include every required field, ' +
    'and keep path/file arguments as raw workspace paths only. ' +
    'Do not paste labels like `path:` or `file_path:`, code fences, or leading punctuation such as `:/`. ' +
    'If you are unsure about a path, inspect it with `list_dir` or `stat_path` before mutating anything.'
  )
}

function parseToolCallArgs(call: ToolCall): Record<string, unknown> {
  try {
    return JSON.parse(call.function.arguments) as Record<string, unknown>
  } catch {
    return {}
  }
}

type MutationKind = 'materialize' | 'remove' | 'move'

export type MutationEvent = {
  signature: string
  detail: string
  turn: number
  kind: MutationKind
  path: string
  toolName: string
  magnitudeLines: number
}

export type VerificationStrength = 'none' | 'import_only' | 'repro_script' | 'existing_test' | 'targeted_test'

function normalizePathInput(cwd: string, value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (/[\u0000-\u001f]/.test(trimmed)) return null
  return resolve(cwd, trimmed)
}

function countContentLines(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0) return 0
  const lines = value.split(/\r?\n/)
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

export function toMutationEvent(cwd: string, event: ToolCallResultEvent, turn: number): MutationEvent | null {
  if (event.isError) return null
  const args = parseToolCallArgs(event.call)
  const tool = event.call.function.name
  if (tool === 'delete_file') {
    const path = normalizePathInput(cwd, args.path)
    if (!path) return null
    return {
      signature: `path:${path}`,
      detail: `delete_file ${path}`,
      turn,
      kind: 'remove',
      path,
      toolName: tool,
      magnitudeLines: 0
    }
  }
  if (tool === 'create_file' || tool === 'write_file' || tool === 'append_file' || tool === 'edit_file') {
    const rawPath = typeof args.path === 'string' ? args.path : args.file_path
    const path = normalizePathInput(cwd, rawPath)
    if (!path) return null
    const magnitudeLines = tool === 'edit_file'
      ? (event.uiPayload?.kind === 'edit_diff' ? event.uiPayload.addedLines + event.uiPayload.removedLines : 0)
      : countContentLines(args.content)
    return {
      signature: `path:${path}`,
      detail: `${tool} ${path}`,
      turn,
      kind: 'materialize',
      path,
      toolName: tool,
      magnitudeLines
    }
  }
  if (tool === 'move_file') {
    const from = normalizePathInput(cwd, args.from_path)
    const to = normalizePathInput(cwd, args.to_path)
    if (!from || !to) return null
    return {
      signature: `move:${from}->${to}`,
      detail: `move_file ${from} -> ${to}`,
      turn,
      kind: 'move',
      path: to,
      toolName: tool,
      magnitudeLines: 0
    }
  }
  return null
}

export function looksLikeTestPath(path: string): boolean {
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

export function looksLikeCodePath(path: string): boolean {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  if (looksLikeTestPath(normalized)) return true
  return /\.(c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|mjs|php|py|rb|rs|scala|sh|swift|ts|tsx)$/i.test(normalized)
}

export function isExplorationToolCall(call: ToolCall): boolean {
  const name = call.function.name
  return (
    name === 'read_file' ||
    name === 'list_dir' ||
    name === 'stat_path' ||
    name === 'search' ||
    name === 'grep' ||
    name === 'glob' ||
    name === 'git_status' ||
    name === 'git_diff' ||
    name === 'git_log' ||
    name === 'lsp' ||
    name === 'tool_search'
  )
}

export function extractRelevantPaths(cwd: string, call: ToolCall): string[] {
  const args = parseToolCallArgs(call)
  const keys = ['path', 'file_path', 'from_path', 'to_path']
  const paths: string[] = []
  for (const key of keys) {
    const resolved = normalizePathInput(cwd, args[key])
    if (resolved) paths.push(resolved)
  }
  return Array.from(new Set(paths))
}

function verificationRank(value: VerificationStrength): number {
  switch (value) {
    case 'import_only': return 1
    case 'repro_script': return 2
    case 'existing_test': return 3
    case 'targeted_test': return 4
    case 'none':
    default:
      return 0
  }
}

export function strongerVerificationStrength(a: VerificationStrength, b: VerificationStrength): VerificationStrength {
  return verificationRank(a) >= verificationRank(b) ? a : b
}

export function inferVerificationStrength(call: ToolCall): VerificationStrength {
  const args = parseToolCallArgs(call)
  if (call.function.name === 'run_script') {
    const script = typeof args.script === 'string' ? args.script : ''
    if (/\b(test|tests|spec|verify|verification|check)\b/i.test(script)) return 'existing_test'
    return 'none'
  }
  if (call.function.name !== 'bash') return 'none'
  const command = typeof args.command === 'string' ? args.command : ''
  if (command === '') return 'none'
  if (
    /\b(pytest|tox|nox|nosetests|jest|vitest|mocha|ava|rspec|phpunit|ctest)\b/i.test(command) ||
    /\b(cargo|go|gradle|mvn|npm|pnpm|yarn|bun)\s+test\b/i.test(command) ||
    /\bmanage\.py\s+test\b/i.test(command)
  ) {
    return /-k\s+|::|--grep\b|--filter\b|tests?\/|spec\//i.test(command)
      ? 'targeted_test'
      : 'existing_test'
  }
  if (/\b(node|python|python3|ruby|perl)\b/.test(command) && /\s(-e|-c)\b|<<\s*['"]?[A-Z]+['"]?/i.test(command)) {
    return 'repro_script'
  }
  return 'none'
}

export function isMutationOscillation(previous: MutationEvent, current: MutationEvent): boolean {
  if (
    previous.signature === current.signature &&
    (
      (previous.kind === 'materialize' && current.kind === 'remove') ||
      (previous.kind === 'remove' && current.kind === 'materialize')
    )
  ) {
    return true
  }
  if (previous.kind === 'move' && current.kind === 'move') {
    const previousPayload = previous.signature.slice('move:'.length)
    const currentPayload = current.signature.slice('move:'.length)
    const [prevFrom, prevTo] = previousPayload.split('->')
    const [currFrom, currTo] = currentPayload.split('->')
    if (prevFrom && prevTo && currFrom && currTo && prevFrom === currTo && prevTo === currFrom) {
      return true
    }
  }
  return false
}

export function formatNoProgressHint(count: number): string {
  return (
    `No progress detected: the last ${count} tool batches all failed. ` +
    'Stop retrying broad mutations. Re-plan with 2-3 concrete steps, ' +
    'validate target paths via `list_dir`/`stat_path`, then run one minimal next tool call.'
  )
}

export function formatNoMutationHint(count: number, bugFixMode: boolean): string {
  if (bugFixMode) {
    return (
      `Bug-fix convergence: the last ${count} tool batches produced no successful file change. ` +
      'Stop broad exploration. Use the failing tests/logs and code you already inspected to pick one likely implementation/source file, ' +
      'read it fully, and either apply one minimal source edit or state the concrete blocker. ' +
      'Do not keep expanding into adjacent helpers or rewrite tests first unless the evidence is strong.'
    )
  }
  return (
    `No material progress detected: the last ${count} tool batches produced no successful file change. ` +
    'Stop broad exploration. Inspect the target file or nearest tests, then either apply one minimal edit ' +
    'or explain clearly why no edit is required.'
  )
}

export function formatExplorationBudgetHint(count: number, inspectedPathCount: number, bugFixMode: boolean): string {
  const shared =
    `Exploration budget exceeded: the last ${count} tool batches were search/read-oriented and still produced no file change.` +
    (inspectedPathCount > 0 ? ` You already inspected ${inspectedPathCount} path(s). ` : ' ') +
    'Stop widening the search. Pick the strongest candidate from the files and tests you already inspected, ' +
    'then make one minimal next move: read that file closely, apply one edit, or state the concrete blocker.'
  if (bugFixMode) {
    return `${shared} Prefer likely implementation/source files before broadening into adjacent helpers or rewriting tests.`
  }
  return shared
}

export function mentionsVerification(text: string): boolean {
  return /\b(test|tests|verify|verified|verification|validate|validated|validation|unverified|not tested|not validated)\b/i.test(text)
}

export function formatVerificationHint(): string {
  return (
    'Before concluding a code-change task, provide validation evidence. ' +
    'Run the most relevant available check now, or explicitly state what you could not validate and why. ' +
    'Do not claim success without naming the command, repro, or test coverage you relied on.'
  )
}

export function formatTodoDriftHint(): string {
  return (
    'Todo drift detected: recent tool batches only rewrote todos without inspecting files, editing code, or running validation. ' +
    'Use `todo_write` to reflect real progress, not to fill turns. The next step should inspect a concrete target, apply a minimal edit, or run a relevant check.'
  )
}

export function isLargeMutation(mutation: MutationEvent): boolean {
  if (mutation.toolName === 'write_file' || mutation.toolName === 'create_file') {
    return mutation.magnitudeLines >= LARGE_WRITE_LINE_THRESHOLD
  }
  if (mutation.toolName === 'append_file' || mutation.toolName === 'edit_file') {
    return mutation.magnitudeLines >= LARGE_DIFF_LINE_THRESHOLD
  }
  return false
}

export function formatLargeDiffHint(mutation: MutationEvent): string {
  return (
    `Large patch self-review: \`${mutation.toolName}\` touched \`${mutation.path}\` with roughly ${mutation.magnitudeLines} changed line(s). ` +
    'Review the diff before continuing. Confirm that the change is minimal, that no surrounding logic or docstrings were accidentally rewritten, ' +
    'and that a more targeted `edit_file` change would not be safer.'
  )
}

export function formatOverwriteAfterEditHint(previous: MutationEvent, current: MutationEvent): string {
  return (
    'Overwrite-after-edit guardrail: you already made a targeted edit and then replaced the same file with a whole-file write. ' +
    `Recent sequence: ${previous.detail} -> ${current.detail}. ` +
    'Stop and review that diff now. Prefer preserving the precise edit instead of rewriting the full file unless a full replacement is clearly necessary.'
  )
}

export function shouldRecoverNoMutationStop(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  if (hasAnyPattern(trimmed, COMPLETION_HINT_PATTERNS)) return true
  return /\b(no changes|nothing to change|could not make changes|unable to edit)\b/i.test(trimmed)
}

export function formatMutationOscillationHint(previous: MutationEvent, current: MutationEvent): string {
  return (
    'Mutation oscillation detected across successful file operations. ' +
    `Recent sequence: ${previous.detail} -> ${current.detail}. ` +
    'Stop toggling the same path(s). Re-check intent, inspect filesystem state, and only apply the minimal next change once.'
  )
}

export function formatTestFirstBugFixHint(paths: string[]): string {
  const sample = paths.slice(0, 3).map((path) => `\`${path}\``).join(', ')
  return (
    'Bug-fix guardrail: your first successful file changes touched only test files' +
    (sample ? ` (${sample})` : '') +
    '. In bug-fix/regression work, treat tests as specification and prefer implementation/source changes first. ' +
    'Only rewrite tests before source files when the user explicitly asked for test edits or strong evidence shows the tests are wrong.'
  )
}
