import type { ToolCallResultEvent } from './executor.ts'

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

function commandTextFromCall(event: ToolCallResultEvent): string {
  const args = parseArgs(event.call.function.arguments)
  const candidates = [args.command, args.script, args.cmd]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

function isLikelyQualityCommand(command: string): boolean {
  const text = command.toLowerCase()
  if (text.trim() === '') return false
  return (
    /\b(test|pytest|vitest|jest|lint|typecheck|check|verify|ruff|mypy|eslint|tsc)\b/.test(text) &&
    !/\bgit\s+(status|diff|log)\b/.test(text)
  )
}

function isLikelyCommitCommand(command: string): boolean {
  return /\bgit\s+commit\b/i.test(command)
}

function isMutationTool(name: string): boolean {
  return (
    name === 'create_file' ||
    name === 'write_file' ||
    name === 'append_file' ||
    name === 'edit_file' ||
    name === 'delete_file' ||
    name === 'move_file' ||
    name === 'copy_file' ||
    name === 'mkdir'
  )
}

function isReadOnlyTool(name: string): boolean {
  return (
    name === 'read_file' ||
    name === 'list_dir' ||
    name === 'search' ||
    name === 'grep' ||
    name === 'glob' ||
    name === 'stat_path' ||
    name === 'git_status' ||
    name === 'git_log' ||
    name === 'git_diff'
  )
}

export function summarizeToolBatchMilestones(results: ToolCallResultEvent[]): string[] {
  if (results.length === 0) return []
  const ok = results.filter((x) => !x.isError)
  const failed = results.length - ok.length
  const lines: string[] = []

  const successfulCommands = ok
    .filter((x) => x.call.function.name === 'bash' || x.call.function.name === 'run_script')
    .map((x) => commandTextFromCall(x))
    .filter((x) => x.trim() !== '')

  const hasQualityPass = successfulCommands.some((command) => isLikelyQualityCommand(command))
  if (hasQualityPass && failed === 0) {
    lines.push('阶段更新：质量检查命令执行成功，可以进入提交或交付步骤。')
  }

  const hasCommit = successfulCommands.some((command) => isLikelyCommitCommand(command))
  if (hasCommit) {
    lines.push('阶段更新：检测到提交命令已成功执行。')
  }

  const mutationCount = ok.filter((x) => isMutationTool(x.call.function.name)).length
  if (mutationCount >= 2 && failed === 0) {
    lines.push(`阶段更新：本批次完成 ${mutationCount} 个文件变更操作。`)
  }

  if (failed > 0 && ok.length > 0) {
    lines.push(`阶段更新：本批次 ${ok.length} 成功，${failed} 失败。`)
  }

  if (lines.length === 0 && failed === 0 && ok.length >= 4) {
    const nonReadOnly = ok.filter((x) => !isReadOnlyTool(x.call.function.name)).length
    if (nonReadOnly > 0) {
      lines.push(`阶段更新：本批次 ${ok.length} 个工具调用均成功。`)
    }
  }

  return lines.slice(0, 2)
}

export function detectSuccessfulGitCommit(results: ToolCallResultEvent[]): boolean {
  return results.some((event) => {
    if (event.isError) return false
    if (event.call.function.name !== 'bash' && event.call.function.name !== 'run_script') return false
    return isLikelyCommitCommand(commandTextFromCall(event))
  })
}
