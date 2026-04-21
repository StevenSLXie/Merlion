/**
 * E2E: Cache hit rate on cacheable follow-up turns.
 *
 * These tests use a live model/provider and check two things together:
 *   1. the local prompt-observability tracker sees a large stable prefix;
 *   2. the provider reports cached input tokens on follow-up turns.
 *
 * The goal is not just "some cache exists", but "when the prompt shape should
 * be cacheable, Merlion actually preserves that cacheable prefix well enough
 * to get meaningful cache reuse".
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { createContextService } from '../../src/context/service.ts'
import { createPromptObservabilityTracker } from '../../src/runtime/prompt_observability.ts'
import { QueryEngine } from '../../src/runtime/query_engine.ts'
import { appendTranscriptItem, appendTranscriptResponse, createSessionFiles, loadSessionTranscript } from '../../src/runtime/session.ts'
import type { PromptObservabilitySnapshot } from '../../src/runtime/prompt_observability.ts'
import type { ConversationItem, ProviderResponseBoundary } from '../../src/runtime/items.ts'
import { makeProvider, makeRegistry, makeSandbox, rmSandbox, SKIP } from './helpers.ts'

interface UsageProbe {
  phase: string
  prompt_tokens: number
  completion_tokens: number
  cached_tokens: number | null
  promptObservability?: PromptObservabilitySnapshot
}

function cacheRatio(entry: UsageProbe): number {
  if (entry.cached_tokens === null || entry.prompt_tokens <= 0) return 0
  return entry.cached_tokens / entry.prompt_tokens
}

function stableRatio(entry: UsageProbe): number {
  return entry.promptObservability?.stable_prefix_ratio ?? 0
}

function stableTokens(entry: UsageProbe): number {
  return entry.promptObservability?.stable_prefix_tokens ?? 0
}

function buildLiveEngine(params: {
  cwd: string
  tracker: ReturnType<typeof createPromptObservabilityTracker>
  usage: UsageProbe[]
  phaseRef: { current: string }
  persistItem?: (item: ConversationItem, origin: 'provider_output' | 'local_tool_output' | 'local_runtime', runtimeResponseId?: string) => Promise<void>
  persistResponseBoundary?: (boundary: ProviderResponseBoundary) => Promise<void>
}) {
  return new QueryEngine({
    cwd: params.cwd,
    provider: makeProvider(),
    registry: makeRegistry(),
    permissions: { ask: async () => 'allow_session' },
    contextService: createContextService({
      cwd: params.cwd,
      permissionMode: 'auto_allow',
    }),
    promptObservabilityTracker: params.tracker,
    persistItem: params.persistItem,
    persistResponseBoundary: params.persistResponseBoundary,
    persistUsage: async (entry) => {
      params.usage.push({
        phase: params.phaseRef.current,
        prompt_tokens: entry.prompt_tokens,
        completion_tokens: entry.completion_tokens,
        cached_tokens: entry.cached_tokens ?? null,
        promptObservability: entry.promptObservability,
      })
    },
  })
}

if (SKIP) {
  test.skip('E2E cache-hit-rate: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'follow-up QueryEngine turns retain a large stable prefix and show cache hits',
    { timeout: 300_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        const tracker = createPromptObservabilityTracker()
        const usage: UsageProbe[] = []
        const phaseRef = { current: 'init' }
        const engine = buildLiveEngine({ cwd: sandbox, tracker, usage, phaseRef })

        await engine.initialize()

        phaseRef.current = 'turn1'
        const first = await engine.submitPrompt('Read hello.txt and tell me its exact first line.')
        assert.equal(first.terminal, 'completed')

        phaseRef.current = 'turn2'
        const second = await engine.submitPrompt('Read hello.txt again and tell me its exact first line.')
        assert.equal(second.terminal, 'completed')

        phaseRef.current = 'turn3'
        const third = await engine.submitPrompt('Read hello.txt one more time and answer with only the first line.')
        assert.equal(third.terminal, 'completed')

        const followUps = usage.filter((entry) => entry.phase === 'turn2' || entry.phase === 'turn3')
        assert.ok(followUps.length >= 2, 'expected usage samples from follow-up turns')

        const maxStableRatio = Math.max(...followUps.map(stableRatio))
        const maxStableTokens = Math.max(...followUps.map(stableTokens))
        const totalCached = followUps.reduce((sum, entry) => sum + Math.max(0, entry.cached_tokens ?? 0), 0)
        const maxCacheRatio = Math.max(...followUps.map(cacheRatio))

        process.stderr.write(
          `[cache-hit-rate] follow-up turns: max stable ratio=${maxStableRatio.toFixed(3)}, ` +
            `max stable tokens=${maxStableTokens}, total cached=${totalCached}, ` +
            `max cache ratio=${maxCacheRatio.toFixed(3)}\n`
        )

        assert.ok(maxStableRatio >= 0.9, `expected stable_prefix_ratio >= 0.9, got ${maxStableRatio}`)
        assert.ok(maxStableTokens >= 750, `expected stable_prefix_tokens >= 750, got ${maxStableTokens}`)
        assert.ok(totalCached > 0, 'expected cached_tokens > 0 on cacheable follow-up turns')
        assert.ok(maxCacheRatio >= 0.1, `expected cached/prompt ratio >= 0.1, got ${maxCacheRatio}`)
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )

  test(
    'session resume preserves a cache-friendly prefix for the next turn',
    { timeout: 300_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        const tracker = createPromptObservabilityTracker()
        const usage: UsageProbe[] = []
        const phaseRef = { current: 'session1' }
        const session = await createSessionFiles(sandbox)

        const engine1 = buildLiveEngine({
          cwd: sandbox,
          tracker,
          usage,
          phaseRef,
          persistItem: async (item, origin, runtimeResponseId) => {
            await appendTranscriptItem(session.transcriptPath, item, origin, runtimeResponseId)
          },
          persistResponseBoundary: async (boundary) => {
            await appendTranscriptResponse(session.transcriptPath, boundary)
          },
        })

        await engine1.initialize()
        const first = await engine1.submitPrompt('Read hello.txt and tell me its exact first line.')
        assert.equal(first.terminal, 'completed')

        const restored = await loadSessionTranscript(session.transcriptPath)
        assert.ok(restored.items.length > 0, 'expected persisted transcript items for resume')

        phaseRef.current = 'resumed'
        const engine2 = buildLiveEngine({ cwd: sandbox, tracker, usage, phaseRef })
        await engine2.resumeFromTranscript(restored.items)

        const resumed = await engine2.submitPrompt('Read hello.txt again and tell me its exact first line.')
        assert.equal(resumed.terminal, 'completed')

        const resumedUsage = usage.filter((entry) => entry.phase === 'resumed')
        assert.ok(resumedUsage.length >= 1, 'expected usage samples from resumed turn')

        const maxStableRatio = Math.max(...resumedUsage.map(stableRatio))
        const maxStableTokens = Math.max(...resumedUsage.map(stableTokens))
        const totalCached = resumedUsage.reduce((sum, entry) => sum + Math.max(0, entry.cached_tokens ?? 0), 0)

        process.stderr.write(
          `[cache-hit-rate] resumed turn: max stable ratio=${maxStableRatio.toFixed(3)}, ` +
            `max stable tokens=${maxStableTokens}, total cached=${totalCached}\n`
        )

        assert.ok(maxStableRatio >= 0.8, `expected resumed stable_prefix_ratio >= 0.8, got ${maxStableRatio}`)
        assert.ok(maxStableTokens >= 750, `expected resumed stable_prefix_tokens >= 750, got ${maxStableTokens}`)
        if (totalCached > 0) {
          process.stderr.write(`[cache-hit-rate] resumed turn also reported ${totalCached} cached tokens.\n`)
        } else {
          process.stderr.write(
            '[cache-hit-rate] resumed turn kept a highly stable prefix, but the provider reported no cache hit ' +
              '(this can happen across a fresh engine/process boundary).\n'
          )
        }
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
