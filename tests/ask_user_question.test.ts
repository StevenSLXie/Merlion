import test from 'node:test'
import assert from 'node:assert/strict'

import { askStructuredQuestions } from '../src/runtime/ask_user_question.ts'
import { askUserQuestionTool } from '../src/tools/builtin/ask_user_question.ts'

test('askStructuredQuestions maps single-select numeric answer to label', async () => {
  const answers = await askStructuredQuestions(
    [
      {
        header: 'Mode',
        id: 'mode',
        question: 'Which mode?',
        options: [
          { label: 'Safe', description: 'recommended' },
          { label: 'Fast', description: 'less checks' },
        ],
      },
    ],
    {
      readLine: async () => '2',
    },
  )

  assert.deepEqual(answers, { mode: 'Fast' })
})

test('askStructuredQuestions supports multi-select and free text', async () => {
  const answers = await askStructuredQuestions(
    [
      {
        header: 'Checks',
        id: 'checks',
        question: 'Pick checks',
        multiSelect: true,
        options: [
          { label: 'Typecheck', description: 'tsc' },
          { label: 'Unit', description: 'node test' },
          { label: 'E2E', description: 'agent loop' },
        ],
      },
      {
        header: 'Note',
        id: 'note',
        question: 'Anything else?',
        options: [
          { label: 'None', description: 'no note' },
          { label: 'Custom', description: 'type text' },
        ],
      },
    ],
    {
      readLine: async (prompt) => prompt.includes('Checks:') ? '1,3' : 'run smoke only',
    },
  )

  assert.deepEqual(answers, {
    checks: 'Typecheck, E2E',
    note: 'run smoke only',
  })
})

test('ask_user_question tool returns structured answers', async () => {
  const result = await askUserQuestionTool.execute(
    {
      questions: [
        {
          header: 'Mode',
          id: 'mode',
          question: 'Which mode?',
          options: [
            { label: 'Safe', description: 'recommended' },
            { label: 'Fast', description: 'less checks' },
          ],
        },
      ],
    },
    {
      cwd: process.cwd(),
      askQuestions: async () => ({ mode: 'Safe' }),
    },
  )

  assert.equal(result.isError, false)
  assert.deepEqual(JSON.parse(result.content), { answers: { mode: 'Safe' } })
})

test('ask_user_question tool errors when runtime handler is unavailable', async () => {
  const result = await askUserQuestionTool.execute(
    {
      questions: [
        {
          header: 'Mode',
          id: 'mode',
          question: 'Which mode?',
          options: [
            { label: 'Safe', description: 'recommended' },
            { label: 'Fast', description: 'less checks' },
          ],
        },
      ],
    },
    {
      cwd: process.cwd(),
    },
  )

  assert.equal(result.isError, true)
  assert.match(result.content, /Interactive question handler unavailable/)
})
