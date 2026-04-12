import { findProjectRoot, loadAgentsGuidance } from '../artifacts/agents.ts'
import { ensureCodebaseIndex, readCodebaseIndex } from '../artifacts/codebase_index.ts'
import { ensureProgressArtifact, readProgressArtifact } from '../artifacts/progress.ts'
import { estimateRepositoryFileCount, orientationBudgetsForFileCount } from '../artifacts/repo_semantics.ts'

export interface OrientationBudgets {
  totalTokens: number
  agentsTokens: number
  progressTokens: number
  indexTokens: number
}

export interface OrientationResult {
  text: string
  tokensEstimate: number
  truncated: boolean
  sections: Array<{
    name: 'agents' | 'progress' | 'index'
    tokensEstimate: number
    included: boolean
    truncated: boolean
  }>
}

const FALLBACK_BUDGETS: OrientationBudgets = {
  totalTokens: 1200,
  agentsTokens: 500,
  progressTokens: 300,
  indexTokens: 400,
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: '', truncated: text.length > 0 }
  const maxChars = maxTokens * 4
  if (text.length <= maxChars) return { text, truncated: false }
  return {
    text: `${text.slice(0, Math.max(0, maxChars - 45))}\n\n[...orientation section truncated...]`,
    truncated: true,
  }
}

async function defaultBudgetsForCwd(cwd: string): Promise<OrientationBudgets> {
  try {
    const root = await findProjectRoot(cwd)
    const fileCount = await estimateRepositoryFileCount(root, 3000)
    return orientationBudgetsForFileCount(fileCount)
  } catch {
    return FALLBACK_BUDGETS
  }
}

export async function buildOrientationContext(
  cwd: string,
  options?: Partial<OrientationBudgets>
): Promise<OrientationResult> {
  const baseline = await defaultBudgetsForCwd(cwd)
  const budgets: OrientationBudgets = {
    ...baseline,
    ...options,
  }

  const safeBudgets: OrientationBudgets = {
    totalTokens: Math.max(0, Math.floor(budgets.totalTokens)),
    agentsTokens: Math.max(0, Math.floor(budgets.agentsTokens)),
    progressTokens: Math.max(0, Math.floor(budgets.progressTokens)),
    indexTokens: Math.max(0, Math.floor(budgets.indexTokens)),
  }

  await ensureProgressArtifact(cwd)
  await ensureCodebaseIndex(cwd)

  const [agents, progress, index] = await Promise.all([
    loadAgentsGuidance(cwd, {
      maxTokens: safeBudgets.agentsTokens,
      includeMajorScopes: true,
      maxMajorScopes: 4,
    }),
    readProgressArtifact(cwd, { maxTokens: safeBudgets.progressTokens }),
    readCodebaseIndex(cwd, { maxTokens: safeBudgets.indexTokens }),
  ])

  const sections: Array<{
    name: 'agents' | 'progress' | 'index'
    header: string
    text: string
    truncated: boolean
  }> = [
    { name: 'agents', header: '### AGENTS Guidance', text: agents.text, truncated: agents.truncated },
    { name: 'progress', header: '### Progress Snapshot', text: progress.text, truncated: progress.truncated },
    { name: 'index', header: '### Codebase Index', text: index.text, truncated: index.truncated },
  ]

  const assembled = sections
    .filter((section) => section.text.trim() !== '')
    .map((section) => `${section.header}\n${section.text}`)

  let merged = assembled.join('\n\n')
  let totalTokens = estimateTokens(merged)
  let truncated = sections.some((section) => section.truncated)

  let sectionStates: OrientationResult['sections'] = sections.map((section) => {
    const payload = section.text.trim() === '' ? '' : `${section.header}\n${section.text}`
    return {
      name: section.name,
      tokensEstimate: estimateTokens(payload),
      included: payload.trim() !== '',
      truncated: section.truncated,
    }
  })

  if (totalTokens > safeBudgets.totalTokens) {
    const agentsSection = sections.find((section) => section.name === 'agents')
    const progressSection = sections.find((section) => section.name === 'progress')
    const indexSection = sections.find((section) => section.name === 'index')

    const keepAgents = agentsSection && agentsSection.text.trim() !== ''
      ? `${agentsSection.header}\n${agentsSection.text}`
      : ''
    const keepAgentsTokens = estimateTokens(keepAgents)
    const remaining = Math.max(0, safeBudgets.totalTokens - keepAgentsTokens)

    const rawProgress = progressSection && progressSection.text.trim() !== ''
      ? `${progressSection.header}\n${progressSection.text}`
      : ''
    const rawIndex = indexSection && indexSection.text.trim() !== ''
      ? `${indexSection.header}\n${indexSection.text}`
      : ''

    const rawProgressTokens = estimateTokens(rawProgress)
    const rawIndexTokens = estimateTokens(rawIndex)
    const denominator = Math.max(1, rawProgressTokens + rawIndexTokens)
    const progressBudget = Math.floor((rawProgressTokens / denominator) * remaining)
    const indexBudget = Math.max(0, remaining - progressBudget)

    const clippedProgress = truncateToTokens(rawProgress, progressBudget)
    const clippedIndex = truncateToTokens(rawIndex, indexBudget)

    const rebuilt = [keepAgents, clippedProgress.text, clippedIndex.text].filter((item) => item.trim() !== '')
    merged = rebuilt.join('\n\n')
    totalTokens = estimateTokens(merged)
    truncated = true

    sectionStates = sectionStates.map((section) => {
      if (section.name === 'progress') {
        return {
          ...section,
          tokensEstimate: estimateTokens(clippedProgress.text),
          truncated: section.truncated || clippedProgress.truncated,
          included: clippedProgress.text.trim() !== '',
        }
      }
      if (section.name === 'index') {
        return {
          ...section,
          tokensEstimate: estimateTokens(clippedIndex.text),
          truncated: section.truncated || clippedIndex.truncated,
          included: clippedIndex.text.trim() !== '',
        }
      }
      return section
    })
  }

  return {
    text: merged.trim(),
    tokensEstimate: totalTokens,
    truncated,
    sections: sectionStates,
  }
}
