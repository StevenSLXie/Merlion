import type { PermissionDecision, PermissionStore } from '../../tools/types.js'
import type { PermissionState } from './types.ts'

function signatureForDecision(tool: string, description: string): string {
  return `${tool}:${description.trim()}`
}

export function createTrackingPermissionStore(
  base: PermissionStore,
  state: PermissionState,
): PermissionStore {
  return {
    async ask(tool: string, description: string): Promise<PermissionDecision> {
      const decision = await base.ask(tool, description)
      state.lastDecision = {
        tool,
        description,
        decision,
        at: new Date().toISOString(),
      }
      if (decision === 'deny') {
        state.deniedToolNames.add(tool)
        state.deniedToolSignatures.add(signatureForDecision(tool, description))
      }
      if (decision === 'allow_session') {
        state.sessionAllowedToolNames.add(tool)
      }
      return decision
    },
  }
}
