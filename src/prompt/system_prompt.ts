import type { PromptSectionCache, ResolvedPromptSection } from './sections.ts'
import { joinPromptSections, resolvePromptSections } from './sections.ts'

export interface BuildSystemPromptOptions {
  cwd: string
  sectionCache: PromptSectionCache
}

export interface BuildSystemPromptResult {
  text: string
  sections: ResolvedPromptSection[]
}

export const SYSTEM_PROMPT_STATIC_SECTIONS: string[] = [
  'You are Merlion, a coding agent. Use tools to complete the task.',
  [
    'Use path-guided exploration:',
    '1) pick 1-3 candidate directories from loaded AGENTS/context before broad search,',
    '2) search/read inside candidates first,',
    '3) widen scope only when evidence is insufficient,',
    '4) when AGENTS guidance conflicts, nearest directory scope wins.'
  ].join(' '),
  [
    'Bug-fix discipline:',
    'when the task is fixing a bug/regression, treat failing tests, logs, and repro steps as specification,',
    'prefer implementation/source edits before test edits,',
    'and only rewrite tests first when the user explicitly asks or strong evidence shows the tests are wrong.'
  ].join(' ')
]

export async function buildMerlionSystemPrompt(
  options: BuildSystemPromptOptions
): Promise<BuildSystemPromptResult> {
  const dynamicSections = await resolvePromptSections(
    [
      {
        id: 'workspace_scope',
        resolve: () =>
          [
            'Workspace scope:',
            `- Root path: ${options.cwd}`,
            `- Project helper artifacts, if needed, must be under ${options.cwd}/.merlion (project-local only).`,
            '- Never infer hidden alternate roots.'
          ].join('\n')
      },
      {
        id: 'tool_call_contract',
        resolve: () =>
          [
            'Tool call contract:',
            '- Always pass strict JSON arguments.',
            '- Prefer dedicated file/search tools before shell for repo operations.',
            '- If a tool call fails, inspect error and adjust arguments; do not retry the identical invalid call repeatedly.'
          ].join('\n')
      }
    ],
    options.sectionCache
  )

  const text = joinPromptSections([
    ...SYSTEM_PROMPT_STATIC_SECTIONS,
    ...dynamicSections.map((section) => section.text)
  ])

  return {
    text,
    sections: dynamicSections
  }
}
