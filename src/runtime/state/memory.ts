import { resolve } from 'node:path'

import type { MemoryState } from './types.ts'

export function recordLoadedMemoryPath(state: MemoryState, path: string, source?: string): void {
  const normalized = resolve(path)
  state.loadedMemoryPaths.add(normalized)
  if (source && source.trim() !== '') state.sourceProvenance.set(normalized, source.trim())
}

export function recordNestedMemoryExpansion(state: MemoryState, path: string): void {
  state.nestedMemoryExpansions.add(resolve(path))
}
