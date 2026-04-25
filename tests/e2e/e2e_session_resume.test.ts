/**
 * E2E: Session context restoration.
 *
 * Tests the complete persistence + restore pipeline:
 *   Session 1 — agent creates marker.txt with a unique string,
 *               every item is persisted to a JSONL transcript via
 *               appendTranscriptItem.
 *   Restore   — loadSessionTranscript reads the transcript back into an
 *               item array.
 *   Session 2 — a fresh runLoop receives the restored items as
 *               initialItems and a new userPrompt. It reads marker.txt
 *               and must report the marker string (proving the prior
 *               context was successfully injected and the file is intact).
 *
 * Covers: appendTranscriptItem, loadSessionTranscript, runLoop initialItems.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertPromptObservabilityArchive,
  buildUsageArchivePayload,
  makeSandbox,
  rmSandbox,
  SKIP,
  makeProvider,
  makeRegistry,
  SYSTEM_PROMPT,
} from './helpers.ts'
import { runLoop } from '../../src/runtime/loop.ts'
import {
  appendTranscriptItem,
  loadSessionTranscript,
} from '../../src/runtime/session.ts'
import { itemsToMessages } from '../../src/runtime/items.ts'
import { createPromptObservabilityTrackerWithToolSchema, summarizeToolSchema } from '../../src/runtime/prompt_observability.ts'
import { createUsageTracker } from '../../src/runtime/usage.ts'

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
      const registry = makeRegistry()
      const toolSchema = summarizeToolSchema(registry.getAll())
      const session1PromptObservability = [] as Array<ReturnType<ReturnType<typeof createPromptObservabilityTrackerWithToolSchema>['record']>>
      const session2PromptObservability = [] as Array<ReturnType<ReturnType<typeof createPromptObservabilityTrackerWithToolSchema>['record']>>
      const session1Usage = createUsageTracker()
      const session2Usage = createUsageTracker()
      const session1UsageSamples: Array<{ prompt_tokens: number; completion_tokens: number; cached_tokens: number | null }> = []
      const session2UsageSamples: Array<{ prompt_tokens: number; completion_tokens: number; cached_tokens: number | null }> = []

      try {
        // ── Session 1: create marker.txt, persist every message ───────────────
        const result1 = await runLoop({
          provider: makeProvider(),
          registry,
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: `Create a file called marker.txt whose content is exactly: ${MARKER}`,
          cwd: sandbox,
          maxTurns: 15,
          permissions: { ask: async () => 'allow_session' },
          promptObservabilityTracker: createPromptObservabilityTrackerWithToolSchema(toolSchema.tool_schema_serialized),
          onPromptObservability: (snapshot) => {
            session1PromptObservability.push(snapshot)
          },
          onUsage: (usage) => {
            const snapshot = session1Usage.record(usage)
            session1UsageSamples.push({
              prompt_tokens: snapshot.delta.prompt_tokens,
              completion_tokens: snapshot.delta.completion_tokens,
              cached_tokens: snapshot.delta.cached_tokens,
            })
          },
          onItemAppended: (entry) => appendTranscriptItem(
            transcriptPath,
            entry.item,
            entry.origin,
            entry.runtimeResponseId
          ),
        })

        assert.equal(result1.terminal, 'completed', `Session 1 ended: ${result1.terminal}`)

        // Confirm marker.txt was actually written to disk
        const diskContent = await readFile(join(sandbox, 'marker.txt'), 'utf8')
        assert.ok(
          diskContent.includes(MARKER),
          `marker.txt on disk should contain the marker, got: ${diskContent}`,
        )

        // ── Restore: load messages from JSONL transcript ──────────────────────
        const restoredTranscript = await loadSessionTranscript(transcriptPath)

        assert.ok(
          restoredTranscript.items.length > 0,
          'Transcript must contain at least one item',
        )
        assert.ok(
          itemsToMessages(restoredTranscript.items).some((m) => m.role === 'system'),
          'Restored transcript must include the system message',
        )
        assert.ok(
          itemsToMessages(restoredTranscript.items).some((m) => m.role === 'assistant'),
          'Restored transcript must include at least one assistant message',
        )

        // ── Session 2: inject restored context, ask about marker.txt ─────────
        const result2 = await runLoop({
          provider: makeProvider(),
          registry,
          // systemPrompt is ignored when initialItems is provided
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: 'Read marker.txt and tell me its exact content.',
          cwd: sandbox,
          initialItems: restoredTranscript.items,
          maxTurns: 15,
          permissions: { ask: async () => 'allow_session' },
          promptObservabilityTracker: createPromptObservabilityTrackerWithToolSchema(toolSchema.tool_schema_serialized),
          onPromptObservability: (snapshot) => {
            session2PromptObservability.push(snapshot)
          },
          onUsage: (usage) => {
            const snapshot = session2Usage.record(usage)
            session2UsageSamples.push({
              prompt_tokens: snapshot.delta.prompt_tokens,
              completion_tokens: snapshot.delta.completion_tokens,
              cached_tokens: snapshot.delta.cached_tokens,
            })
          },
        })

        assert.equal(result2.terminal, 'completed', `Session 2 ended: ${result2.terminal}`)

        // Session 2 must report the marker content
        assert.ok(
          result2.finalText.includes(MARKER),
          `Session 2 should report the marker content.\nMarker: ${MARKER}\nGot: ${result2.finalText}`,
        )

        // Session 2 item array is strictly larger (it has all prior items + new ones)
        assert.ok(
          result2.state.items.length > result1.state.items.length,
          'Session 2 should accumulate more items than session 1',
        )

        const resumedArchive = buildUsageArchivePayload({
          scenario: 'Session Resume',
          task: 'Read marker.txt and tell me its exact content.',
          cwd: sandbox,
          result: result2,
          model: process.env.MERLION_E2E_MODEL ?? process.env.MERLION_MODEL ?? 'default',
          baseURL: process.env.MERLION_BASE_URL ?? 'https://openrouter.ai/api/v1',
          usageSamples: session2UsageSamples,
          totals: session2Usage.getTotals(),
          toolSchema,
          promptObservability: session2PromptObservability,
        })
        const resumedSummary = assertPromptObservabilityArchive(resumedArchive, {
          minSnapshots: 1,
          minStablePrefixTokens: 1,
        })
        assert.equal(resumedSummary.maxStablePrefixRatio > 0, true)
        assert.equal(session1PromptObservability.length > 0, true)
        assert.equal(session1UsageSamples.length > 0, true)
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
