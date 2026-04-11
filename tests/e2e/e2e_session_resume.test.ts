/**
 * E2E: Session context restoration.
 *
 * Tests the complete persistence + restore pipeline:
 *   Session 1 — agent creates marker.txt with a unique string,
 *               every message is persisted to a JSONL transcript via
 *               appendTranscriptMessage.
 *   Restore   — loadSessionMessages reads the transcript back into a
 *               ChatMessage array.
 *   Session 2 — a fresh runLoop receives the restored messages as
 *               initialMessages and a new userPrompt. It reads marker.txt
 *               and must report the marker string (proving the prior
 *               context was successfully injected and the file is intact).
 *
 * Covers: appendTranscriptMessage, loadSessionMessages, runLoop initialMessages.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  makeSandbox,
  rmSandbox,
  SKIP,
  makeProvider,
  makeRegistry,
  SYSTEM_PROMPT,
} from './helpers.ts'
import { runLoop } from '../../src/runtime/loop.ts'
import {
  appendTranscriptMessage,
  loadSessionMessages,
} from '../../src/runtime/session.ts'

// Unique marker embedded in the file so we can assert on it cross-session.
const MARKER = `merlion-session-resume-${randomUUID().slice(0, 12)}`

if (SKIP) {
  test.skip('E2E session-resume: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'session 2 can read a file created in session 1 via restored transcript',
    { timeout: 240_000 },
    async () => {
      const sandbox = await makeSandbox()
      const transcriptPath = join(sandbox, 'session1.jsonl')

      try {
        // ── Session 1: create marker.txt, persist every message ───────────────
        const result1 = await runLoop({
          provider: makeProvider(),
          registry: makeRegistry(),
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: `Create a file called marker.txt whose content is exactly: ${MARKER}`,
          cwd: sandbox,
          maxTurns: 15,
          permissions: { ask: async () => 'allow_session' },
          onMessageAppended: (msg) => appendTranscriptMessage(transcriptPath, msg),
        })

        assert.equal(result1.terminal, 'completed', `Session 1 ended: ${result1.terminal}`)

        // Confirm marker.txt was actually written to disk
        const diskContent = await readFile(join(sandbox, 'marker.txt'), 'utf8')
        assert.ok(
          diskContent.includes(MARKER),
          `marker.txt on disk should contain the marker, got: ${diskContent}`,
        )

        // ── Restore: load messages from JSONL transcript ──────────────────────
        const restoredMessages = await loadSessionMessages(transcriptPath)

        assert.ok(
          restoredMessages.length > 0,
          'Transcript must contain at least one message',
        )
        assert.ok(
          restoredMessages.some((m) => m.role === 'system'),
          'Restored messages must include the system message',
        )
        assert.ok(
          restoredMessages.some((m) => m.role === 'assistant'),
          'Restored messages must include at least one assistant message',
        )

        // ── Session 2: inject restored context, ask about marker.txt ─────────
        const result2 = await runLoop({
          provider: makeProvider(),
          registry: makeRegistry(),
          // systemPrompt is ignored when initialMessages is provided
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: 'Read marker.txt and tell me its exact content.',
          cwd: sandbox,
          initialMessages: restoredMessages,
          maxTurns: 15,
          permissions: { ask: async () => 'allow_session' },
        })

        assert.equal(result2.terminal, 'completed', `Session 2 ended: ${result2.terminal}`)

        // Session 2 must report the marker content
        assert.ok(
          result2.finalText.includes(MARKER),
          `Session 2 should report the marker content.\nMarker: ${MARKER}\nGot: ${result2.finalText}`,
        )

        // Session 2 message array is strictly larger (it has all prior messages + new ones)
        assert.ok(
          result2.state.messages.length > result1.state.messages.length,
          'Session 2 should accumulate more messages than session 1',
        )
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
