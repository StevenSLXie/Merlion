import type { SlashCommand } from './commands.ts'

export interface SlashSuggestion {
  name: string
  description: string
}

export function getSlashSuggestions(input: string, commands: SlashCommand[]): SlashSuggestion[] {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return []
  const query = trimmed.slice(1).toLowerCase()
  return commands
    .filter((command) => query === '' || command.name.toLowerCase().startsWith(query))
    .map((command) => ({
      name: `/${command.name}`,
      description: command.description,
    }))
}

export function formatInlineCompletionPreview(suggestions: SlashSuggestion[], maxItems = 3): string {
  if (suggestions.length === 0) return ''
  const shown = suggestions.slice(0, maxItems).map((item) => item.name)
  const suffix = suggestions.length > shown.length ? ' …' : ''
  return ` [slash: ${shown.join(', ')}${suffix}]`
}
