export type PromptSectionCachePolicy = 'session' | 'volatile'

export interface PromptSectionSpec {
  id: string
  resolve: () => string | null | Promise<string | null>
  cachePolicy?: PromptSectionCachePolicy
}

export interface ResolvedPromptSection {
  id: string
  text: string
  cachePolicy: PromptSectionCachePolicy
  fromCache: boolean
}

export interface PromptSectionCache {
  get: (id: string) => string | null | undefined
  set: (id: string, value: string | null) => void
  clear: () => void
}

export function createPromptSectionCache(): PromptSectionCache {
  const store = new Map<string, string | null>()
  return {
    get(id) {
      return store.get(id)
    },
    set(id, value) {
      store.set(id, value)
    },
    clear() {
      store.clear()
    }
  }
}

export async function resolvePromptSections(
  specs: PromptSectionSpec[],
  cache: PromptSectionCache
): Promise<ResolvedPromptSection[]> {
  const resolved: ResolvedPromptSection[] = []

  for (const spec of specs) {
    const cachePolicy: PromptSectionCachePolicy = spec.cachePolicy ?? 'session'
    if (cachePolicy === 'session') {
      const hit = cache.get(spec.id)
      if (hit !== undefined) {
        if (hit !== null && hit.trim() !== '') {
          resolved.push({
            id: spec.id,
            text: hit,
            cachePolicy,
            fromCache: true
          })
        }
        continue
      }
    }

    const text = await spec.resolve()
    const normalized = typeof text === 'string' ? text.trim() : ''
    if (cachePolicy === 'session') {
      cache.set(spec.id, normalized === '' ? null : normalized)
    }
    if (normalized === '') continue
    resolved.push({
      id: spec.id,
      text: normalized,
      cachePolicy,
      fromCache: false
    })
  }

  return resolved
}

export function joinPromptSections(sections: Array<string | null | undefined>): string {
  return sections
    .map((section) => (typeof section === 'string' ? section.trim() : ''))
    .filter((section) => section !== '')
    .join('\n\n')
}
