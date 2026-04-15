import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

import { loadCaseSpec } from '../scripts/bench_medium/bugsinpy/common.ts'
import { runCase } from '../scripts/bench_medium/bugsinpy/run.ts'

function hasPython(): boolean {
  const result = spawnSync('python3', ['--version'], { encoding: 'utf8' })
  return result.status === 0
}

async function createFakeBugsInPyHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'merlion-bip-home-'))
  const binDir = join(home, 'framework', 'bin')
  await mkdir(binDir, { recursive: true })
  const scriptPath = join(binDir, 'bugsinpy-checkout')
  const script = `#!/usr/bin/env bash
set -euo pipefail
project=""
work=""
while getopts "p:i:v:w:" flag; do
  case "$flag" in
    p) project="$OPTARG" ;;
    w) work="$OPTARG" ;;
  esac
done
repo="$work/$project"
mkdir -p "$repo/tests"
cat > "$repo/bugsinpy_bug.info" <<'EOF'
test_file="tests/test_sample.py"
pythonpath=""
EOF
: > "$repo/bugsinpy_requirements.txt"
cat > "$repo/bugsinpy_run_test.sh" <<'EOF'
python -m unittest -q tests.test_sample
EOF
cat > "$repo/sample.py" <<'EOF'
def value():
    return 1
EOF
cat > "$repo/tests/__init__.py" <<'EOF'
# test package
EOF
cat > "$repo/tests/test_sample.py" <<'EOF'
import unittest
from sample import value

class SampleTest(unittest.TestCase):
    def test_value(self):
        self.assertEqual(value(), 1)
EOF
`
  await writeFile(scriptPath, script, 'utf8')
  await chmod(scriptPath, 0o755)
  return home
}

if (!hasPython()) {
  test.skip('BugsInPy runner smoke test skipped (python3 unavailable)')
} else {
  test(
    'runCase executes fake checkout, local compile wrapper, and test wrappers',
    { timeout: 120_000 },
    async () => {
      const bugsInPyHome = await createFakeBugsInPyHome()
      const repoRoot = process.cwd()
      const spec = await loadCaseSpec(join(repoRoot, 'bench_medium/bugsinpy/cases/BIP001_BLACK_1'))
      const runDir = await mkdtemp(join(tmpdir(), 'merlion-bip-run-'))

      const result = await runCase(spec, {
        bugsInPyHome,
        runAgent: false,
        repoRoot,
        runDir,
      })

      assert.equal(result.status, 'passed', result.failure_reason)
      assert.equal(result.command_results.checkout?.code, 0)
      assert.equal(result.command_results.compile?.code, 0)
      assert.equal(result.command_results.acceptance?.code, 0)
      assert.equal(result.command_results.regression?.code, 0)

      const repoDir = join(runDir, spec.id, 'workspace', spec.project)
      const compileFlag = await readFile(join(repoDir, 'bugsinpy_compile_flag'), 'utf8')
      assert.match(compileFlag, /1/)
    },
  )
}
