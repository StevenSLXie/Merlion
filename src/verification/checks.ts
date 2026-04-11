import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface VerificationCheck {
  id: string
  name: string
  command: string
  requiresEnv?: string[]
}

interface PackageJsonLike {
  scripts?: Record<string, string>
}

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

export async function discoverVerificationChecks(cwd: string): Promise<VerificationCheck[]> {
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

  return checks
}
