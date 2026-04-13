import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  runConfigWizard,
  DEFAULT_MODEL,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  type WizardIO
} from '../src/config/wizard.ts'
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

    const { io } = makeIO({ secret: 'sk-or-testkey123', prompts: ['1', ''] })
    const result = await runConfigWizard({}, io)

    assert.equal(result.ok, true)
    assert.equal(result.config.provider, 'openrouter')
    assert.equal(result.config.apiKey, 'sk-or-testkey123')
    assert.equal(result.config.model, DEFAULT_MODEL)
    assert.equal(result.config.baseURL, OPENROUTER_BASE_URL)

    // Verify file was actually written
    const saved = await readConfig()
    assert.equal(saved.provider, 'openrouter')
    assert.equal(saved.apiKey, 'sk-or-testkey123')
    assert.equal(saved.model, DEFAULT_MODEL)
  })

  test('wizard with openai provider uses openai base url', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'test2-'))
    process.env.XDG_CONFIG_HOME = subDir

    const { io } = makeIO({ secret: 'sk-openai-key', prompts: ['2', 'gpt-4.1-mini'] })
    const result = await runConfigWizard({}, io)

    assert.equal(result.ok, true)
    assert.equal(result.config.provider, 'openai')
    assert.equal(result.config.baseURL, OPENAI_BASE_URL)
    assert.equal(result.config.model, 'gpt-4.1-mini')
  })

  test('wizard aborts when API key is blank', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'test3-'))
    process.env.XDG_CONFIG_HOME = subDir

    const { io, output } = makeIO({ secret: '', prompts: ['1'] })
    const result = await runConfigWizard({}, io)

    assert.equal(result.ok, false)
    assert.deepEqual(result.config, {})
    const allOutput = output.join('')
    assert.ok(allOutput.includes('aborted') || allOutput.includes('MERLION_API_KEY'))
  })

  test('wizard aborts when custom provider URL is blank', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'test4-'))
    process.env.XDG_CONFIG_HOME = subDir

    const { io } = makeIO({ secret: 'sk-abc', prompts: ['3', ''] })
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

    const result = await runConfigWizard({ provider: 'openrouter', apiKey: 'sk-or-existing', model: 'some/model' }, io)

    assert.equal(secretCalled, false, 'promptSecret should not be called when key already exists')
    assert.equal(result.ok, true)
    assert.equal(result.config.provider, 'openrouter')
    assert.equal(result.config.apiKey, 'sk-or-existing')
  })

  test('wizard custom provider accepts explicit base url and custom model', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'test6-'))
    process.env.XDG_CONFIG_HOME = subDir

    const { io } = makeIO({
      secret: 'sk-custom-key',
      prompts: ['3', 'https://llm.example.com/v1', 'acme/dev-model']
    })
    const result = await runConfigWizard({}, io)

    assert.equal(result.ok, true)
    assert.equal(result.config.provider, 'custom')
    assert.equal(result.config.baseURL, 'https://llm.example.com/v1')
    assert.equal(result.config.model, 'acme/dev-model')
  })

  test('output contains config file path on success', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'test7-'))
    process.env.XDG_CONFIG_HOME = subDir

    const { io, output } = makeIO({ secret: 'sk-or-key', prompts: ['1', ''] })
    await runConfigWizard({}, io)

    const allOutput = output.join('')
    assert.ok(allOutput.includes('config.json'), 'output should mention config.json path')
  })

  test('forced prompts allow replacing existing api key during reconfigure', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'test8-'))
    process.env.XDG_CONFIG_HOME = subDir

    const { io } = makeIO({ secret: 'sk-new-key', prompts: ['', '', ''] })
    const result = await runConfigWizard(
      { provider: 'openai', apiKey: 'sk-old-key', model: 'gpt-4.1-mini', baseURL: OPENAI_BASE_URL },
      io,
      {
        forceProviderPrompt: true,
        forceBaseURLPrompt: true,
        forceApiKeyPrompt: true
      }
    )

    assert.equal(result.ok, true)
    assert.equal(result.config.provider, 'openai', 'blank provider input should keep existing provider')
    assert.equal(result.config.baseURL, OPENAI_BASE_URL)
    assert.equal(result.config.apiKey, 'sk-new-key')
  })

  test('forced api key prompt allows keeping existing key when input is blank', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'test9-'))
    process.env.XDG_CONFIG_HOME = subDir

    const { io } = makeIO({ secret: '', prompts: [''] })
    const result = await runConfigWizard(
      { provider: 'openrouter', apiKey: 'sk-existing-key', model: DEFAULT_MODEL, baseURL: OPENROUTER_BASE_URL },
      io,
      { forceApiKeyPrompt: true }
    )

    assert.equal(result.ok, true)
    assert.equal(result.config.apiKey, 'sk-existing-key')
  })

  test('provider switch resets base url to new provider canonical during reconfigure', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'test11-'))
    process.env.XDG_CONFIG_HOME = subDir

    // existingConfig has openai URL; user switches to openrouter via '1'
    const { io } = makeIO({ secret: 'sk-or-newkey', prompts: ['1', '', ''] })
    const result = await runConfigWizard(
      { provider: 'openai', apiKey: 'sk-old', model: 'gpt-4.1-mini', baseURL: OPENAI_BASE_URL },
      io,
      { forceProviderPrompt: true, forceBaseURLPrompt: true, forceApiKeyPrompt: true }
    )

    assert.equal(result.ok, true)
    assert.equal(result.config.provider, 'openrouter')
    assert.equal(
      result.config.baseURL,
      OPENROUTER_BASE_URL,
      'switching to openrouter must reset base url to openrouter canonical, not carry over openai url',
    )
  })

  test('required api key input aborts when blank during auth recovery', async () => {
    const subDir = await mkdtemp(join(tmpDir, 'test10-'))
    process.env.XDG_CONFIG_HOME = subDir

    const { io } = makeIO({ secret: '', prompts: [''] })
    const result = await runConfigWizard(
      { provider: 'openrouter', apiKey: 'sk-invalid-key', model: DEFAULT_MODEL, baseURL: OPENROUTER_BASE_URL },
      io,
      {
        forceApiKeyPrompt: true,
        requireApiKeyInput: true
      }
    )

    assert.equal(result.ok, false)
    assert.deepEqual(result.config, {})
  })
})
