import type { ToolDefinition } from '../types.js'

export const waitAgentTool: ToolDefinition = {
  name: 'wait_agent',
  description: 'Check whether a background subagent has completed and return its latest status.',
  modelGuidance: [
    '- Use this only when you actually need the child result.',
    '- Do not poll tightly. If the result says running, wait at least the suggested retry interval before asking again.',
  ].join('\n'),
  parameters: {
    type: 'object',
    properties: {
      agentId: { type: 'string' },
    },
    required: ['agentId'],
  },
  concurrencySafe: true,
  async execute(input, ctx) {
    if (!ctx.subagents) {
      return { content: 'Subagent runtime unavailable in this session.', isError: true }
    }
    if (typeof input.agentId !== 'string' || input.agentId.trim() === '') {
      return { content: 'Invalid agentId: expected non-empty string.', isError: true }
    }
    try {
      const result = await ctx.subagents.waitAgent(input.agentId.trim())
      return {
        content: JSON.stringify(result, null, 2),
        isError: false,
      }
    } catch (error) {
      return {
        content: String(error),
        isError: true,
      }
    }
  },
}

