export type UserInputEnvelope =
  | { kind: 'empty' }
  | { kind: 'prompt'; text: string }
  | { kind: 'shell_shortcut'; command: string }
  | { kind: 'slash_command'; name: string; raw: string }
  | { kind: 'local_action'; action: 'exit' | 'help' | 'set_detail'; payload?: unknown }

export interface RuntimeSlashCommand {
  name: string
  description: string
}
