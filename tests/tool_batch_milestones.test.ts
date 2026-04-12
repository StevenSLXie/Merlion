import test from 'node:test'
import assert from 'node:assert/strict'

import {
  detectSuccessfulGitCommit,
  summarizeToolBatchMilestones
} from '../src/runtime/tool_batch_milestones.ts'
import type { ToolCallResultEvent } from '../src/runtime/executor.ts'

function makeEvent(
  name: string,
  args: Record<string, unknown>,
  isError = false
): ToolCallResultEvent {
  return {
    call: {
      id: `${name}-1`,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args),
      },
    },
    index: 1,
    total: 1,
    message: {
      role: 'tool',
      tool_call_id: `${name}-1`,
      content: isError ? 'error' : 'ok',
    },
    isError,
    durationMs: 10,
  }
}

test('summarizeToolBatchMilestones emits quality-check completion update', () => {
  const lines = summarizeToolBatchMilestones([
    makeEvent('bash', { command: 'npm test' }),
    makeEvent('bash', { command: 'npm run lint' }),
  ])
  assert.equal(lines.some((line) => line.includes('质量检查命令执行成功')), true)
})

test('detectSuccessfulGitCommit detects successful commit commands', () => {
  assert.equal(
    detectSuccessfulGitCommit([
      makeEvent('bash', { command: 'git add . && git commit -m "feat: x"' }),
    ]),
    true
  )
  assert.equal(
    detectSuccessfulGitCommit([
      makeEvent('bash', { command: 'git commit -m "x"' }, true),
    ]),
    false
  )
})

test('summarizeToolBatchMilestones reports mixed success and failure', () => {
  const lines = summarizeToolBatchMilestones([
    makeEvent('read_file', { path: 'README.md' }),
    makeEvent('edit_file', { path: 'src/index.ts' }, true),
  ])
  assert.equal(lines.some((line) => line.includes('1 成功，1 失败')), true)
})
