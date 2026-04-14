import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveCliConfig } from '../src/bootstrap/config_resolver.ts'
import type { MerlionConfig } from '../src/config/store.ts'

function saveEnv(names: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {}
  for (const name of names) saved[name] = process.env[name]
  return saved
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

test('resolveCliConfig merges env overrides above file config', async () => {
  const saved = saveEnv([
    'MERLION_MODEL',
    'MERLION_BASE_URL',
    'MERLION_API_KEY',
    'MERLION_PROVIDER',
    'OPENROUTER_API_KEY',
    'OPENAI_API_KEY',
  ])
  process.env.MERLION_MODEL = 'env/model'
  process.env.MERLION_BASE_URL = 'https://env.example/v1'
  delete process.env.MERLION_API_KEY
  delete process.env.MERLION_PROVIDER
  delete process.env.OPENROUTER_API_KEY
  delete process.env.OPENAI_API_KEY

  try {
    const result = await resolveCliConfig(
      {
        modelFlag: undefined,
        baseURLFlag: undefined,
        configMode: false,
        task: 'do work',
        repl: false,
      },
      {
        readConfigFn: async () => ({
          provider: 'openrouter',
          apiKey: 'sk-file',
          model: 'file/model',
          baseURL: 'https://file.example/v1',
        }),
      }
    )

    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.config.model, 'env/model')
    assert.equal(result.config.baseURL, 'https://env.example/v1')
    assert.equal(result.config.apiKey, 'sk-file')
  } finally {
    restoreEnv(saved)
  }
})

test('resolveCliConfig returns shouldExitAfterConfig for config-only flow', async () => {
  const wizardConfig: MerlionConfig = {
    provider: 'openai',
    apiKey: 'sk-test',
    model: 'gpt-4.1-mini',
    baseURL: 'https://api.openai.com/v1',
  }

  const result = await resolveCliConfig(
    {
      modelFlag: undefined,
      baseURLFlag: undefined,
      configMode: true,
      task: 'Continue from the existing session state.',
      repl: false,
      resumeSessionId: undefined,
    },
    {
      readConfigFn: async () => ({}),
      runConfigWizardFn: async () => ({ ok: true, config: wizardConfig }),
    }
  )

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.shouldExitAfterConfig, true)
  assert.equal(result.config.provider, 'openai')
})

test('resolveCliConfig propagates wizard abort as exit code 1', async () => {
  const saved = saveEnv([
    'MERLION_MODEL',
    'MERLION_BASE_URL',
    'MERLION_API_KEY',
    'MERLION_PROVIDER',
    'OPENROUTER_API_KEY',
    'OPENAI_API_KEY',
  ])
  delete process.env.MERLION_MODEL
  delete process.env.MERLION_BASE_URL
  delete process.env.MERLION_API_KEY
  delete process.env.MERLION_PROVIDER
  delete process.env.OPENROUTER_API_KEY
  delete process.env.OPENAI_API_KEY

  try {
    const result = await resolveCliConfig(
      {
        modelFlag: undefined,
        baseURLFlag: undefined,
        configMode: false,
        task: 'run',
        repl: false,
      },
      {
        readConfigFn: async () => ({
          provider: 'custom',
          apiKey: '',
          model: '',
          baseURL: '',
        }),
        runConfigWizardFn: async () => ({ ok: false, config: {} }),
      }
    )

    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.exitCode, 1)
  } finally {
    restoreEnv(saved)
  }
})
