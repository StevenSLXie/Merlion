import type { AskUserQuestionItem } from '../tools/types.js'

function parseSelectedOption(raw: string, max: number): number[] | null {
  const tokens = raw.split(',').map((part) => part.trim()).filter(Boolean)
  if (tokens.length === 0) return null
  const indexes: number[] = []
  for (const token of tokens) {
    if (!/^\d+$/.test(token)) return null
    const index = Number(token)
    if (!Number.isInteger(index) || index < 1 || index > max) return null
    indexes.push(index)
  }
  return indexes
}

function renderQuestionPrompt(question: AskUserQuestionItem): string {
  const optionLines = question.options
    .map((option, index) => `  ${index + 1}. ${option.label} - ${option.description}`)
    .join('\n')
  const suffix = question.multiSelect
    ? 'Enter option numbers separated by commas, or type custom text'
    : 'Enter an option number, or type custom text'
  return `${question.header}: ${question.question}\n${optionLines}\n${suffix}\n> `
}

export async function askStructuredQuestions(
  questions: AskUserQuestionItem[],
  io: { readLine: (prompt: string) => Promise<string | null> },
): Promise<Record<string, string>> {
  const answers: Record<string, string> = {}

  for (const question of questions) {
    const raw = (await io.readLine(renderQuestionPrompt(question)))?.trim() ?? ''
    if (raw === '') {
      answers[question.id] = ''
      continue
    }
    const selected = parseSelectedOption(raw, question.options.length)
    if (!selected) {
      answers[question.id] = raw
      continue
    }
    const labels = selected.map((index) => question.options[index - 1]!.label)
    answers[question.id] = question.multiSelect ? labels.join(', ') : labels[0]!
  }

  return answers
}
