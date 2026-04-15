import type { RuntimeSlashCommand } from './types.ts'

const SYSTEM_SLASH_COMMANDS: RuntimeSlashCommand[] = [
  {
    name: 'wechat',
    description: 'Start WeChat login + listen mode.',
  },
]

export function getRuntimeSlashCommands(): RuntimeSlashCommand[] {
  return [...SYSTEM_SLASH_COMMANDS]
}
