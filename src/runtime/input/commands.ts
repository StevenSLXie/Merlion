import type { RuntimeSlashCommand } from './types.ts'

const SYSTEM_SLASH_COMMANDS: RuntimeSlashCommand[] = [
  {
    name: 'undo',
    description: 'Restore the current session checkpoint.',
  },
  {
    name: 'wechat',
    description: 'Start WeChat login + listen mode.',
  },
]

export function getRuntimeSlashCommands(): RuntimeSlashCommand[] {
  return [...SYSTEM_SLASH_COMMANDS]
}
