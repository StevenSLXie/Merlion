import type { PermissionDecision, PermissionRequest, PermissionStore } from '../../tools/types.js'
import type { PermissionState } from './types.ts'

function permissionScope(tool: string, request?: PermissionRequest): string {
  const scope = request?.sessionScope?.trim()
  return scope && scope !== '' ? scope : tool
}

function signatureForDecision(tool: string, description: string, request?: PermissionRequest): string {
  return `${permissionScope(tool, request)}:${description.trim()}`
}

export function createTrackingPermissionStore(
  base: PermissionStore,
  state: PermissionState,
): PermissionStore {
  return {
    async ask(tool: string, description: string, request?: PermissionRequest): Promise<PermissionDecision> {
      const scope = permissionScope(tool, request)
      const decision = await base.ask(tool, description, request)
      state.lastDecision = {
        tool,
        description,
        scope,
        decision,
        at: new Date().toISOString(),
      }
      if (decision === 'deny') {
        state.deniedToolNames.add(tool)
        state.deniedToolSignatures.add(signatureForDecision(tool, description, request))
      }
      if (decision === 'allow_session') {
        state.sessionAllowedScopes.add(scope)
      }
      return decision
    },
  }
}
