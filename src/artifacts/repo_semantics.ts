import { readdir } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

export interface OrientationBudgetPreset {
  totalTokens: number
  agentsTokens: number
  progressTokens: number
  indexTokens: number
}

export interface BootstrapDepthPreset {
  maxTopDirs: number
  maxSecondLevelDirs: number
}

export interface DirectorySignalSummary {
  sampledFiles: number
  topExtensions: string[]
  hasFrontendSignals: boolean
  hasBackendSignals: boolean
  hasTestSignals: boolean
  hasDocSignals: boolean
  hasScriptSignals: boolean
}

const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.merlion',
  'dist',
  'build',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
  '.mypy_cache',
  '.idea',
  '.vscode',
  'coverage',
  '.coverage',
])

const KNOWN_PURPOSE_BY_DIRNAME: Record<string, string> = {
  src: 'Primary application source code.',
  app: 'App entrypoints and route-level integration code.',
  apps: 'Multiple runnable applications or surfaces.',
  tests: 'Automated tests and test fixtures.',
  test: 'Automated tests and test fixtures.',
  docs: 'Project documentation and reference material.',
  doc: 'Project documentation and reference material.',
  scripts: 'Developer automation scripts and maintenance utilities.',
  script: 'Developer automation scripts and maintenance utilities.',
  config: 'Configuration and environment defaults.',
  configs: 'Configuration and environment defaults.',
  package: 'Package-level code for reusable modules.',
  packages: 'Package-level code for reusable modules.',
  services: 'Service/domain modules and business flows.',
  service: 'Service/domain modules and business flows.',
  lib: 'Shared library utilities used across modules.',
  libs: 'Shared library utilities used across modules.',
  public: 'Static assets exposed directly to clients.',
  assets: 'Static assets and media resources.',
  frontend: 'Frontend UI implementation.',
  backend: 'Backend service implementation.',
}

function dominantExtensions(extCounts: Map<string, number>, topN = 2): string[] {
  return [...extCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([ext]) => ext)
}

function normalizeExt(name: string): string {
  const ext = extname(name).toLowerCase()
  return ext === '' ? '(no-ext)' : ext
}

function isIgnoredDir(name: string): boolean {
  return name.startsWith('.') || DEFAULT_IGNORED_DIRS.has(name)
}

export async function estimateRepositoryFileCount(root: string, max = 5000): Promise<number> {
  let count = 0

  async function walk(dir: string): Promise<void> {
    if (count >= max) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (count >= max) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (isIgnoredDir(entry.name)) continue
        await walk(full)
        continue
      }
      if (entry.isFile()) count += 1
    }
  }

  await walk(root)
  return count
}

export function orientationBudgetsForFileCount(fileCount: number): OrientationBudgetPreset {
  if (fileCount <= 500) {
    return {
      totalTokens: 2500,
      agentsTokens: 1200,
      progressTokens: 450,
      indexTokens: 850,
    }
  }
  if (fileCount <= 2000) {
    return {
      totalTokens: 2000,
      agentsTokens: 950,
      progressTokens: 350,
      indexTokens: 700,
    }
  }
  return {
    totalTokens: 1600,
    agentsTokens: 760,
    progressTokens: 300,
    indexTokens: 540,
  }
}

export function bootstrapDepthForFileCount(fileCount: number): BootstrapDepthPreset {
  if (fileCount <= 500) {
    return {
      maxTopDirs: 16,
      maxSecondLevelDirs: 14,
    }
  }
  if (fileCount <= 2000) {
    return {
      maxTopDirs: 22,
      maxSecondLevelDirs: 20,
    }
  }
  return {
    maxTopDirs: 28,
    maxSecondLevelDirs: 26,
  }
}

export async function collectDirectorySignals(directory: string, sampleLimit = 120): Promise<DirectorySignalSummary> {
  let sampledFiles = 0
  const extCounts = new Map<string, number>()
  let hasFrontendSignals = false
  let hasBackendSignals = false
  let hasTestSignals = false
  let hasDocSignals = false
  let hasScriptSignals = false

  async function walk(dir: string, depth: number): Promise<void> {
    if (sampledFiles >= sampleLimit || depth > 3) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (sampledFiles >= sampleLimit) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (isIgnoredDir(entry.name)) continue
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue

      sampledFiles += 1
      const ext = normalizeExt(entry.name)
      extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1)

      const lower = entry.name.toLowerCase()
      if (/(test|spec)\./.test(lower)) hasTestSignals = true
      if (['.md', '.mdx', '.rst'].includes(ext)) hasDocSignals = true
      if (['.sh', '.bash', '.zsh', '.ps1'].includes(ext) || lower.includes('script')) hasScriptSignals = true
      if (['.tsx', '.jsx', '.css', '.scss', '.html'].includes(ext)) hasFrontendSignals = true
      if (['.py', '.go', '.rs', '.java', '.kt', '.rb'].includes(ext)) hasBackendSignals = true
    }
  }

  await walk(directory, 0)

  return {
    sampledFiles,
    topExtensions: dominantExtensions(extCounts, 3),
    hasFrontendSignals,
    hasBackendSignals,
    hasTestSignals,
    hasDocSignals,
    hasScriptSignals,
  }
}

export function inferPurposeFromDirectoryName(dirname: string): string | null {
  return KNOWN_PURPOSE_BY_DIRNAME[dirname.toLowerCase()] ?? null
}

export function inferDirectoryPurpose(params: {
  root: string
  directory: string
  signals?: DirectorySignalSummary
}): string {
  const rel = relative(params.root, params.directory).replace(/\\/g, '/') || '.'
  const dirname = rel === '.' ? '.' : rel.split('/').pop() ?? rel

  if (dirname !== '.') {
    const known = inferPurposeFromDirectoryName(dirname)
    if (known) return known
  }

  const signals = params.signals
  if (!signals) {
    return 'Directory scope for module-specific logic and related assets.'
  }

  if (signals.hasTestSignals && !signals.hasFrontendSignals && !signals.hasBackendSignals) {
    return 'Test-heavy directory for validation scenarios and regression checks.'
  }
  if (signals.hasDocSignals && signals.sampledFiles <= 40) {
    return 'Documentation-oriented directory for project references and notes.'
  }
  if (signals.hasScriptSignals && !signals.hasFrontendSignals && !signals.hasBackendSignals) {
    return 'Automation-focused directory for scripts and maintenance tasks.'
  }
  if (signals.hasFrontendSignals && !signals.hasBackendSignals) {
    return 'Frontend-focused directory for UI composition and presentation logic.'
  }
  if (signals.hasBackendSignals && !signals.hasFrontendSignals) {
    return 'Backend/service-focused directory for runtime and domain logic.'
  }

  const topExt = signals.topExtensions.slice(0, 2).join(', ')
  if (topExt !== '') {
    return `General module directory (dominant file types: ${topExt}).`
  }

  return 'General module directory for implementation and support files.'
}
