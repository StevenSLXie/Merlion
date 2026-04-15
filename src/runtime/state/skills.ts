import type { SkillState } from './types.ts'

export function recordDiscoveredSkillNames(state: SkillState, names: string[]): void {
  for (const name of names) {
    const normalized = name.trim()
    if (normalized !== '') state.discoveredSkillNames.add(normalized)
  }
}

export function recordActivatedSkill(state: SkillState, name: string, payloadId?: string): void {
  const normalized = name.trim()
  if (normalized === '') return
  state.activatedSkillNames.add(normalized)
  state.activationCounts.set(normalized, (state.activationCounts.get(normalized) ?? 0) + 1)
  if (payloadId && payloadId.trim() !== '') state.injectedSkillPayloadIds.add(payloadId.trim())
}
