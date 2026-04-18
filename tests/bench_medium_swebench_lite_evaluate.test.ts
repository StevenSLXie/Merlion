import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildRunEvaluationArgs,
  importHarnessResults,
  runPreflightChecks,
} from '../scripts/bench_medium/swebench_lite/evaluate.ts'

test('buildRunEvaluationArgs includes instance ids and namespace override', () => {
  const args = buildRunEvaluationArgs({
    datasetName: 'princeton-nlp/SWE-bench_Lite',
    predictionsPath: 'predictions.jsonl',
    runId: 'demo',
    maxWorkers: 1,
    instanceIds: ['sympy__sympy-20590'],
    namespace: '',
    cacheLevel: 'env',
    clean: true,
  })
  assert.deepEqual(args, [
    '-m',
    'swebench.harness.run_evaluation',
    '--dataset_name',
    'princeton-nlp/SWE-bench_Lite',
    '--predictions_path',
    'predictions.jsonl',
    '--max_workers',
    '1',
    '--run_id',
    'demo',
    '--instance_ids',
    'sympy__sympy-20590',
    '--namespace',
    '',
    '--cache_level',
    'env',
    '--clean',
    'True',
  ])
})

test('runPreflightChecks reports missing docker and python modules', async () => {
  const issues = await runPreflightChecks(
    { outputDir: process.cwd(), pythonBin: 'python3' },
    {
      commandExists: async (command) => command === 'python3' ? false : false,
      freeDiskGb: async () => 50,
    },
  )
  assert.ok(issues.some((item) => item.code === 'docker_missing'))
  assert.ok(issues.some((item) => item.code === 'swebench_harness_missing'))
  assert.ok(issues.some((item) => item.code === 'datasets_missing'))
  assert.ok(issues.some((item) => item.code === 'low_disk'))
})

test('importHarnessResults parses summary and per-instance results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'merlion-swel-harness-'))
  const evalDir = join(root, 'evaluation_results', 'demo')
  await mkdir(join(evalDir, 'run_logs'), { recursive: true })
  await writeFile(join(evalDir, 'results.json'), JSON.stringify({ instances_resolved: 1 }), 'utf8')
  await writeFile(
    join(evalDir, 'instance_results.jsonl'),
    `${JSON.stringify({ instance_id: 'sympy__sympy-20590', resolved: true })}\n`,
    'utf8',
  )

  const imported = await importHarnessResults(root)
  assert.equal(imported.summary?.instances_resolved, 1)
  assert.equal(imported.instances[0]?.instance_id, 'sympy__sympy-20590')
  assert.equal(imported.instances[0]?.status, 'resolved')
})

test('importHarnessResults falls back to root report when instance jsonl is absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'merlion-swel-harness-root-'))
  await mkdir(root, { recursive: true })
  await writeFile(
    join(root, 'merlion.demo.json'),
    JSON.stringify({
      completed_ids: ['sympy__sympy-20590'],
      resolved_ids: ['sympy__sympy-20590'],
      resolved_instances: 1,
    }),
    'utf8',
  )

  const imported = await importHarnessResults(root)
  assert.equal(imported.summary?.resolved_instances, 1)
  assert.equal(imported.instances[0]?.instance_id, 'sympy__sympy-20590')
  assert.equal(imported.instances[0]?.status, 'resolved')
  assert.match(imported.reportPath ?? '', /merlion\.demo\.json$/)
})
