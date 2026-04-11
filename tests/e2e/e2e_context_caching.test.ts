/**
 * E2E: Context caching (provider-level prompt cache).
 *
 * Verifies the token-usage tracking pipeline end-to-end:
 *   1. onUsage fires once per model turn with correct fields.
 *   2. cached_tokens is extracted and accumulated correctly.
 *   3. UsageTracker totals are consistent with per-turn samples.
 *
 * As a secondary observation: for Anthropic-compatible models the second+
 * turn should report cached_tokens > 0 (the fixed system+tools prefix is
 * served from the provider's KV cache). This is logged but not a hard
 * assertion because it depends on provider support and prompt length.
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSandbox, rmSandbox, SKIP, makeProvider, makeRegistry, SYSTEM_PROMPT } from './helpers.ts'
import { runLoop } from '../../src/runtime/loop.ts'
import { createUsageTracker } from '../../src/runtime/usage.ts'

if (SKIP) {
  test.skip('E2E context-caching: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'onUsage fires per turn and cached_tokens is tracked correctly',
    { timeout: 180_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        const samples: Array<{
          turn: number
          prompt_tokens: number
          completion_tokens: number
          cached_tokens: number | null
        }> = []
        const tracker = createUsageTracker()

        // Multi-turn task: read a file then create a summary file.
        // This guarantees ≥2 LLM turns (turn 1 = tool call, turn 2 = final answer),
        // giving the provider cache a chance to warm on the second turn.
        const result = await runLoop({
          provider: makeProvider(),
          registry: makeRegistry(),
          systemPrompt: SYSTEM_PROMPT,
          userPrompt:
            'First read hello.txt. Then create a new file called summary.txt ' +
            'whose content is exactly: "Lines: 3".',
          cwd: sandbox,
          maxTurns: 20,
          permissions: { ask: async () => 'allow_session' },
          onUsage: (usage) => {
            const snap = tracker.record(usage)
            samples.push({
              turn: snap.turn,
              prompt_tokens: snap.delta.prompt_tokens,
              completion_tokens: snap.delta.completion_tokens,
              cached_tokens: snap.delta.cached_tokens,
            })
          },
        })

        assert.equal(result.terminal, 'completed', `Loop ended with: ${result.terminal}`)

        // ── Usage samples ────────────────────────────────────────────────────
        assert.ok(samples.length >= 1, 'Expected at least 1 usage sample from onUsage')

        // Every sample must have positive token counts
        for (const s of samples) {
          assert.ok(s.prompt_tokens > 0, `Turn ${s.turn}: prompt_tokens must be > 0`)
          assert.ok(s.completion_tokens > 0, `Turn ${s.turn}: completion_tokens must be > 0`)
          assert.ok(
            s.cached_tokens === null || s.cached_tokens >= 0,
            `Turn ${s.turn}: cached_tokens must be null or non-negative`,
          )
        }

        // ── Tracker totals ───────────────────────────────────────────────────
        const totals = tracker.getTotals()
        const expectedPrompt = samples.reduce((s, x) => s + x.prompt_tokens, 0)
        const expectedCompletion = samples.reduce((s, x) => s + x.completion_tokens, 0)

        assert.equal(totals.prompt_tokens, expectedPrompt, 'prompt_tokens total mismatch')
        assert.equal(
          totals.completion_tokens,
          expectedCompletion,
          'completion_tokens total mismatch',
        )
        assert.equal(
          totals.total_tokens,
          totals.prompt_tokens + totals.completion_tokens,
          'total_tokens must equal prompt + completion',
        )
        assert.ok(totals.cached_tokens >= 0, 'cached_tokens total must be non-negative')

        // ── summary.txt must exist (task completed correctly) ────────────────
        const summaryContent = await readFile(join(sandbox, 'summary.txt'), 'utf8')
        assert.match(summaryContent, /Lines: 3/, `summary.txt content unexpected: ${summaryContent}`)

        // ── Soft observation: provider-level caching ─────────────────────────
        const cachedTotal = totals.cached_tokens
        if (cachedTotal > 0) {
          process.stderr.write(
            `[caching test] Provider cache hit observed: ${cachedTotal} cached tokens ` +
              `across ${samples.length} turns.\n`,
          )
        } else {
          process.stderr.write(
            `[caching test] No cached tokens observed (model: ${process.env.MERLION_E2E_MODEL ?? process.env.MERLION_MODEL ?? 'default'}). ` +
              'This is expected for non-Anthropic models or short prompts.\n',
          )
        }
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
