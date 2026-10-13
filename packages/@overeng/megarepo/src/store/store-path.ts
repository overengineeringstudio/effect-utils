import path from 'node:path'

import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { systemError, type PlatformError } from 'effect/PlatformError'

/**
 * Whether a physical root is an author workspace rather than the shared consumer cache.
 * Offline proof from Git metadata, never from the path suffix: the root is the top of a
 * worktree of `<repo>/.bare`, its HEAD is `refs/heads/<B>`, it sits at the canonical
 * `<repo>/refs/heads/<B>`, and `<B>` is not the store's default branch (the bare's HEAD,
 * set at clone time to the remote's default). Subdirectories, detached or mismatched
 * worktrees and unresolvable defaults are not authored.
 */
const isAuthorBranchWorkspace = (root: string) =>
  Effect.gen(function* () {
    const repo = root.match(/^(.+?)\/refs\/heads\/.+$/)?.[1]
    if (repo === undefined) return false
    const fs = yield* FileSystem.FileSystem
    const read = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ''))
    const real = (file: string) =>
      fs.realPath(file).pipe(Effect.orElseSucceed((): string | undefined => undefined))
    const gitdirLink = (yield* read(path.join(root, '.git'))).match(/^gitdir: (.+)\n?$/)?.[1]
    if (gitdirLink === undefined) return false
    const gitdir = yield* real(path.resolve(root, gitdirLink))
    const bare = yield* real(path.join(repo, '.bare'))
    if (gitdir === undefined || bare === undefined) return false
    if (path.dirname(gitdir) !== path.join(bare, 'worktrees')) return false
    const branch = (yield* read(path.join(gitdir, 'HEAD'))).match(
      /^ref: refs\/heads\/(.+)\n?$/,
    )?.[1]
    if (branch === undefined || path.join(repo, 'refs', 'heads', branch) !== root) return false
    const defaultBranch = (yield* read(path.join(bare, 'HEAD'))).match(
      /^ref: refs\/heads\/(.+)\n?$/,
    )?.[1]
    return defaultBranch !== undefined && defaultBranch !== branch
  })

/** Ref worktrees are shared. Resolve aliases and missing output parents before authorizing writes. */
export const assertCanonicalMutationAllowed = ({
  target,
  materializationRoot,
  materializedRoot,
  commitApplyRoot,
  lockFile,
}: {
  target: string
  materializationRoot?: string
  /** Physical identity of a commit worktree freshly created by this apply invocation. */
  materializedRoot?: string
  /** Exact physical commit root whose Git root and HEAD top-level apply proved, with lock sync off. */
  commitApplyRoot?: string
  /** Top-level fetch also owns the invoking branch workspace's own lock file (a direct child of it). */
  lockFile?: string
}): Effect.Effect<void, PlatformError, FileSystem.FileSystem> =>
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
    if (
      materializedRoot !== undefined ||
      commitApplyRoot !== undefined ||
      /\/refs\/(?:commits|heads|tags)\/.+/.test(resolvedPath) === true
    ) {
      const commitRoot = materializedRoot ?? commitApplyRoot
      if (commitRoot !== undefined) {
        const root = path.resolve(commitRoot)
        const workspacePath = path.resolve(materializationRoot ?? commitRoot)
        const targetPath = path.resolve(target)
        const destination = path.join(resolvedPath, missingPath)
        if (
          /\/refs\/commits\/[^/]+$/.test(root) === true &&
          ((targetPath === workspacePath && destination === root) ||
            (targetPath === path.join(workspacePath, 'repos') &&
              destination === path.join(root, 'repos')))
        ) {
          return
        }
      }
      // Only top-level apply/fetch owns an invoking non-default branch workspace's mount
      // directory, and only top-level fetch additionally owns its lock file.
      // Fresh recursive materialization never authorizes authoring outputs.
      if (materializationRoot !== undefined && materializedRoot === undefined) {
        const root = yield* fs.realPath(materializationRoot)
        const destination = path.join(resolvedPath, missingPath)
        const targetPath = path.resolve(target)
        const workspacePath = path.resolve(materializationRoot)
        if (
          root.match(/\/refs\/(commits|heads|tags)\/.+/)?.[1] === 'heads' &&
          ((targetPath === workspacePath && destination === root) ||
            (targetPath === path.join(workspacePath, 'repos') &&
              destination === path.join(root, 'repos')) ||
            (lockFile !== undefined &&
              targetPath === path.resolve(lockFile) &&
              destination === path.join(root, path.basename(lockFile)))) &&
          (yield* isAuthorBranchWorkspace(root)) === true
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
