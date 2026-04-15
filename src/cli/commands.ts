export interface SlashCommand {
  name: string
  description: string
}

const SYSTEM_SLASH_COMMANDS: SlashCommand[] = [
  {
    name: 'wechat',
    description: 'Start WeChat login + listen mode.',
  },
]

export function getSystemSlashCommands(): SlashCommand[] {
  return [...SYSTEM_SLASH_COMMANDS]
}
