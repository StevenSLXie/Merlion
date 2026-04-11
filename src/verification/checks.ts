import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface VerificationCheck {
  id: string
  name: string
  command: string
  requiresEnv?: string[]
  requiresCommands?: string[]
}

interface PackageJsonLike {
  scripts?: Record<string, string>
}

interface VerifyConfigLike {
  checks?: Array<{
    id?: unknown
    name?: unknown
    command?: unknown
    requiresEnv?: unknown
    requiresCommands?: unknown
  }>
}

type RawVerifyCheck = NonNullable<VerifyConfigLike['checks']>[number]

async function loadPackageJson(cwd: string): Promise<PackageJsonLike | null> {
  const path = join(cwd, 'package.json')
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text) as PackageJsonLike
    return parsed
  } catch {
    return null
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function toStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const parts = value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
  return parts.length > 0 ? parts : undefined
}

function normalizeCheck(raw: RawVerifyCheck): VerificationCheck | null {
  if (!raw) return null
  if (typeof raw.id !== 'string' || raw.id.trim() === '') return null
  if (typeof raw.name !== 'string' || raw.name.trim() === '') return null
  if (typeof raw.command !== 'string' || raw.command.trim() === '') return null
  return {
    id: raw.id.trim(),
    name: raw.name.trim(),
    command: raw.command.trim(),
    requiresEnv: toStringArray(raw.requiresEnv),
    requiresCommands: toStringArray(raw.requiresCommands)
  }
}

async function loadCustomChecks(cwd: string): Promise<VerificationCheck[] | null> {
  const candidates = [join(cwd, '.merlion', 'verify.json'), join(cwd, 'merlion.verify.json')]
  for (const path of candidates) {
    const text = await readTextIfExists(path)
    if (!text) continue
    try {
      const parsed = JSON.parse(text) as VerifyConfigLike
      const checks = (parsed.checks ?? [])
        .map((item) => normalizeCheck(item))
        .filter((item): item is VerificationCheck => item !== null)
      if (checks.length > 0) return checks
    } catch {
      return null
    }
  }
  return null
}

function hasTomlSection(text: string | null, section: string): boolean {
  if (!text) return false
  return new RegExp(`\\[\\s*${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\]`, 'm').test(text)
}

function pushUnique(checks: VerificationCheck[], check: VerificationCheck): void {
  if (checks.some((item) => item.id === check.id)) return
  checks.push(check)
}

async function discoverPythonChecks(cwd: string): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = []
  const pyprojectPath = join(cwd, 'pyproject.toml')
  const [hasPyproject, hasRequirements, hasSetupPy, hasPytestIni, hasMypyIni, hasRuffToml, hasTestsDir] = await Promise.all([
    fileExists(pyprojectPath),
    fileExists(join(cwd, 'requirements.txt')),
    fileExists(join(cwd, 'setup.py')),
    fileExists(join(cwd, 'pytest.ini')),
    fileExists(join(cwd, 'mypy.ini')),
    fileExists(join(cwd, '.ruff.toml')),
    directoryExists(join(cwd, 'tests'))
  ])
  const pyprojectText = hasPyproject ? await readTextIfExists(pyprojectPath) : null

  let hasRootPyFile = false
  try {
    const names = await readdir(cwd)
    hasRootPyFile = names.some((name) => name.endsWith('.py'))
  } catch {
    hasRootPyFile = false
  }

  const hasPythonProject = hasPyproject || hasRequirements || hasSetupPy || hasRootPyFile
  if (!hasPythonProject) return checks

  const hasPytestConfig =
    hasPytestIni ||
    hasTestsDir ||
    hasTomlSection(pyprojectText, 'tool.pytest') ||
    hasTomlSection(pyprojectText, 'tool.pytest.ini_options')
  if (hasPytestConfig) {
    pushUnique(checks, {
      id: 'python_test',
      name: 'Python Tests',
      command: 'python -m pytest -q',
      requiresCommands: ['python']
    })
  }

  const hasMypyConfig = hasMypyIni || hasTomlSection(pyprojectText, 'tool.mypy')
  if (hasMypyConfig) {
    pushUnique(checks, {
      id: 'python_typecheck',
      name: 'Python TypeCheck',
      command: 'python -m mypy .',
      requiresCommands: ['python']
    })
  }

  const hasRuffConfig = hasRuffToml || hasTomlSection(pyprojectText, 'tool.ruff')
  if (hasRuffConfig) {
    pushUnique(checks, {
      id: 'python_lint',
      name: 'Python Lint',
      command: 'python -m ruff check .',
      requiresCommands: ['python']
    })
  }

  return checks
}

async function discoverJavaChecks(cwd: string): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = []
  const [hasPom, hasGradle, hasGradleKts, hasGradlew] = await Promise.all([
    fileExists(join(cwd, 'pom.xml')),
    fileExists(join(cwd, 'build.gradle')),
    fileExists(join(cwd, 'build.gradle.kts')),
    fileExists(join(cwd, 'gradlew'))
  ])

  if (hasGradlew || hasGradle || hasGradleKts) {
    if (hasGradlew) {
      checks.push({
        id: 'java_test_gradle',
        name: 'Java Tests (Gradle)',
        command: './gradlew test --console=plain'
      })
    } else {
      checks.push({
        id: 'java_test_gradle',
        name: 'Java Tests (Gradle)',
        command: 'gradle test --console=plain',
        requiresCommands: ['gradle']
      })
    }
    return checks
  }

  if (hasPom) {
    checks.push({
      id: 'java_test_maven',
      name: 'Java Tests (Maven)',
      command: 'mvn -B test',
      requiresCommands: ['mvn']
    })
  }
  return checks
}

async function discoverMakeChecks(cwd: string): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = []
  const makefilePath = (await fileExists(join(cwd, 'Makefile')))
    ? join(cwd, 'Makefile')
    : (await fileExists(join(cwd, 'makefile')))
      ? join(cwd, 'makefile')
      : null

  if (makefilePath) {
    const makeText = await readTextIfExists(makefilePath)
    if (makeText) {
      if (/^[\t ]*test\s*:/m.test(makeText)) {
        checks.push({
          id: 'make_test',
          name: 'C/C++ Tests (make test)',
          command: 'make test',
          requiresCommands: ['make']
        })
      } else if (/^[\t ]*check\s*:/m.test(makeText)) {
        checks.push({
          id: 'make_check',
          name: 'C/C++ Checks (make check)',
          command: 'make check',
          requiresCommands: ['make']
        })
      }
    }
  }

  const hasCTest = (await fileExists(join(cwd, 'CTestTestfile.cmake'))) || (await fileExists(join(cwd, 'build', 'CTestTestfile.cmake')))
  if (hasCTest) {
    checks.push({
      id: 'ctest',
      name: 'C/C++ Tests (ctest)',
      command: 'ctest --output-on-failure',
      requiresCommands: ['ctest']
    })
  }

  return checks
}

export async function discoverVerificationChecks(cwd: string): Promise<VerificationCheck[]> {
  const customChecks = await loadCustomChecks(cwd)
  if (customChecks && customChecks.length > 0) {
    return customChecks
  }

  const pkg = await loadPackageJson(cwd)
  const scripts = pkg?.scripts ?? {}
  const checks: VerificationCheck[] = []

  if (scripts.typecheck) {
    checks.push({
      id: 'typecheck',
      name: 'TypeCheck',
      command: 'npm run typecheck',
    })
  }

  if (scripts.test) {
    checks.push({
      id: 'test',
      name: 'Unit Tests',
      command: 'npm test',
    })
  }

  if (scripts['test:e2e']) {
    checks.push({
      id: 'test_e2e',
      name: 'E2E Tests',
      command: 'npm run test:e2e',
      requiresEnv: ['OPENROUTER_API_KEY'],
    })
  }

  if (scripts.lint) {
    checks.push({
      id: 'lint',
      name: 'Lint',
      command: 'npm run lint',
    })
  }

  const [pythonChecks, javaChecks, makeChecks] = await Promise.all([
    discoverPythonChecks(cwd),
    discoverJavaChecks(cwd),
    discoverMakeChecks(cwd)
  ])
  for (const check of [...pythonChecks, ...javaChecks, ...makeChecks]) {
    pushUnique(checks, check)
  }

  return checks
}
