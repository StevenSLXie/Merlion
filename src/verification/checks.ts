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

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
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

async function readDirSafe(path: string): Promise<string[]> {
  try {
    return await readdir(path)
  } catch {
    return []
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

function pushUnique(checks: VerificationCheck[], check: VerificationCheck): void {
  if (checks.some((item) => item.id === check.id || item.command === check.command)) return
  checks.push(check)
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
      return null
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

function inferCommandBinary(command: string): string | undefined {
  const firstSegment = command.split(/&&|\|\||;/)[0]?.trim() ?? ''
  if (firstSegment === '') return undefined
  const tokens = firstSegment.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  let index = 0
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)) {
    index += 1
  }
  const token = tokens[index]
  if (!token) return undefined
  const normalized = token.replace(/^['"]|['"]$/g, '')
  if (
    normalized === '' ||
    normalized.startsWith('./') ||
    normalized.startsWith('/') ||
    normalized.startsWith('$') ||
    normalized.includes('/')
  ) {
    return undefined
  }
  return normalized
}

function buildCheck(
  id: string,
  name: string,
  command: string,
  extras?: { requiresEnv?: string[]; requiresCommands?: string[] }
): VerificationCheck {
  const requiresCommands = extras?.requiresCommands ?? (() => {
    const inferred = inferCommandBinary(command)
    return inferred ? [inferred] : undefined
  })()
  return {
    id,
    name,
    command,
    requiresEnv: extras?.requiresEnv,
    requiresCommands
  }
}

function isLikelyVerificationCommand(command: string): boolean {
  const signal = /(test|pytest|mypy|ruff|lint|typecheck|clippy|ctest|check|verify|spec)/i
  if (!signal.test(command)) return false
  const noisy = /(deploy|release|publish|docker push|helm|terraform apply|kubectl apply)/i
  return !noisy.test(command)
}

function extractGithubRunCommands(text: string): string[] {
  const commands: string[] = []
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    const inline = line.match(/^\s*-\s*run:\s*(.+?)\s*$/)
    if (inline && inline[1] && inline[1] !== '|' && inline[1] !== '>') {
      commands.push(inline[1].trim())
      continue
    }
    const block = line.match(/^(\s*)-\s*run:\s*[|>]\s*$/)
    if (!block) continue
    const indent = block[1]?.length ?? 0
    const blockLines: string[] = []
    let j = i + 1
    while (j < lines.length) {
      const next = lines[j] ?? ''
      if (next.trim() === '') {
        j += 1
        continue
      }
      const currentIndent = next.match(/^(\s*)/)?.[1].length ?? 0
      if (currentIndent <= indent) break
      blockLines.push(next.trim())
      j += 1
    }
    if (blockLines.length > 0) {
      commands.push(blockLines.join(' && '))
    }
    i = Math.max(i, j - 1)
  }
  return commands
}

function extractGitlabScriptCommands(text: string): string[] {
  const commands: string[] = []
  const lines = text.split(/\r?\n/)
  let inScript = false
  let scriptIndent = -1
  for (const line of lines) {
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0
    const inlineScript = line.match(/^\s*script:\s*(.+)\s*$/)
    if (inlineScript && inlineScript[1] && inlineScript[1] !== '|') {
      commands.push(inlineScript[1].trim())
      inScript = false
      scriptIndent = -1
      continue
    }
    if (/^\s*script:\s*$/.test(line)) {
      inScript = true
      scriptIndent = indent
      continue
    }
    if (!inScript) continue
    if (line.trim() === '') continue
    if (indent <= scriptIndent) {
      inScript = false
      scriptIndent = -1
      continue
    }
    const cmd = line.match(/^\s*-\s+(.+?)\s*$/)?.[1]
    if (cmd) commands.push(cmd.trim())
  }
  return commands
}

async function discoverCiChecks(cwd: string): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = []
  const githubDir = join(cwd, '.github', 'workflows')
  if (await directoryExists(githubDir)) {
    const names = await readDirSafe(githubDir)
    const workflowFiles = names.filter((name) => name.endsWith('.yml') || name.endsWith('.yaml')).sort()
    let ciIndex = 1
    for (const name of workflowFiles) {
      const text = await readTextIfExists(join(githubDir, name))
      if (!text) continue
      const commands = extractGithubRunCommands(text).filter(isLikelyVerificationCommand)
      for (const command of commands) {
        pushUnique(checks, buildCheck(`ci_${ciIndex}`, `CI Check ${ciIndex}`, command))
        ciIndex += 1
      }
    }
  }

  const gitlab = await readTextIfExists(join(cwd, '.gitlab-ci.yml'))
  if (gitlab) {
    let ciIndex = checks.length + 1
    const commands = extractGitlabScriptCommands(gitlab).filter(isLikelyVerificationCommand)
    for (const command of commands) {
      pushUnique(checks, buildCheck(`ci_${ciIndex}`, `CI Check ${ciIndex}`, command))
      ciIndex += 1
    }
  }

  return checks
}

async function loadPackageJson(cwd: string): Promise<PackageJsonLike | null> {
  const text = await readTextIfExists(join(cwd, 'package.json'))
  if (!text) return null
  try {
    return JSON.parse(text) as PackageJsonLike
  } catch {
    return null
  }
}

async function pickNodeRunner(cwd: string): Promise<{ label: 'npm' | 'pnpm' | 'yarn' | 'bun'; command: string }> {
  if (await fileExists(join(cwd, 'pnpm-lock.yaml'))) return { label: 'pnpm', command: 'pnpm run' }
  if (await fileExists(join(cwd, 'yarn.lock'))) return { label: 'yarn', command: 'yarn' }
  if (await fileExists(join(cwd, 'bun.lockb')) || await fileExists(join(cwd, 'bun.lock'))) {
    return { label: 'bun', command: 'bun run' }
  }
  return { label: 'npm', command: 'npm run' }
}

async function discoverNodeChecks(cwd: string): Promise<VerificationCheck[]> {
  const pkg = await loadPackageJson(cwd)
  const scripts = pkg?.scripts ?? {}
  const checks: VerificationCheck[] = []
  if (Object.keys(scripts).length === 0) return checks
  const runner = await pickNodeRunner(cwd)
  const run = (name: string): string => `${runner.command} ${name}`

  if (scripts.typecheck) {
    checks.push(buildCheck('typecheck', 'TypeCheck', run('typecheck'), { requiresCommands: [runner.label] }))
  }
  if (scripts.test) {
    checks.push(buildCheck('test', 'Unit Tests', run('test'), { requiresCommands: [runner.label] }))
  }
  if (scripts['test:e2e']) {
    checks.push(buildCheck('test_e2e', 'E2E Tests', run('test:e2e'), {
      requiresEnv: ['OPENROUTER_API_KEY'],
      requiresCommands: [runner.label]
    }))
  }
  if (scripts.lint) {
    checks.push(buildCheck('lint', 'Lint', run('lint'), { requiresCommands: [runner.label] }))
  }
  return checks
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
  const rootNames = await readDirSafe(cwd)
  const hasRootPyFile = rootNames.some((name) => name.endsWith('.py'))
  const hasPythonProject = hasPyproject || hasRequirements || hasSetupPy || hasRootPyFile
  if (!hasPythonProject) return checks

  if (
    hasPytestIni ||
    hasTestsDir ||
    hasTomlSection(pyprojectText, 'tool.pytest') ||
    hasTomlSection(pyprojectText, 'tool.pytest.ini_options')
  ) {
    pushUnique(checks, buildCheck('python_test', 'Python Tests', 'python -m pytest -q'))
  }
  if (hasMypyIni || hasTomlSection(pyprojectText, 'tool.mypy')) {
    pushUnique(checks, buildCheck('python_typecheck', 'Python TypeCheck', 'python -m mypy .'))
  }
  if (hasRuffToml || hasTomlSection(pyprojectText, 'tool.ruff')) {
    pushUnique(checks, buildCheck('python_lint', 'Python Lint', 'python -m ruff check .'))
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
      checks.push(buildCheck('java_test_gradle', 'Java Tests (Gradle)', './gradlew test --console=plain'))
    } else {
      checks.push(buildCheck('java_test_gradle', 'Java Tests (Gradle)', 'gradle test --console=plain'))
    }
    return checks
  }
  if (hasPom) {
    checks.push(buildCheck('java_test_maven', 'Java Tests (Maven)', 'mvn -B test'))
  }
  return checks
}

async function discoverMakeAndCmakeChecks(cwd: string): Promise<VerificationCheck[]> {
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
        checks.push(buildCheck('make_test', 'C/C++ Tests (make test)', 'make test'))
      } else if (/^[\t ]*check\s*:/m.test(makeText)) {
        checks.push(buildCheck('make_check', 'C/C++ Checks (make check)', 'make check'))
      }
    }
  }

  const hasCmakeProject = await fileExists(join(cwd, 'CMakeLists.txt'))
  const hasCTest =
    (await fileExists(join(cwd, 'CTestTestfile.cmake'))) ||
    (await fileExists(join(cwd, 'build', 'CTestTestfile.cmake'))) ||
    hasCmakeProject
  if (hasCTest) {
    checks.push(buildCheck('ctest', 'C/C++ Tests (ctest)', 'ctest --output-on-failure'))
  }
  return checks
}

async function discoverGoChecks(cwd: string): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = []
  if (!await fileExists(join(cwd, 'go.mod'))) return checks
  checks.push(buildCheck('go_test', 'Go Tests', 'go test ./...'))
  const hasGolangci =
    (await fileExists(join(cwd, '.golangci.yml'))) ||
    (await fileExists(join(cwd, '.golangci.yaml'))) ||
    (await fileExists(join(cwd, '.golangci.toml'))) ||
    (await fileExists(join(cwd, '.golangci.json')))
  if (hasGolangci) {
    checks.push(buildCheck('go_lint', 'Go Lint', 'golangci-lint run'))
  }
  return checks
}

async function discoverRustChecks(cwd: string): Promise<VerificationCheck[]> {
  if (!await fileExists(join(cwd, 'Cargo.toml'))) return []
  return [
    buildCheck('rust_test', 'Rust Tests', 'cargo test'),
    buildCheck('rust_lint', 'Rust Lint', 'cargo clippy --all-targets --all-features -- -D warnings')
  ]
}

async function discoverDotnetChecks(cwd: string): Promise<VerificationCheck[]> {
  const names = await readDirSafe(cwd)
  const hasDotnet = names.some((name) => name.endsWith('.sln') || name.endsWith('.csproj') || name.endsWith('.fsproj'))
  if (!hasDotnet) return []
  return [buildCheck('dotnet_test', '.NET Tests', 'dotnet test --nologo')]
}

async function discoverPhpChecks(cwd: string): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = []
  const composerText = await readTextIfExists(join(cwd, 'composer.json'))
  if (!composerText) return checks
  try {
    const parsed = JSON.parse(composerText) as { scripts?: Record<string, unknown> }
    if (parsed.scripts && Object.prototype.hasOwnProperty.call(parsed.scripts, 'test')) {
      checks.push(buildCheck('php_test', 'PHP Tests', 'composer test'))
      return checks
    }
  } catch {
    // keep fallback checks
  }
  if (await fileExists(join(cwd, 'phpunit.xml')) || await fileExists(join(cwd, 'phpunit.xml.dist'))) {
    checks.push(buildCheck('php_test', 'PHP Tests', 'vendor/bin/phpunit'))
  }
  return checks
}

async function discoverRubyChecks(cwd: string): Promise<VerificationCheck[]> {
  const checks: VerificationCheck[] = []
  const [hasGemfile, hasRakefile, hasRspec, hasSpecDir] = await Promise.all([
    fileExists(join(cwd, 'Gemfile')),
    fileExists(join(cwd, 'Rakefile')),
    fileExists(join(cwd, '.rspec')),
    directoryExists(join(cwd, 'spec'))
  ])
  if (!hasGemfile && !hasRakefile && !hasSpecDir && !hasRspec) return checks
  if (hasSpecDir || hasRspec) {
    checks.push(buildCheck('ruby_test_rspec', 'Ruby Tests (RSpec)', 'bundle exec rspec'))
  } else if (hasRakefile) {
    checks.push(buildCheck('ruby_test_rake', 'Ruby Tests (Rake)', 'bundle exec rake test'))
  }
  return checks
}

async function discoverElixirChecks(cwd: string): Promise<VerificationCheck[]> {
  if (!await fileExists(join(cwd, 'mix.exs'))) return []
  return [buildCheck('elixir_test', 'Elixir Tests', 'mix test')]
}

async function discoverSwiftChecks(cwd: string): Promise<VerificationCheck[]> {
  if (!await fileExists(join(cwd, 'Package.swift'))) return []
  return [buildCheck('swift_test', 'Swift Package Tests', 'swift test')]
}

async function discoverDartChecks(cwd: string): Promise<VerificationCheck[]> {
  const pubspec = await readTextIfExists(join(cwd, 'pubspec.yaml'))
  if (!pubspec) return []
  if (/^\s*flutter\s*:/m.test(pubspec)) {
    return [buildCheck('flutter_test', 'Flutter Tests', 'flutter test')]
  }
  return [buildCheck('dart_test', 'Dart Tests', 'dart test')]
}

export async function discoverVerificationChecks(cwd: string): Promise<VerificationCheck[]> {
  const customChecks = await loadCustomChecks(cwd)
  if (customChecks && customChecks.length > 0) {
    return customChecks
  }

  // CI workflow commands are project-defined and language-agnostic.
  const ciChecks = await discoverCiChecks(cwd)
  if (ciChecks.length > 0) {
    return ciChecks
  }

  const checks: VerificationCheck[] = []
  const discovered = await Promise.all([
    discoverNodeChecks(cwd),
    discoverPythonChecks(cwd),
    discoverJavaChecks(cwd),
    discoverMakeAndCmakeChecks(cwd),
    discoverGoChecks(cwd),
    discoverRustChecks(cwd),
    discoverDotnetChecks(cwd),
    discoverPhpChecks(cwd),
    discoverRubyChecks(cwd),
    discoverElixirChecks(cwd),
    discoverSwiftChecks(cwd),
    discoverDartChecks(cwd)
  ])
  for (const group of discovered) {
    for (const check of group) {
      pushUnique(checks, check)
    }
  }
  return checks
}
