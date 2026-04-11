import { loadAgentsGuidance } from '../artifacts/agents.ts'
import { ensureCodebaseIndex, readCodebaseIndex } from '../artifacts/codebase_index.ts'
import { ensureProgressArtifact, readProgressArtifact } from '../artifacts/progress.ts'

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

const DEFAULT_BUDGETS: OrientationBudgets = {
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

export async function buildOrientationContext(
  cwd: string,
  options?: Partial<OrientationBudgets>
): Promise<OrientationResult> {
  const budgets: OrientationBudgets = {
    ...DEFAULT_BUDGETS,
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
    loadAgentsGuidance(cwd, { maxTokens: safeBudgets.agentsTokens }),
    readProgressArtifact(cwd, { maxTokens: safeBudgets.progressTokens }),
    readCodebaseIndex(cwd, { maxTokens: safeBudgets.indexTokens }),
  ])

  let sectionStates: OrientationResult['sections'] = [
    {
      name: 'agents',
      tokensEstimate: agents.tokensEstimate,
      included: agents.text.trim() !== '',
      truncated: agents.truncated,
    },
    {
      name: 'progress',
      tokensEstimate: progress.tokensEstimate,
      included: progress.text.trim() !== '',
      truncated: progress.truncated,
    },
    {
      name: 'index',
      tokensEstimate: index.tokensEstimate,
      included: index.text.trim() !== '',
      truncated: index.truncated,
    },
  ]

  let sections = [
    agents.text.trim() !== '' ? `### AGENTS Guidance\n${agents.text}` : '',
    progress.text.trim() !== '' ? `### Progress Snapshot\n${progress.text}` : '',
    index.text.trim() !== '' ? `### Codebase Index\n${index.text}` : '',
  ].filter((x) => x !== '')

  let merged = sections.join('\n\n')
  let truncated = sectionStates.some((s) => s.truncated)
  let totalTokens = estimateTokens(merged)

  if (totalTokens > safeBudgets.totalTokens) {
    const keepAgents = sections[0] ?? ''
    const keepProgress = sections[1] ?? ''
    const keepIndex = sections[2] ?? ''

    const agentsTokens = estimateTokens(keepAgents)
    const remaining = Math.max(0, safeBudgets.totalTokens - agentsTokens)
    const progressBudget = Math.min(estimateTokens(keepProgress), Math.floor(remaining * 0.45))
    const indexBudget = Math.max(0, remaining - progressBudget)

    const clippedProgress = truncateToTokens(keepProgress, progressBudget)
    const clippedIndex = truncateToTokens(keepIndex, indexBudget)

    const rebuilt = [keepAgents, clippedProgress.text, clippedIndex.text].filter((x) => x.trim() !== '')
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
