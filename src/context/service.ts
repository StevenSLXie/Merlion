import { loadAgentsGuidance } from '../artifacts/agents.ts'
import { ensureGeneratedAgentsMaps } from '../artifacts/agents_bootstrap.ts'
import { refreshCodebaseIndex } from '../artifacts/codebase_index.ts'
import { buildOrientationContext, type OrientationBudgets } from './orientation.ts'
import {
  buildPathGuidanceDelta,
  createPathGuidanceState,
  extractCandidatePathsFromText,
  extractCandidatePathsFromToolEvent,
  type PathGuidanceOptions,
  type PathGuidanceState,
  type PathSignalToolEvent,
} from './path_guidance.ts'
import { buildMerlionSystemPrompt } from '../prompt/system_prompt.ts'
import { createPromptSectionCache, type PromptSectionCache } from '../prompt/sections.ts'
import { resolveContextTrustLevel, shouldPrefetchExpensiveContext, type ContextTrustLevel } from './policies.ts'
import { createSystemItem, type ConversationItem } from '../runtime/items.ts'

export interface RuntimeContextBootstrapResult {
  initialItems: ConversationItem[]
  startupMapSummary: string | null
  generatedMapMode: boolean
}

export interface ContextServiceOptions {
  cwd: string
  permissionMode?: 'interactive' | 'auto_allow' | 'auto_deny'
  orientationBudgets?: Partial<OrientationBudgets>
  pathGuidanceBudgets?: Partial<PathGuidanceOptions>
  promptSectionCache?: PromptSectionCache
}

export interface ContextService {
  getTrustLevel(): ContextTrustLevel
  getPathGuidanceState(): PathGuidanceState
  getGeneratedMapMode(): boolean
  setGeneratedMapMode(value: boolean): void
  prefetchIfSafe(): Promise<RuntimeContextBootstrapResult>
  getSystemPrompt(): Promise<string>
  buildPromptPrelude(prompt: string): Promise<ConversationItem[]>
  buildPathGuidanceItems(candidatePaths: string[]): Promise<{ items: ConversationItem[]; loadedFiles: string[] }>
  extractCandidatePathsFromText(content: string): Promise<string[]>
  extractCandidatePathsFromToolEvent(event: PathSignalToolEvent): Promise<string[]>
}

export function createContextService(options: ContextServiceOptions): ContextService {
  const promptSectionCache = options.promptSectionCache ?? createPromptSectionCache()
  const pathGuidanceState = createPathGuidanceState()
  const trustLevel = resolveContextTrustLevel({ permissionMode: options.permissionMode })
  let startupMapSummary: string | null = null
  let generatedMapMode = false
  let systemPromptPromise: Promise<string> | null = null

  async function seedPathGuidanceState(): Promise<void> {
    try {
      const seeded = await loadAgentsGuidance(options.cwd, { maxTokens: 1 })
      if (seeded.files.some((file) => file.replace(/\\/g, '/').includes('/.merlion/maps/'))) {
        generatedMapMode = true
      }
      for (const file of seeded.files) pathGuidanceState.loadedAgentFiles.add(file)
    } catch (error) {
      process.stderr.write(`Path guidance seed warning: ${String(error)}\n`)
    }
  }

  return {
    getTrustLevel() {
      return trustLevel
    },
    getPathGuidanceState() {
      return pathGuidanceState
    },
    getGeneratedMapMode() {
      return generatedMapMode
    },
    setGeneratedMapMode(value) {
      generatedMapMode = value
    },
    async prefetchIfSafe(): Promise<RuntimeContextBootstrapResult> {
      const initialItems: ConversationItem[] = []
      if (shouldPrefetchExpensiveContext(trustLevel)) {
        try {
          const bootstrap = await ensureGeneratedAgentsMaps(options.cwd)
          generatedMapMode =
            bootstrap.created ||
            bootstrap.generatedFiles.some((file) => file.replace(/\\/g, '/').includes('.merlion/maps/'))
          if (bootstrap.created) {
            startupMapSummary =
              `initialized generated project map (${bootstrap.generatedFiles.length} scope` +
              `${bootstrap.generatedFiles.length === 1 ? '' : 's'})`
          } else if (bootstrap.generatedFiles.length > 0) {
            startupMapSummary =
              `generated project map up to date (${bootstrap.generatedFiles.length} scope` +
              `${bootstrap.generatedFiles.length === 1 ? '' : 's'})`
          }
        } catch (error) {
          process.stderr.write(`Agents map bootstrap warning: ${String(error)}\n`)
        }
        try {
          await refreshCodebaseIndex(options.cwd)
          const orientation = await buildOrientationContext(options.cwd, options.orientationBudgets)
          if (orientation.text.trim() !== '') {
            initialItems.push(
              createSystemItem(
                'Project orientation context. Use this as a starting map, then verify with tools before edits.\n\n' +
                  orientation.text,
                'runtime',
              ),
            )
          }
        } catch (error) {
          process.stderr.write(`Orientation build warning: ${String(error)}\n`)
        }
      }

      await seedPathGuidanceState()
      return {
        initialItems,
        startupMapSummary,
        generatedMapMode,
      }
    },
    async getSystemPrompt(): Promise<string> {
      if (!systemPromptPromise) {
        systemPromptPromise = buildMerlionSystemPrompt({
          cwd: options.cwd,
          sectionCache: promptSectionCache,
        }).then((result) => result.text)
      }
      return await systemPromptPromise
    },
    async buildPromptPrelude(prompt: string): Promise<ConversationItem[]> {
      const promptPathCandidates = new Set<string>()
      for (const candidate of await extractCandidatePathsFromText(options.cwd, prompt)) {
        promptPathCandidates.add(candidate)
      }
      if (promptPathCandidates.size === 0) return []
      const seededList = [...promptPathCandidates].slice(0, 8)
      const items: ConversationItem[] = [
        createSystemItem(
          [
            'User-specified target paths detected.',
            'Inspect these paths, or their nearest directories/tests, before any repo-wide recursive exploration.',
            'Only widen scope if these paths are missing, invalid, or insufficient for the task.',
            ...seededList.map((item) => `- ${item}`),
          ].join('\n'),
          'runtime',
        ),
      ]
      const promptDelta = await buildPathGuidanceDelta(
        options.cwd,
        seededList,
        pathGuidanceState,
        options.pathGuidanceBudgets,
      )
      if (promptDelta.text.trim() !== '') {
        items.push(
          createSystemItem(
            'Prompt-derived path guidance. Use this to focus your first tool calls.\n\n' + promptDelta.text,
            'runtime',
          ),
        )
      }
      return items
    },
    async buildPathGuidanceItems(candidatePaths: string[]) {
      const delta = await buildPathGuidanceDelta(
        options.cwd,
        candidatePaths,
        pathGuidanceState,
        options.pathGuidanceBudgets,
      )
      if (delta.text.trim() === '') return { items: [], loadedFiles: [] }
      return {
        loadedFiles: delta.loadedFiles,
        items: [
          createSystemItem(
            'Path guidance update. Use this to narrow your next tool calls before broad scans.\n\n' +
              delta.text,
            'runtime',
          ),
        ],
      }
    },
    async extractCandidatePathsFromText(content: string) {
      return await extractCandidatePathsFromText(options.cwd, content)
    },
    async extractCandidatePathsFromToolEvent(event: PathSignalToolEvent) {
      return await extractCandidatePathsFromToolEvent(options.cwd, event)
    },
  }
}
