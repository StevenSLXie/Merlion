import { appendFile, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendTranscriptItem,
  appendUsage,
  createSessionFiles,
  getSessionFilesForResume,
  loadSessionTranscript,
  redactSecrets
} from '../src/runtime/session.ts'
import { createAssistantItem, createExternalUserItem, createSystemItem } from '../src/runtime/items.ts'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'merlion-session-'))
}

function clearSessionDirOverride(): void {
  delete process.env.MERLION_DATA_DIR
}

test('redacts bearer and key patterns', () => {
  const raw = [
    'Authorization: Bearer abc.def.ghi',
    'OPENAI=sk-1234567890abcdefghijklmnop',
    'ANTHROPIC=sk-ant-1234567890abcdefghijklmnop',
    'GITHUB=ghp_1234567890abcdefghijklmnopqr',
    '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----'
  ].join('\n')

  const redacted = redactSecrets(raw)
  assert.doesNotMatch(redacted, /Bearer abc/)
  assert.doesNotMatch(redacted, /sk-1234/)
  assert.doesNotMatch(redacted, /ghp_1234/)
  assert.match(redacted, /\[REDACTED\]/)
})

test('appends transcript lines', async () => {
  const cwd = await makeTempDir()
  process.env.MERLION_DATA_DIR = cwd
  const session = await createSessionFiles('/project/a')

  await appendTranscriptItem(
    session.transcriptPath,
    createAssistantItem('token Bearer abc.def'),
    'provider_output',
    'rt_1'
  )

  const text = await readFile(session.transcriptPath, 'utf8')
  assert.match(text, /"type":"item"/)
  assert.match(text, /Bearer \[REDACTED\]/)
})

test('appends usage lines', async () => {
  const cwd = await makeTempDir()
  process.env.MERLION_DATA_DIR = cwd
  const session = await createSessionFiles('/project/b')

  await appendUsage(session.usagePath, {
    timestamp: new Date().toISOString(),
    session_id: session.sessionId,
    model: 'test-model',
    prompt_tokens: 100,
    completion_tokens: 40,
    cached_tokens: null,
    tool_schema_tokens_estimate: 20
  })

  const text = await readFile(session.usagePath, 'utf8')
  assert.match(text, /"prompt_tokens":100/)
  assert.match(text, /"completion_tokens":40/)
})

test('loads item transcript from existing transcript', async () => {
  const cwd = await makeTempDir()
  process.env.MERLION_DATA_DIR = cwd
  const session = await createSessionFiles('/project/c')

  await appendTranscriptItem(session.transcriptPath, createSystemItem('s', 'static'), 'local_runtime')
  await appendTranscriptItem(session.transcriptPath, createExternalUserItem('u'), 'local_runtime')
  await appendTranscriptItem(session.transcriptPath, createAssistantItem('a'), 'provider_output', 'rt_1')

  const loaded = await loadSessionTranscript(session.transcriptPath)
  assert.equal(loaded.items.length, 3)
  assert.equal(loaded.messages[0]?.role, 'system')
  assert.equal(loaded.messages[2]?.content, 'a')
})

test('ignores malformed transcript lines and invalid message role on load', async () => {
  const cwd = await makeTempDir()
  process.env.MERLION_DATA_DIR = cwd
  const session = await createSessionFiles('/project/d')

  await appendFile(
    session.transcriptPath,
    [
      JSON.stringify({ type: 'session_meta', id: 'x', createdAt: new Date().toISOString(), model: 'm', projectPath: '/project/d' }),
      '{not-json}',
      JSON.stringify({ type: 'message', role: 'alien', content: 'bad role' }),
      JSON.stringify({ type: 'message', role: 'user', content: 'good' })
    ].join('\n') + '\n',
    'utf8'
  )

  const loaded = await loadSessionTranscript(session.transcriptPath)
  assert.equal(loaded.messages.length, 1)
  assert.equal(loaded.messages[0]?.role, 'user')
  assert.equal(loaded.messages[0]?.content, 'good')
})

test('throws when session transcript not found', async () => {
  const cwd = await makeTempDir()
  process.env.MERLION_DATA_DIR = cwd

  await assert.rejects(
    () => getSessionFilesForResume('/project/missing', 'nope'),
    /not found/i
  )
})

test('defaults to project-local .merlion/sessions when MERLION_DATA_DIR is unset', async () => {
  clearSessionDirOverride()
  const repo = await makeTempDir()
  await appendFile(join(repo, '.git'), '', 'utf8')

  const session = await createSessionFiles(repo)
  assert.match(session.projectDir.replace(/\\/g, '/'), /\.merlion\/sessions$/)
  assert.match(session.transcriptPath.replace(/\\/g, '/'), /\.merlion\/sessions\//)
})
