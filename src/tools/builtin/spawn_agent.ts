import type { ToolDefinition } from '../types.js'
import type { SpawnAgentInput, SubagentRole } from '../../runtime/subagent_types.ts'

function isRole(value: unknown): value is SubagentRole {
  return value === 'explorer' || value === 'worker' || value === 'verifier'
}

function parseWriteScope(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
}

export const spawnAgentTool: ToolDefinition = {
  name: 'spawn_agent',
  description: 'Delegate a bounded subtask to an explorer, worker, or verifier subagent.',
  modelGuidance: [
    '- Use explorer for read-heavy code investigation, worker for bounded implementation, and verifier for independent validation.',
    '- Delegation is expensive. Prefer direct work when the task is small or immediately blocking.',
    '- Use background only for longer worker tasks that do not need immediate follow-up.',
    '- Give the child a concrete task. Use purpose to explain why the result matters.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      role: { type: 'string', enum: ['explorer', 'worker', 'verifier'] },
      task: { type: 'string' },
      execution: { type: 'string', enum: ['foreground', 'background'] },
      purpose: { type: 'string' },
      writeScope: { type: 'array', items: { type: 'string' } },
      model: { type: 'string' },
      timeoutMs: { type: 'integer' },
    },
    required: ['role', 'task'],
  },
  concurrencySafe: false,
  async execute(input, ctx) {
    if (!ctx.subagents) {
      return { content: 'Subagent runtime unavailable in this session.', isError: true }
    }
    if (!isRole(input.role)) {
      return { content: 'Invalid role: expected explorer, worker, or verifier.', isError: true }
    }
    if (typeof input.task !== 'string' || input.task.trim() === '') {
      return { content: 'Invalid task: expected non-empty string.', isError: true }
    }

    const writeScope = parseWriteScope(input.writeScope)
    if (Array.isArray(input.writeScope) && writeScope?.length !== input.writeScope.length) {
      return { content: 'Invalid writeScope: expected an array of non-empty strings.', isError: true }
    }
    if (input.execution !== undefined && input.execution !== 'foreground' && input.execution !== 'background') {
      return { content: 'Invalid execution: expected foreground or background.', isError: true }
    }
    if (input.purpose !== undefined && typeof input.purpose !== 'string') {
      return { content: 'Invalid purpose: expected string.', isError: true }
    }
    if (input.model !== undefined && typeof input.model !== 'string') {
      return { content: 'Invalid model: expected string.', isError: true }
    }
    if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || Number(input.timeoutMs) <= 0)) {
      return { content: 'Invalid timeoutMs: expected positive integer.', isError: true }
    }

    const result = await ctx.subagents.spawnAgent({
      role: input.role,
      task: input.task.trim(),
      execution: input.execution,
      purpose: typeof input.purpose === 'string' ? input.purpose.trim() : undefined,
      writeScope,
      model: typeof input.model === 'string' ? input.model.trim() : undefined,
      timeoutMs: typeof input.timeoutMs === 'number' ? Math.floor(input.timeoutMs) : undefined,
    } satisfies SpawnAgentInput)

    return {
      content: JSON.stringify(result, null, 2),
      isError: false,
    }
  },
}

