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
