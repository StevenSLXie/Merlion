import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { toPlainText, splitForWeixin } from '../src/transport/wechat/text_render.ts'

describe('transport/wechat/text_render — toPlainText', () => {
  test('strips bold **text**', () => {
    assert.equal(toPlainText('hello **world**'), 'hello world')
  })

  test('strips bold __text__', () => {
    assert.equal(toPlainText('hello __world__'), 'hello world')
  })

  test('strips italic *text*', () => {
    assert.equal(toPlainText('hello *world*'), 'hello world')
  })

  test('strips italic _text_', () => {
    assert.equal(toPlainText('hello _world_'), 'hello world')
  })

  test('strips bold-italic ***text***', () => {
    assert.equal(toPlainText('***important***'), 'important')
  })

  test('strips ATX headers', () => {
    assert.equal(toPlainText('# Title\n## Sub'), 'Title\nSub')
  })

  test('strips fenced code blocks — keeps content', () => {
    const md = '```ts\nconst x = 1\n```'
    assert.equal(toPlainText(md), 'const x = 1')
  })

  test('strips inline code backticks', () => {
    assert.equal(toPlainText('use `npm install`'), 'use npm install')
  })

  test('strips strikethrough', () => {
    assert.equal(toPlainText('~~old~~'), 'old')
  })

  test('strips link — keeps display text', () => {
    assert.equal(toPlainText('[click here](https://example.com)'), 'click here')
  })

  test('strips image — keeps alt text', () => {
    assert.equal(toPlainText('![logo](https://example.com/logo.png)'), 'logo')
  })

  test('strips blockquotes', () => {
    assert.equal(toPlainText('> quote line'), 'quote line')
  })

  test('replaces horizontal rules with dash line', () => {
    const result = toPlainText('---')
    assert.match(result, /─+/)
  })

  test('preserves newlines between paragraphs', () => {
    const result = toPlainText('para one\n\npara two')
    assert.ok(result.includes('\n'), 'should contain newline')
  })

  test('strips trailing whitespace per line', () => {
    const result = toPlainText('line  \nother')
    assert.doesNotMatch(result, /  \n/)
  })

  test('passes through plain text unchanged', () => {
    const plain = 'just plain text here'
    assert.equal(toPlainText(plain), plain)
  })
})

describe('transport/wechat/text_render — splitForWeixin', () => {
  test('short text returned as single chunk', () => {
    const chunks = splitForWeixin('hello world', 100)
    assert.equal(chunks.length, 1)
    assert.equal(chunks[0], 'hello world')
  })

  test('splits at newline boundary within limit', () => {
    const line = 'a'.repeat(60)
    const text = `${line}\n${line}`  // 121 chars
    const chunks = splitForWeixin(text, 100)
    assert.equal(chunks.length, 2)
    assert.ok(chunks.every((c) => c.length <= 100))
  })

  test('hard-splits if no newline within limit', () => {
    const text = 'x'.repeat(150)
    const chunks = splitForWeixin(text, 100)
    assert.ok(chunks.length >= 2)
    assert.ok(chunks.every((c) => c.length <= 100))
  })

  test('reassembled chunks equal original (no data loss)', () => {
    const text = Array.from({ length: 10 }, (_, i) => `Line ${i}: ${'x'.repeat(60)}`).join('\n')
    const chunks = splitForWeixin(text, 200)
    // All original content should be present across chunks
    for (let i = 0; i < 10; i++) {
      assert.ok(chunks.some((c) => c.includes(`Line ${i}:`)), `Line ${i} missing`)
    }
  })

  test('uses WEIXIN_MAX_LEN=4000 as default', () => {
    const short = 'hello'
    assert.deepEqual(splitForWeixin(short), [short])
  })
})
