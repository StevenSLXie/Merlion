import test from 'node:test'
import assert from 'node:assert/strict'

import { renderEditDiffLines, summarizeEditDiff } from '../src/cli/diff.ts'

test('renderEditDiffLines renders metadata and colored prefixes', () => {
  const lines = renderEditDiffLines({
    kind: 'edit_diff',
    path: '/tmp/sample.ts',
    addedLines: 1,
    removedLines: 1,
    hunks: [
      {
        oldStart: 10,
        oldLines: 1,
        newStart: 10,
        newLines: 1,
        lines: [
          { type: 'remove', text: 'const a = 1' },
          { type: 'add', text: 'const a = 2' }
        ]
      }
    ]
  })

  assert.equal(lines[0]?.tone, 'meta')
  assert.match(lines[0]?.text ?? '', /diff \/tmp\/sample\.ts/)
  assert.equal(lines[2]?.tone, 'remove')
  assert.equal(lines[2]?.text, '-const a = 1')
  assert.equal(lines[3]?.tone, 'add')
  assert.equal(lines[3]?.text, '+const a = 2')
})

test('renderEditDiffLines truncates when exceeding maxLines', () => {
  const lines = renderEditDiffLines({
    kind: 'edit_diff',
    path: '/tmp/long.ts',
    addedLines: 20,
    removedLines: 20,
    hunks: [
      {
        oldStart: 1,
        oldLines: 20,
        newStart: 1,
        newLines: 20,
        lines: Array.from({ length: 40 }, (_, i) => ({
          type: i % 2 === 0 ? 'remove' as const : 'add' as const,
          text: `line-${i}`
        }))
      }
    ]
  }, { maxLines: 10 })

  assert.equal(lines.length, 10)
  assert.match(lines[9]?.text ?? '', /truncated/)
})

test('summarizeEditDiff returns compact metadata lines', () => {
  const lines = summarizeEditDiff({
    kind: 'edit_diff',
    path: '/tmp/small.ts',
    addedLines: 3,
    removedLines: 2,
    hunks: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        lines: [
          { type: 'remove', text: 'a' },
          { type: 'remove', text: 'b' },
          { type: 'add', text: 'c' },
          { type: 'add', text: 'd' },
          { type: 'add', text: 'e' }
        ]
      }
    ]
  })

  assert.equal(lines.length, 2)
  assert.match(lines[0]?.text ?? '', /diff \/tmp\/small\.ts/)
  assert.match(lines[1]?.text ?? '', /1 hunk/)
  assert.match(lines[1]?.text ?? '', /5 changed line/)
})
