import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  loadWeixinCredentials,
  saveWeixinCredentials,
  clearWeixinCredentials,
  weixinCredsPath,
  type WeixinCredentials,
} from '../src/transport/wechat/store.ts'

describe('transport/wechat/store', () => {
  let tmpDir: string
  let originalXdg: string | undefined

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'merlion-wechat-store-'))
    originalXdg = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = tmpDir
  })

  after(async () => {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg
    }
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('loadWeixinCredentials returns null when file absent', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'empty-'))
    process.env.XDG_CONFIG_HOME = subDir
    const result = await loadWeixinCredentials()
    assert.equal(result, null)
  })

  test('saveWeixinCredentials writes file and loadWeixinCredentials reads it back', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'rw-'))
    process.env.XDG_CONFIG_HOME = subDir

    const creds: WeixinCredentials = {
      botToken: 'tok-abc123',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      botId: 'bot-1',
      userId: 'user-1',
    }
    await saveWeixinCredentials(creds)

    const loaded = await loadWeixinCredentials()
    assert.ok(loaded !== null, 'should load saved creds')
    assert.equal(loaded.botToken, 'tok-abc123')
    assert.equal(loaded.baseUrl, 'https://ilinkai.weixin.qq.com')
    assert.equal(loaded.botId, 'bot-1')
    assert.equal(loaded.userId, 'user-1')
  })

  test('weixinCredsPath ends with wechat.json', () => {
    assert.ok(weixinCredsPath().endsWith('wechat.json'))
  })

  test('loadWeixinCredentials returns null for corrupt JSON', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'corrupt-'))
    process.env.XDG_CONFIG_HOME = subDir

    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(subDir, 'merlion'), { recursive: true })
    await writeFile(join(subDir, 'merlion', 'wechat.json'), 'not-json', 'utf8')

    const result = await loadWeixinCredentials()
    assert.equal(result, null)
  })

  test('loadWeixinCredentials returns null when botToken missing', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'notoken-'))
    process.env.XDG_CONFIG_HOME = subDir

    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(subDir, 'merlion'), { recursive: true })
    await writeFile(
      join(subDir, 'merlion', 'wechat.json'),
      JSON.stringify({ baseUrl: 'https://example.com' }),
      'utf8',
    )
    const result = await loadWeixinCredentials()
    assert.equal(result, null)
  })

  test('clearWeixinCredentials removes file', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'clear-'))
    process.env.XDG_CONFIG_HOME = subDir

    await saveWeixinCredentials({
      botToken: 'tok',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      botId: '',
      userId: '',
    })
    assert.ok(await loadWeixinCredentials() !== null, 'saved ok')

    await clearWeixinCredentials()
    const afterClear = await loadWeixinCredentials()
    assert.equal(afterClear, null)
  })

  test('clearWeixinCredentials is a no-op when file absent', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'clear-nofile-'))
    process.env.XDG_CONFIG_HOME = subDir
    // Should not throw
    await assert.doesNotReject(clearWeixinCredentials())
  })
})
