import test from 'node:test'
import assert from 'node:assert/strict'

import { sanitizeRenderableText } from '../src/cli/sanitize.ts'

test('sanitizeRenderableText strips ansi escape sequences', () => {
  const text = '\u001b[31merror\u001b[0m'
  assert.equal(sanitizeRenderableText(text), 'error')
})

test('sanitizeRenderableText strips control chars except newline/tab/carriage return', () => {
  const text = `a${String.fromCharCode(0x01)}b\tc\nd\r`
  assert.equal(sanitizeRenderableText(text), 'ab\tc\nd\r')
})

test('sanitizeRenderableText chunks long opaque tokens', () => {
  const longToken = 'x'.repeat(90)
  const out = sanitizeRenderableText(longToken)
  assert.equal(out.includes(' '), true)
})

test('sanitizeRenderableText preserves paths and urls', () => {
  const unixPath = '/Users/demo/verylongpathsegmentthatshouldstayintact_because_path'
  const url = 'https://example.com/some/superlongpathsegmentthatshouldstayintact'
  assert.equal(sanitizeRenderableText(unixPath), unixPath)
  assert.equal(sanitizeRenderableText(url), url)
})
