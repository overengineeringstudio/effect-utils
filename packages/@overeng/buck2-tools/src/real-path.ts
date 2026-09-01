import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

const isMissingPath = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')

/**
 * Resolves a path to its symlink-free form without requiring it to exist yet.
 *
 * Containment checks compare a candidate against a root. Both sides must live
 * in the same namespace or the comparison is meaningless: on macOS `/tmp` is a
 * symlink to `/private/tmp`, so a realpath-ed root and a caller-supplied
 * `/tmp/...` candidate never share a prefix even when the candidate is plainly
 * inside the root. `realpathSync` alone cannot canonicalize the candidate
 * because it throws on a path the caller has not created yet, so canonicalize
 * the deepest existing ancestor and re-attach the components below it.
 *
 * Where no ancestor is a symlink this is the identity, so paths under a
 * non-symlinked root (every Linux `/tmp` path, and every path already derived
 * from a canonical root) are returned unchanged.
 */
export const canonicalizePath = (path: string): string => {
  const absolute = resolve(path)
  const trailing: string[] = []
  let existing = absolute
  for (;;) {
    try {
      return join(realpathSync(existing), ...trailing)
    } catch (error) {
      if (isMissingPath(error) === false) throw error
    }
    const parent = dirname(existing)
    if (parent === existing) return absolute
    trailing.unshift(basename(existing))
    existing = parent
  }
}
