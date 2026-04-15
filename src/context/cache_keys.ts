export function buildContextCacheKey(parts: Array<string | number | boolean | null | undefined>): string {
  return parts
    .map((part) => String(part ?? ''))
    .join(':')
}

export function buildContextInvalidationKeysFromPaths(paths: string[]): string[] {
  const out = new Set<string>()
  for (const path of paths) {
    const normalized = path.replace(/\\/g, '/').trim()
    if (normalized === '') continue
    out.add(`path:${normalized}`)
    out.add('codebase_index')
    out.add('path_guidance')
  }
  return [...out]
}
