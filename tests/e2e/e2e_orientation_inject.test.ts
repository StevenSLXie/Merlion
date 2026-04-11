/**
 * E2E: Orientation context injection.
 *
 * Mirrors what src/index.ts does on every new session:
 *   1. Writes an AGENTS.md with a distinctive rule.
 *   2. Calls buildOrientationContext() to assemble the three sections.
 *   3. Prepends the orientation to the system prompt.
 *   4. Asks the agent to recall the project rule.
 *
 * Verifies that the agent can answer a question about AGENTS.md guidance
 * using only the injected system context (no tool calls needed).
 *
 * Skipped when OPENROUTER_API_KEY is not set.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { makeSandbox, rmSandbox, SKIP, makeProvider, makeRegistry, SYSTEM_PROMPT } from './helpers.ts'
import { runLoop } from '../../src/runtime/loop.ts'
import { buildOrientationContext } from '../../src/context/orientation.ts'

// A distinctive, unambiguous rule the agent must recall from AGENTS.md
const AGENTS_RULE = 'Always add a JSDoc comment above every exported function.'

if (SKIP) {
  test.skip('E2E orientation-inject: skipped (no OPENROUTER_API_KEY)')
} else {
  test(
    'agent recalls AGENTS.md guidance when orientation context is injected into system prompt',
    { timeout: 120_000 },
    async () => {
      const sandbox = await makeSandbox()
      try {
        // Create AGENTS.md with the distinctive rule
        await writeFile(
          join(sandbox, 'AGENTS.md'),
          `# Project Guidelines\n\n## Code Style\n\n${AGENTS_RULE}\n`,
          'utf8',
        )

        // Assemble orientation (mirrors buildOrientationContext call in index.ts)
        const orientation = await buildOrientationContext(sandbox)
        assert.ok(orientation.text.includes(AGENTS_RULE), 'Orientation must include the AGENTS rule')

        // Inject orientation into system prompt (mirrors index.ts injection)
        const systemWithOrientation =
          'Project orientation context. Use this as a starting map, ' +
          'then verify with tools before edits.\n\n' +
          orientation.text +
          '\n\n' +
          SYSTEM_PROMPT

        const result = await runLoop({
          provider: makeProvider(),
          registry: makeRegistry(),
          systemPrompt: systemWithOrientation,
          userPrompt:
            'Based on the project orientation in your system context, ' +
            'what rule does the project specify about exported functions? ' +
            'Answer directly — no need to use tools.',
          cwd: sandbox,
          maxTurns: 5,
          permissions: { ask: async () => 'allow_session' },
        })

        assert.equal(result.terminal, 'completed', `Loop ended with: ${result.terminal}`)

        // Agent must reference the JSDoc / comment rule from AGENTS.md
        const lower = result.finalText.toLowerCase()
        assert.ok(
          lower.includes('jsdoc') || lower.includes('comment') || lower.includes('doc'),
          `Expected agent to recall the JSDoc rule.\nGot: ${result.finalText}`,
        )
      } finally {
        await rmSandbox(sandbox)
      }
    },
  )
}
