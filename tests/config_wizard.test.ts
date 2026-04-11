import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { runConfigWizard, DEFAULT_MODEL, DEFAULT_BASE_URL, type WizardIO } from '../src/config/wizard.ts'
import { readConfig } from '../src/config/store.ts'

describe('config/wizard', () => {
  let tmpDir: string
  let originalXdg: string | undefined

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'merlion-wizard-test-'))
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

  function makeIO(responses: { secret?: string; prompts?: string[] }): { io: WizardIO; output: string[] } {
    const output: string[] = []
    let promptIndex = 0
    const io: WizardIO = {
      write(text: string) {
        output.push(text)
      },
      async promptSecret(_question: string): Promise<string> {
        return responses.secret ?? ''
      },
      async prompt(_question: string): Promise<string> {
        const answer = responses.prompts?.[promptIndex] ?? ''
        promptIndex++
        return answer
      }
    }
    return { io, output }
  }

  test('wizard with valid key and default model saves config and returns ok', async () => {
    // Use a fresh sub-dir per test
    const subDir = await mkdtemp(join(tmpDir, 'test1-'))
    process.env.XDG_CONFIG_HOME = subDir

    const { io } = makeIO({ secret: 'sk-or-testkey123', prompts: [''] })
    const result = await runConfigWizard({}, io)

    assert.equal(result.ok, true)
    assert.equal(result.config.apiKey, 'sk-or-testkey123')
    assert.equal(result.config.model, DEFAULT_MODEL)
    assert.equal(result.config.baseURL, DEFAULT_BASE_URL)

    // Verify file was actually written
    const saved = await readConfig()
    assert.equal(saved.apiKey, 'sk-or-testkey123')
    assert.equal(saved.model, DEFAULT_MODEL)
  })

  test('wizard with custom model saves the provided model', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'test2-'))
    process.env.XDG_CONFIG_HOME = subDir

    const { io } = makeIO({ secret: 'sk-or-mykey', prompts: ['anthropic/claude-opus-4'] })
    const result = await runConfigWizard({}, io)

    assert.equal(result.ok, true)
    assert.equal(result.config.model, 'anthropic/claude-opus-4')
  })

  test('wizard aborts when API key is blank', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'test3-'))
    process.env.XDG_CONFIG_HOME = subDir

    const { io, output } = makeIO({ secret: '', prompts: [] })
    const result = await runConfigWizard({}, io)

    assert.equal(result.ok, false)
    assert.deepEqual(result.config, {})
    const allOutput = output.join('')
    assert.ok(allOutput.includes('aborted') || allOutput.includes('OPENROUTER_API_KEY'))
  })

  test('wizard aborts when API key is whitespace-only', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'test4-'))
    process.env.XDG_CONFIG_HOME = subDir

    const { io } = makeIO({ secret: '   ', prompts: [] })
    const result = await runConfigWizard({}, io)

    assert.equal(result.ok, false)
  })

  test('wizard skips key prompt when existingConfig already has apiKey', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'test5-'))
    process.env.XDG_CONFIG_HOME = subDir

    // promptSecret should NOT be called — if it is, return blank (which would abort)
    let secretCalled = false
    const io: WizardIO = {
      write() {},
      async promptSecret() {
        secretCalled = true
        return ''
      },
      async prompt() {
        return ''
      }
    }

    const result = await runConfigWizard({ apiKey: 'sk-or-existing', model: 'some/model' }, io)

    assert.equal(secretCalled, false, 'promptSecret should not be called when key already exists')
    assert.equal(result.ok, true)
    assert.equal(result.config.apiKey, 'sk-or-existing')
  })

  test('wizard uses existingConfig model as default when provided', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'test6-'))
    process.env.XDG_CONFIG_HOME = subDir

    const { io } = makeIO({ secret: 'sk-or-key', prompts: [''] }) // empty → accept default
    const result = await runConfigWizard({ model: 'openai/gpt-4o' }, io)

    assert.equal(result.ok, true)
    assert.equal(result.config.model, 'openai/gpt-4o')
  })

  test('output contains config file path on success', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'test7-'))
    process.env.XDG_CONFIG_HOME = subDir

    const { io, output } = makeIO({ secret: 'sk-or-key', prompts: [''] })
    await runConfigWizard({}, io)

    const allOutput = output.join('')
    assert.ok(allOutput.includes('config.json'), 'output should mention config.json path')
  })
})
