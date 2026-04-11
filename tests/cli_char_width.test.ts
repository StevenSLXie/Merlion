import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { displayWidth, plainDisplayWidth, clipToWidth, padToWidth } from '../src/cli/char_width.ts'

describe('cli/char_width', () => {
  describe('displayWidth', () => {
    test('ASCII string has width equal to length', () => {
      assert.equal(displayWidth('hello'), 5)
    })

    test('CJK characters are width 2 each', () => {
      assert.equal(displayWidth('你好'), 4)
      assert.equal(displayWidth('日本語'), 6)
    })

    test('emoji is width 2', () => {
      assert.equal(displayWidth('🙂'), 2)
      assert.equal(displayWidth('🎉'), 2)
    })

    test('mixed ASCII + CJK', () => {
      assert.equal(displayWidth('hi你好'), 2 + 4)
    })

    test('empty string is 0', () => {
      assert.equal(displayWidth(''), 0)
    })
  })

  describe('plainDisplayWidth', () => {
    test('strips ANSI before measuring', () => {
      assert.equal(plainDisplayWidth('\x1b[32mhello\x1b[0m'), 5)
    })

    test('strips ANSI and counts wide chars', () => {
      assert.equal(plainDisplayWidth('\x1b[1m你好\x1b[0m'), 4)
    })
  })

  describe('clipToWidth', () => {
    test('returns string unchanged when within width', () => {
      assert.equal(clipToWidth('hello', 10), 'hello')
    })

    test('clips ASCII and appends ellipsis', () => {
      // 'hello world' = 11 cols; clip at 8 → keep 7 cols + '…' = 8
      assert.equal(clipToWidth('hello world', 8), 'hello w…')
    })

    test('clips CJK correctly — does not split mid character', () => {
      // '你好世界' = 8 cols; clip at 5 → '你好…' (4 cols + 1 ellipsis = 5)
      const result = clipToWidth('你好世界', 5)
      assert.equal(result, '你好…')
      assert.equal(displayWidth(result), 5)
    })

    test('clips when emoji would overflow', () => {
      // 'hi🙂ok' = 2+2+1+1 = 6 cols; clip at 4 → keep 3 cols + '…' = 4
      const result = clipToWidth('hi🙂ok', 4)
      assert.equal(result, 'hi…')
      assert.equal(displayWidth(result), 3)
    })

    test('returns empty string for maxWidth < 1', () => {
      assert.equal(clipToWidth('hello', 0), '')
    })
  })

  describe('padToWidth', () => {
    test('pads ASCII to target width', () => {
      const result = padToWidth('hi', 5)
      assert.equal(result, 'hi   ')
      assert.equal(displayWidth(result), 5)
    })

    test('pads after CJK so total display width is correct', () => {
      const result = padToWidth('你好', 6)
      assert.equal(displayWidth(result), 6)
      assert.equal(result, '你好  ')
    })

    test('does not pad when already at width', () => {
      assert.equal(padToWidth('hello', 5), 'hello')
    })

    test('does not truncate when over width', () => {
      assert.equal(padToWidth('hello world', 5), 'hello world')
    })
  })
})
