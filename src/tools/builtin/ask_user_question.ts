import type { AskUserQuestionItem, ToolDefinition } from '../types.js'

function isQuestionItem(value: unknown): value is AskUserQuestionItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return (
    typeof item.header === 'string' &&
    typeof item.id === 'string' &&
    typeof item.question === 'string' &&
    Array.isArray(item.options) &&
    item.options.length >= 2 &&
    item.options.length <= 4 &&
    item.options.every((option) =>
      option &&
      typeof option === 'object' &&
      typeof (option as Record<string, unknown>).label === 'string' &&
      typeof (option as Record<string, unknown>).description === 'string'
    ) &&
    (item.multiSelect === undefined || typeof item.multiSelect === 'boolean')
  )
}

export const askUserQuestionTool: ToolDefinition = {
  name: 'ask_user_question',
  description: 'Ask the user clarifying multiple-choice or free-text questions.',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            header: { type: 'string' },
            id: { type: 'string' },
            question: { type: 'string' },
            multiSelect: { type: 'boolean' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['label', 'description'],
              },
            },
          },
          required: ['header', 'id', 'question', 'options'],
        },
      },
    },
    required: ['questions'],
  },
  concurrencySafe: false,
  async execute(input, ctx) {
    const rawQuestions = input.questions
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0 || rawQuestions.length > 3) {
      return { content: 'Invalid questions: expected 1-3 question objects.', isError: true }
    }

    const questions = rawQuestions.filter(isQuestionItem)
    if (questions.length !== rawQuestions.length) {
      return {
        content: 'Invalid questions: each question must include header, id, question, and 2-4 options.',
        isError: true,
      }
    }

    if (!ctx.askQuestions) {
      return { content: 'Interactive question handler unavailable in this runtime.', isError: true }
    }

    const answers = await ctx.askQuestions(questions)
    return {
      content: JSON.stringify({ answers }, null, 2),
      isError: false,
    }
  },
}
