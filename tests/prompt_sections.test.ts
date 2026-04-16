import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createPromptSectionCache,
  joinPromptSections,
  resolvePromptSections,
} from '../src/prompt/sections.ts'
import { buildMerlionSystemPrompt } from '../src/prompt/system_prompt.ts'

test('resolvePromptSections caches session sections and skips empty values', async () => {
  const cache = createPromptSectionCache()
  let calls = 0

  const first = await resolvePromptSections(
    [
      {
        id: 'a',
        resolve: () => {
          calls += 1
          return 'alpha'
        }
      },
      {
        id: 'b',
        resolve: () => null
      }
    ],
    cache
  )
  const second = await resolvePromptSections(
    [
      {
        id: 'a',
        resolve: () => {
          calls += 1
          return 'alpha-new'
        }
      }
    ],
    cache
  )

  assert.equal(calls, 1)
  assert.equal(first.length, 1)
  assert.equal(first[0]?.text, 'alpha')
  assert.equal(first[0]?.fromCache, false)
  assert.equal(second.length, 1)
  assert.equal(second[0]?.text, 'alpha')
  assert.equal(second[0]?.fromCache, true)
})

test('resolvePromptSections recomputes volatile sections', async () => {
  const cache = createPromptSectionCache()
  let value = 0

  const one = await resolvePromptSections(
    [
      {
        id: 'tick',
        cachePolicy: 'volatile',
        resolve: () => {
          value += 1
          return `v${value}`
        }
      }
    ],
    cache
  )
  const two = await resolvePromptSections(
    [
      {
        id: 'tick',
        cachePolicy: 'volatile',
        resolve: () => {
          value += 1
          return `v${value}`
        }
      }
    ],
    cache
  )

  assert.equal(one[0]?.text, 'v1')
  assert.equal(two[0]?.text, 'v2')
  assert.equal(one[0]?.fromCache, false)
  assert.equal(two[0]?.fromCache, false)
})

test('joinPromptSections ignores null or empty values', () => {
  const merged = joinPromptSections(['a', '   ', null, undefined, 'b'])
  assert.equal(merged, 'a\n\nb')
})

test('buildMerlionSystemPrompt reuses session-cached dynamic sections', async () => {
  const cache = createPromptSectionCache()
  const first = await buildMerlionSystemPrompt({
    cwd: '/repo',
    sectionCache: cache
  })
  const second = await buildMerlionSystemPrompt({
    cwd: '/repo',
    sectionCache: cache
  })

  assert.match(first.text, /Use path-guided exploration/)
  assert.match(first.text, /Bug-fix discipline:/)
  assert.match(first.text, /Workspace scope:/)
  assert.equal(first.sections.every((x) => x.fromCache === false), true)
  assert.equal(second.sections.every((x) => x.fromCache === true), true)
})
