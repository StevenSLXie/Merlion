import { appendFile, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  appendTranscriptItem,
  appendTranscriptResponse,
  createSessionFiles,
  loadSessionTranscript,
} from '../src/runtime/session.ts'
import { createExternalUserItem, createRuntimeUserItem, createSystemItem } from '../src/runtime/items.ts'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'merlion-session-items-'))
}

test('item transcript persists response boundaries and previous_response_id eligibility without local tail', async () => {
  const cwd = await makeTempDir()
  process.env.MERLION_DATA_DIR = cwd
  const session = await createSessionFiles('/project/items-a')

  await appendTranscriptResponse(session.transcriptPath, {
    runtimeResponseId: 'rt_1',
    providerResponseId: 'resp_1',
    provider: 'openai_responses',
    finishReason: 'stop',
    outputItemCount: 1,
    createdAt: new Date().toISOString(),
  })
  await appendTranscriptItem(
    session.transcriptPath,
    createSystemItem('system', 'static'),
    'provider_output',
    'rt_1'
  )

  const loaded = await loadSessionTranscript(session.transcriptPath)
  assert.equal(loaded.latestResponseBoundary?.providerResponseId, 'resp_1')
  assert.equal(loaded.hasLocalTailAfterLatestResponse, false)
  assert.equal(loaded.eligiblePreviousResponseId, 'resp_1')
})

test('item transcript detects local tail after latest response and disables previous_response_id eligibility', async () => {
  const cwd = await makeTempDir()
  process.env.MERLION_DATA_DIR = cwd
  const session = await createSessionFiles('/project/items-b')

  await appendTranscriptResponse(session.transcriptPath, {
    runtimeResponseId: 'rt_1',
    providerResponseId: 'resp_1',
    provider: 'openai_responses',
    finishReason: 'stop',
    outputItemCount: 1,
    createdAt: new Date().toISOString(),
  })
  await appendTranscriptItem(
    session.transcriptPath,
    createExternalUserItem('task'),
    'provider_output',
    'rt_1'
  )
  await appendTranscriptItem(
    session.transcriptPath,
    createRuntimeUserItem('Please verify the change before finishing.'),
    'local_runtime'
  )

  const loaded = await loadSessionTranscript(session.transcriptPath)
  assert.equal(loaded.latestResponseBoundary?.providerResponseId, 'resp_1')
  assert.equal(loaded.hasLocalTailAfterLatestResponse, true)
  assert.equal(loaded.eligiblePreviousResponseId, null)
})

test('legacy message transcript still loads through source recovery rules', async () => {
  const cwd = await makeTempDir()
  process.env.MERLION_DATA_DIR = cwd
  const session = await createSessionFiles('/project/items-c')

  await appendFile(
    session.transcriptPath,
    [
      JSON.stringify({ type: 'message', role: 'system', content: 'base system' }),
      JSON.stringify({ type: 'message', role: 'user', content: 'real task' }),
      JSON.stringify({ type: 'message', role: 'user', content: 'Please verify the change before finishing.' })
    ].join('\n') + '\n',
    'utf8'
  )

  const loaded = await loadSessionTranscript(session.transcriptPath)
  assert.equal(loaded.items.length, 3)
  assert.equal(loaded.items[0]?.kind, 'message')
  assert.equal(loaded.items[0]?.role, 'system')
  assert.equal(loaded.items[0]?.source, 'static')
  assert.equal(loaded.items[1]?.kind, 'message')
  assert.equal(loaded.items[1]?.role, 'user')
  assert.equal(loaded.items[1]?.source, 'external')
  assert.equal(loaded.items[2]?.kind, 'message')
  assert.equal(loaded.items[2]?.role, 'user')
  assert.equal(loaded.items[2]?.source, 'runtime')

  const raw = await readFile(session.transcriptPath, 'utf8')
  assert.match(raw, /"type":"message"/)
})

