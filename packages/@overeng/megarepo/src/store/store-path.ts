import path from 'node:path'

import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { systemError, type PlatformError } from 'effect/PlatformError'

/** Ref worktrees are shared. Resolve aliases and missing output parents before authorizing writes. */
export const assertCanonicalMutationAllowed = (
  target: string,
  { materializationRoot }: { materializationRoot?: string } = {},
): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (process.env['MEGAREPO_ALLOW_CANONICAL_MUTATION'] === '1') return
    const fs = yield* FileSystem.FileSystem
    let existingPath = path.resolve(target)
    let missingPath = ''
    let resolvedPath: string | void = undefined
    while (typeof resolvedPath !== 'string') {
      resolvedPath = yield* fs.realPath(existingPath).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === 'NotFound',
          () => Effect.void,
        ),
      )
      if (typeof resolvedPath !== 'string') {
        // realPath reports ENOENT for dangling links too; writes still follow their destinations.
        const link = yield* fs.readLink(existingPath).pipe(
          Effect.catchIf(
            (error) => error.reason._tag === 'NotFound',
            () => Effect.void,
          ),
        )
        if (typeof link === 'string') {
          existingPath = path.resolve(path.dirname(existingPath), link)
          continue
        }
        const parent = path.dirname(existingPath)
        if (parent === existingPath) {
          return yield* systemError({
            _tag: 'NotFound',
            module: 'megarepo',
            method: 'authorizeMutation',
            pathOrDescriptor: target,
            description: 'Cannot resolve target; refusing mutation',
          })
        }
        missingPath = path.join(path.basename(existingPath), missingPath)
        existingPath = parent
      }
    }
    if (/\/refs\/(?:commits|heads|tags)\/.+/.test(resolvedPath) === true) {
      // The invoking branch workspace owns its repos mount directory. This permission is
      // only passed by top-level apply, never by lock writers, generators, or nested apply.
      if (materializationRoot !== undefined) {
        const root = yield* fs.realPath(materializationRoot)
        const destination = path.join(resolvedPath, missingPath)
        const targetPath = path.resolve(target)
        const workspacePath = path.resolve(materializationRoot)
        if (
          root.match(/\/refs\/(commits|heads|tags)\/.+/)?.[1] === 'heads' &&
          ((targetPath === workspacePath && destination === root) ||
            (targetPath === path.join(workspacePath, 'repos') &&
              destination === path.join(root, 'repos')))
        ) {
          return
        }
      }
      return yield* systemError({
        _tag: 'PermissionDenied',
        module: 'megarepo',
        method: 'authorizeMutation',
        pathOrDescriptor: resolvedPath,
        description:
          `Refusing to mutate canonical worktree '${resolvedPath}'. ` +
          'Use --lock-sync=off for member lock sync, or an owned worktree. ' +
          'Explicit administrative override: MEGAREPO_ALLOW_CANONICAL_MUTATION=1.',
      })
    }
  })

/**
 * Abbreviate a megarepo store path to owner/repo@ref format.
 *
 * Store paths follow: `~/.megarepo/github.com/<owner>/<repo>/refs/(heads|tags|commits)/<ref>`
 * Output: `<owner>/<repo>@<ref>`
 *
 * Falls back to the last path segment if the pattern doesn't match.
 */
export const abbreviateStorePath = (storePath: string): string => {
  // Try to match the full store path pattern
  const match = storePath.match(
    /github\.com\/([^/]+)\/([^/]+)\/refs\/(?:heads|tags|commits)\/(.+?)(?:\/)?$/,
  )
  if (match !== null) {
    return `${match[1]}/${match[2]}@${match[3]}`
  }

  // Fallback: last non-empty path segment
  const segments = storePath.replace(/\/+$/, '').split('/')
  const last = segments[segments.length - 1]
  return last !== undefined && last !== '' ? last : storePath
}
