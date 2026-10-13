import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'

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

/**
 * Canonicalizes everything above the final path component, keeping that
 * component verbatim.
 *
 * Use this for a caller-supplied path that a later check inspects with
 * `lstat`: `canonicalizePath` would resolve a symlinked leaf and quietly defeat
 * a "must not be a symlink" guard, while the containment question is only ever
 * about the directories above it.
 */
export const canonicalizeParent = (path: string): string => {
  const absolute = resolve(path)
  const parent = dirname(absolute)
  if (parent === absolute) return absolute
  return join(canonicalizePath(parent), basename(absolute))
}

/** Bound on one symlink chain, matching the kernel's own `ELOOP` limit. */
const MAX_SYMLINK_HOPS = 40

/**
 * Resolves a path to its symlink-free form, spelled through the name the path
 * itself reaches rather than through whichever hard link the kernel reports.
 *
 * Bun's `realpathSync` opens the path and asks the kernel for the descriptor's
 * path. On Darwin that is `fcntl(F_GETPATH)`, which answers with the name the
 * vnode last carried: for a file with several hard links it may return any of
 * them. A hardlink farm gives every imaged file a second name, so a plain
 * realpath of a link into a declared root can come back as the file's farm
 * image. Directories have exactly one name, so only directories are
 * canonicalized here; the final component is followed with `readlink` and
 * otherwise kept verbatim.
 *
 * Components are walked in filesystem order, like the kernel does: a `..` only
 * applies after the component before it has been resolved. Collapsing
 * `link/..` lexically would name the link's sibling instead of its target's
 * parent, so a link such as `dir/../secret` could escape a containment check.
 */
export const realpathThroughName = (path: string): string => {
  const pending = splitComponents(
    isAbsolute(path) === true ? path : `${process.cwd()}${sep}${path}`,
  )
  // Invariant: `resolved` is an existing, symlink-free directory.
  let resolved = sep
  let hops = 0
  for (;;) {
    const component = pending.shift()
    if (component === undefined) return realpathSync(resolved)
    if (component === '..') {
      resolved = dirname(resolved)
      continue
    }
    // `.` names the directory already reached; the invariant makes it a no-op.
    if (component === '.') continue
    const candidate = join(resolved, component)
    const status = lstatSync(candidate)
    if (status.isSymbolicLink() === true) {
      hops++
      if (hops > MAX_SYMLINK_HOPS)
        throw Object.assign(new Error(`too many symbolic links: ${path}`), { code: 'ELOOP' })
      const target = readlinkSync(candidate)
      if (isAbsolute(target) === true) resolved = sep
      pending.unshift(...splitComponents(target))
      continue
    }
    if (pending.length === 0) return join(realpathSync(resolved), component)
    if (status.isDirectory() === false)
      throw Object.assign(new Error(`not a directory: ${candidate}`), { code: 'ENOTDIR' })
    resolved = candidate
  }
}

/**
 * Splits a path into components, dropping empty components but keeping `.`
 * and `..`. A `.` or a trailing separator demands that the preceding component
 * be a directory, so a trailing separator is kept as `.`: `file/` and `file/.`
 * must fail with `ENOTDIR` rather than name the file.
 */
const splitComponents = (path: string): string[] => {
  const components = path.split(sep).filter((component) => component.length > 0)
  if (path.endsWith(sep) === true && components.length > 0) components.push('.')
  return components
}
