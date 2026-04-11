import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// We test configDir(), configPath(), readConfig(), writeConfig(), mergeConfig()
// by overriding XDG_CONFIG_HOME to a temp directory.

describe('config/store', () => {
  let tmpDir: string
  let originalXdg: string | undefined
  let originalHome: string | undefined

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'merlion-config-test-'))
    originalXdg = process.env.XDG_CONFIG_HOME
    originalHome = process.env.HOME
    // Point XDG_CONFIG_HOME at our temp dir so we never touch ~/.config
    process.env.XDG_CONFIG_HOME = tmpDir
  })

  after(async () => {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg
    }
    if (originalHome !== undefined) process.env.HOME = originalHome
    await rm(tmpDir, { recursive: true, force: true })
  })

  // Re-import after env is set so module picks up the temp XDG path.
  // We import inside each test via a dynamic import with cache bust.
  async function freshStore() {
    // Node caches ES modules — we can't truly bypass it, but since configDir()
    // reads process.env at call time (not at module load time) we can just
    // call the module functions directly.
    const mod = await import('../src/config/store.ts')
    return mod
  }

  describe('configDir / configPath', () => {
    test('uses XDG_CONFIG_HOME when set', async () => {
      const { configDir, configPath } = await freshStore()
      assert.ok(configDir().startsWith(tmpDir))
      assert.ok(configPath().endsWith('config.json'))
    })
  })

  describe('readConfig', () => {
    test('returns empty object when file does not exist', async () => {
      const { readConfig } = await freshStore()
      const cfg = await readConfig()
      assert.deepEqual(cfg, {})
    })

    test('returns empty object when file contains invalid JSON', async () => {
      const { configPath, readConfig } = await freshStore()
      const { writeFile, mkdir } = await import('node:fs/promises')
      const { dirname } = await import('node:path')
      await mkdir(dirname(configPath()), { recursive: true })
      await writeFile(configPath(), 'not json', 'utf8')
      const cfg = await readConfig()
      assert.deepEqual(cfg, {})
    })
  })

  describe('writeConfig / readConfig round-trip', () => {
    beforeEach(async () => {
      // Each test gets a fresh sub-directory to avoid cross-test pollution
      const subDir = await mkdtemp(join(tmpDir, 'sub-'))
      process.env.XDG_CONFIG_HOME = subDir
    })

    test('saves and loads apiKey, model, baseURL', async () => {
      const { writeConfig, readConfig } = await freshStore()
      const input = {
        apiKey: 'sk-or-test-key',
        model: 'google/gemini-flash',
        baseURL: 'https://openrouter.ai/api/v1'
      }
      await writeConfig(input)
      const loaded = await readConfig()
      assert.equal(loaded.apiKey, input.apiKey)
      assert.equal(loaded.model, input.model)
      assert.equal(loaded.baseURL, input.baseURL)
    })

    test('written file has mode 0o600', async () => {
      if (process.platform === 'win32') return // skip on Windows
      const { writeConfig, configPath } = await freshStore()
      await writeConfig({ apiKey: 'key', model: 'mdl', baseURL: 'url' })
      const s = await stat(configPath())
      // eslint-disable-next-line no-bitwise
      const mode = s.mode & 0o777
      assert.equal(mode, 0o600)
    })

    test('partial config (only apiKey) round-trips correctly', async () => {
      const { writeConfig, readConfig } = await freshStore()
      await writeConfig({ apiKey: 'only-key' })
      const loaded = await readConfig()
      assert.equal(loaded.apiKey, 'only-key')
      assert.equal(loaded.model, undefined)
      assert.equal(loaded.baseURL, undefined)
    })
  })

  describe('mergeConfig', () => {
    test('overrides take precedence over file config and defaults', async () => {
      const { mergeConfig } = await freshStore()
      const result = mergeConfig(
        { apiKey: 'override-key', model: 'override-model', baseURL: 'override-url' },
        { apiKey: 'file-key', model: 'file-model', baseURL: 'file-url' },
        { apiKey: 'default-key', model: 'default-model', baseURL: 'default-url' }
      )
      assert.equal(result.apiKey, 'override-key')
      assert.equal(result.model, 'override-model')
      assert.equal(result.baseURL, 'override-url')
    })

    test('file config takes precedence over defaults', async () => {
      const { mergeConfig } = await freshStore()
      const result = mergeConfig(
        {},
        { apiKey: 'file-key', model: 'file-model', baseURL: 'file-url' },
        { apiKey: 'default-key', model: 'default-model', baseURL: 'default-url' }
      )
      assert.equal(result.apiKey, 'file-key')
      assert.equal(result.model, 'file-model')
      assert.equal(result.baseURL, 'file-url')
    })

    test('defaults are used when overrides and file are empty', async () => {
      const { mergeConfig } = await freshStore()
      const result = mergeConfig(
        {},
        {},
        { apiKey: 'default-key', model: 'default-model', baseURL: 'default-url' }
      )
      assert.equal(result.apiKey, 'default-key')
      assert.equal(result.model, 'default-model')
      assert.equal(result.baseURL, 'default-url')
    })

    test('empty-string override is treated as absent (falls through to file)', async () => {
      const { mergeConfig } = await freshStore()
      const result = mergeConfig(
        { model: '' },
        { model: 'file-model' },
        { apiKey: '', model: 'default-model', baseURL: '' }
      )
      assert.equal(result.model, 'file-model')
    })

    test('whitespace-only override is treated as absent', async () => {
      const { mergeConfig } = await freshStore()
      const result = mergeConfig(
        { apiKey: '   ' },
        { apiKey: 'file-key' },
        { apiKey: 'default-key', model: '', baseURL: '' }
      )
      assert.equal(result.apiKey, 'file-key')
    })
  })
})
