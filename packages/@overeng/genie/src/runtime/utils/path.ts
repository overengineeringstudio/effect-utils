/**
 * Pure POSIX-style path join for genie's isomorphic (`.`) builders/validators.
 *
 * Avoids `node:path` so the modules that build lockfile/tsconfig paths stay out of the `.` entry's node
 * closure. Genie operates on repo-relative POSIX paths (and POSIX `cwd`); this joins non-empty segments with
 * `/` and collapses accidental duplicate separators. It does not resolve `.`/`..` — genie never joins those.
 */
export const joinPath = (...segments: readonly string[]): string =>
  segments
    .filter((segment) => segment.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/')

/** Normalize a relative POSIX path without resolving it against a filesystem root. */
export const normalizeRelativePath = (path: string): string => {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..' && parts.length > 0 && parts.at(-1) !== '..') {
      parts.pop()
    } else {
      parts.push(part)
    }
  }
  return parts.length === 0 ? '.' : parts.join('/')
}
