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
  assert.deepEqual(lines.map((l) => l.kind), ['heading', 'list', 'quote', 'plain', 'code'])
  assert.equal(lines[0]?.text, '# Heading')
  assert.equal(lines[1]?.text, '- item with code')
  assert.equal(lines[3]?.text, 'see docs <https://example.com>')
  assert.equal(lines[4]?.text, 'const a = 1')
})

test('renderMarkdownLines parses horizontal rules and table rows', () => {
  const lines = renderMarkdownLines('---\n| a | b |\n')
  assert.equal(lines[0]?.kind, 'rule')
  assert.equal(lines[1]?.kind, 'table')
})
