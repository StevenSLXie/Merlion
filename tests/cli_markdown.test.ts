import test from 'node:test'
import assert from 'node:assert/strict'

import { looksLikeMarkdown, renderMarkdownLines } from '../src/cli/markdown.ts'

test('looksLikeMarkdown detects common markdown patterns', () => {
  assert.equal(looksLikeMarkdown('# Title\n- item'), true)
  assert.equal(looksLikeMarkdown('plain text only'), false)
  assert.equal(looksLikeMarkdown('```ts\nconst a = 1\n```'), true)
})

test('renderMarkdownLines parses headings, list, quote, code and links', () => {
  const lines = renderMarkdownLines(
    '# Heading\n' +
      '- item with `code`\n' +
      '> quote\n' +
      'see [docs](https://example.com)\n' +
      '```ts\nconst a = 1\n```\n'
  )
  assert.deepEqual(lines.map((l) => l.kind), ['heading', 'list', 'quote', 'quote', 'code_meta', 'code'])
  assert.equal(lines[0]?.text, 'Heading')
  assert.equal(lines[1]?.text, '• item with code')
  assert.equal(lines[2]?.text, '  │ quote')
  assert.equal(lines[3]?.text, '  │ see docs <https://example.com>')
  assert.equal(lines[4]?.text, 'code:ts')
  assert.equal(lines[5]?.text, 'const a = 1')
})

test('renderMarkdownLines parses horizontal rules and tables', () => {
  const lines = renderMarkdownLines('---\n| a | b |\n| --- | --- |\n| 1 | 2 |\n')
  assert.equal(lines[0]?.kind, 'rule')
  assert.equal(lines[1]?.kind, 'table')
  assert.match(lines[1]?.text ?? '', /^┌/)
  assert.equal(lines[2]?.kind, 'table')
  assert.equal(lines[3]?.kind, 'table')
  assert.match(lines[2]?.text ?? '', /^│\s+a/)
  assert.match(lines[4]?.text ?? '', /^│\s+1/)
  assert.match(lines[5]?.text ?? '', /^└/)
})

test('renderMarkdownLines preserves ordered list numbering', () => {
  const lines = renderMarkdownLines('1. first\n2. second\n')
  assert.equal(lines[0]?.kind, 'list')
  assert.equal(lines[0]?.text, '1. first')
  assert.equal(lines[1]?.kind, 'list')
  assert.equal(lines[1]?.text, '2. second')
})

test('renderMarkdownLines falls back to pipe-table parsing inside paragraph blocks', () => {
  const lines = renderMarkdownLines(
    'Available Scripts\n| Command | Action |\n| --- | --- |\n| npm run test | run tests |\n'
  )
  assert.equal(lines[0]?.kind, 'plain')
  assert.equal(lines[1]?.kind, 'table')
  assert.match(lines[1]?.text ?? '', /^┌/)
})
