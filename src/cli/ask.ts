import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'

export interface AskLineInterface {
  question: (question: string) => Promise<string>
  close: () => void
}

export type AskLineFactory = () => AskLineInterface

export async function askLineWithFactory(
  question: string,
  factory: AskLineFactory
): Promise<string | null> {
  const rl = factory()
  try {
    return await rl.question(question)
  } catch {
    return null
  } finally {
    rl.close()
  }
}

export async function askLine(question: string): Promise<string | null> {
  return askLineWithFactory(question, () => createInterface({ input: stdin, output: stdout }))
}
