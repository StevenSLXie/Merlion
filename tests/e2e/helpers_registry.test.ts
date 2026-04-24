import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDefaultRegistry } from '../../src/tools/builtin/index.ts'
import { makeRegistry } from './helpers.ts'

const readonlyQuestionNames = buildDefaultRegistry({
  mode: 'default',
  profile: 'readonly_question',
}).getAll().map((tool) => tool.name)

function expectedScenarioNames(extraToolName: string): string[] {
  return buildDefaultRegistry({
    mode: 'default',
    includeNames: [...readonlyQuestionNames, extraToolName],
  }).getAll().map((tool) => tool.name)
}

test('targeted budget-regression E2E scenarios reuse readonly profile narrowing', () => {
  for (const scenario of ['e2e-read', 'e2e-search', 'e2e-tool-error']) {
    const names = makeRegistry({ scenario }).getAll().map((tool) => tool.name)
    assert.deepEqual(names, readonlyQuestionNames, `${scenario} should use readonly_question tools`)
  }
})

test('edit scenario adds only edit_file to the readonly question tool set', () => {
  const names = makeRegistry({ scenario: 'e2e-edit' }).getAll().map((tool) => tool.name)
  assert.deepEqual(names, expectedScenarioNames('edit_file'))
  assert.equal(names.includes('create_file'), false)
  assert.equal(names.includes('write_file'), false)
})

test('multi-tool scenario adds only create_file to the readonly question tool set', () => {
  const names = makeRegistry({ scenario: 'e2e-multi-tool' }).getAll().map((tool) => tool.name)
  assert.deepEqual(names, expectedScenarioNames('create_file'))
  assert.equal(names.includes('edit_file'), false)
  assert.equal(names.includes('write_file'), false)
})

test('non-targeted scenarios keep the default registry behavior', () => {
  const defaultNames = buildDefaultRegistry({ mode: 'default' }).getAll().map((tool) => tool.name)
  const names = makeRegistry({ scenario: 'e2e-create' }).getAll().map((tool) => tool.name)
  assert.deepEqual(names, defaultNames)
})
