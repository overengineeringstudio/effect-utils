import { randomBytes } from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rmdir,
  stat,
  symlink,
  unlink,
} from 'node:fs/promises'
import * as NodePath from 'node:path'

import { Effect, Option, Schema } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import { EffectPath, type AbsoluteDirPath, type AbsoluteFilePath } from '@overeng/effect-path'

import { findConfigPath } from './config.ts'
import * as Git from './git.ts'
import {
  OWNED_WORKTREE_ACQUISITION_VERSION,
  OWNED_WORKTREE_ROOT_MANIFEST,
  OwnedWorktreeAcquisitionError,
  OwnedWorktreeAcquisitionJournal,
  OwnedWorktreeAcquisitionLockOwner,
  OwnedWorktreeAcquisitionLockToken,
  OwnedWorktreeRootManifest,
  type OwnedWorkspaceTeardownResult,
  type OwnedWorktreeAcquisitionJournal as Journal,
  type OwnedWorktreeAcquisitionLockOwner as AcquisitionLockOwner,
  type OwnedWorktreeAcquisitionResult,
  type OwnedWorktreeAcquisitionState,
  type OwnedWorktreeConfigName,
  type OwnedWorktreeRecoveryResult,
  type OwnedWorktreeRootManifest as RootManifest,
} from './owned-worktree-acquisition-schema.ts'

const strictParseOptions = { errors: 'all', onExcessProperty: 'error' } as const
const JournalJson = Schema.fromJsonString(OwnedWorktreeAcquisitionJournal)
const RootManifestJson = Schema.fromJsonString(OwnedWorktreeRootManifest)
const LockOwnerJson = Schema.fromJsonString(OwnedWorktreeAcquisitionLockOwner)

/** Deterministic interruption and durability checkpoints exposed to tests. */
export type OwnedWorktreeAcquisitionBoundary =
  | 'PreflightComplete'
  | 'JournalPrepared'
  | 'MovedToTemp'
  | 'MovedToTempJournaled'
  | 'RootCreated'
  | 'RootCreatedJournaled'
  | 'Installed'
  | 'InstalledJournaled'
  | 'ConfigLinked'
  | 'Generated'
  | 'GeneratedJournaled'
  | 'CompleteJournaled'
  | 'JournalRemoved'

/** Conservative liveness observation used by exact-token stale-lock recovery. */
export type OwnedWorktreeOwnerProcessState = 'alive' | 'dead' | 'unknown'

/** Optional crash-injection, process-liveness, and directory-durability runtime seams. */
export interface OwnedWorktreeAcquisitionRuntime {
  readonly nonce?: () => string
  readonly afterBoundary?: (boundary: OwnedWorktreeAcquisitionBoundary) => Promise<void>
  readonly processAlive?: (pid: number) => Promise<OwnedWorktreeOwnerProcessState>
  /** Test seam which must call `sync` to retain the durability guarantee. */
  readonly directoryFsync?: (input: {
    readonly path: string
    readonly sync: () => Promise<void>
  }) => Promise<void>
}

/** Installed owned-worktree authority passed to generation and cleanup callbacks. */
export interface OwnedWorkspaceGenerationContext {
  readonly workspaceRoot: AbsoluteDirPath
  readonly ownedWorktree: AbsoluteDirPath
  readonly configPath: AbsoluteFilePath
  readonly configName: OwnedWorktreeConfigName
}

/**
 * Move an existing canonical branch worktree under an exclusive sibling lifecycle lock.
 */
export const acquireOwnedWorktree: typeof acquireOwnedWorktreeUnlocked = (args) => {
  const runtime = args.runtime ?? {}
  return withAcquisitionLock({
    workspaceRoot: normalizedAbsolute(args.workspaceRoot),
    runtime,
    effect: acquireOwnedWorktreeUnlocked({ ...args, runtime }),
  })
}

/** Reconcile an interrupted acquisition while excluding concurrent lifecycle mutation. */
export const recoverOwnedWorktreeAcquisition: typeof recoverOwnedWorktreeAcquisitionUnlocked = (
  args,
) => {
  const runtime = args.runtime ?? {}
  return withAcquisitionLock({
    workspaceRoot: normalizedAbsolute(args.workspaceRoot),
    runtime,
    effect: recoverOwnedWorktreeAcquisitionUnlocked({ ...args, runtime }),
  })
}

/** Remove a dead owner's durable lock only with its exact validated token. */
export const recoverStaleOwnedWorktreeAcquisitionLock: typeof recoverStaleOwnedWorktreeAcquisitionLockUnlocked =
  (args) => recoverStaleOwnedWorktreeAcquisitionLockUnlocked(args)

/** Tear down a complete owned workspace while excluding concurrent lifecycle mutation. */
export const teardownOwnedWorkspace: typeof teardownOwnedWorkspaceUnlocked = (args) => {
  const runtime = args.runtime ?? {}
  return withAcquisitionLock({
    workspaceRoot: normalizedAbsolute(args.workspaceRoot),
    runtime,
    effect: teardownOwnedWorkspaceUnlocked({ ...args, runtime }),
  })
}

interface Paths {
  readonly workspaceRoot: string
  readonly parent: string
  readonly ownedWorktree: string
  readonly tempPath: string
  readonly journalPath: string
  readonly lockPath: string
  readonly rootStagePath: string
  readonly rootManifestPath: string
}

interface ObservedIdentity {
  readonly adminDir: string
  readonly branchRef: string
  readonly head: string
  readonly statusPorcelainBase64: string
}

interface Prepared extends ObservedIdentity {
  readonly bareRepo: string
  readonly workspaceRoot: string
  readonly ownedMember: string
  readonly configName: OwnedWorktreeConfigName
  readonly paths: Paths
}

const error = ({
  reason,
  path,
  message,
  recoveryPaths = [],
  cause,
}: {
  reason: OwnedWorktreeAcquisitionError['reason']
  path: string
  message: string
  recoveryPaths?: ReadonlyArray<string>
  cause?: unknown
}): OwnedWorktreeAcquisitionError =>
  new OwnedWorktreeAcquisitionError({
    reason,
    path,
    message,
    recoveryPaths: [...recoveryPaths],
    ...(cause === undefined ? {} : { cause }),
  })

const normalizeError = ({
  cause,
  path,
  message,
  reason = 'IoFailure',
  recoveryPaths = [],
}: {
  cause: unknown
  path: string
  message: string
  reason?: OwnedWorktreeAcquisitionError['reason']
  recoveryPaths?: ReadonlyArray<string>
}): OwnedWorktreeAcquisitionError =>
  cause instanceof OwnedWorktreeAcquisitionError
    ? cause
    : error({ reason, path, message, recoveryPaths, cause })

const io = <A>({
  path,
  message,
  try: run,
  reason,
  recoveryPaths,
}: {
  path: string
  message: string
  try: () => Promise<A>
  reason?: OwnedWorktreeAcquisitionError['reason']
  recoveryPaths?: ReadonlyArray<string>
}): Effect.Effect<A, OwnedWorktreeAcquisitionError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      normalizeError({
        cause,
        path,
        message,
        ...(reason === undefined ? {} : { reason }),
        ...(recoveryPaths === undefined ? {} : { recoveryPaths }),
      }),
  })

const command = <A, E, R>(
  ...[path, effect]: readonly [path: string, effect: Effect.Effect<A, E, R>]
) =>
  effect.pipe(
    Effect.mapError((cause) =>
      normalizeError({
        cause,
        path,
        message: `Git command failed for '${path}'`,
        reason: 'CommandFailure',
        recoveryPaths: [path],
      }),
    ),
  )

const normalizedAbsolute = (path: string): string => NodePath.resolve(path)
const isWithin = ({ parent, path }: { parent: string; path: string }): boolean => {
  const relative = NodePath.relative(parent, path)
  return (
    relative === '' || (relative.startsWith(`..${NodePath.sep}`) === false && relative !== '..')
  )
}
const isStrictDescendant = ({ parent, path }: { parent: string; path: string }): boolean =>
  path !== parent && isWithin({ parent, path })

const derivePaths = ({
  workspaceRoot,
  ownedMember,
}: {
  workspaceRoot: string
  ownedMember: string
}): Paths => {
  const root = normalizedAbsolute(workspaceRoot)
  const parent = NodePath.dirname(root)
  const base = NodePath.basename(root)
  return {
    workspaceRoot: root,
    parent,
    ownedWorktree: NodePath.join(root, 'repos', ownedMember),
    tempPath: NodePath.join(parent, `.${base}.owned-worktree-acquisition-temp`),
    journalPath: NodePath.join(parent, `.${base}.owned-worktree-acquisition.json`),
    lockPath: NodePath.join(parent, `.${base}.owned-worktree-acquisition.lock`),
    rootStagePath: NodePath.join(parent, `.${base}.owned-worktree-root-stage`),
    rootManifestPath: NodePath.join(root, OWNED_WORKTREE_ROOT_MANIFEST),
  }
}

/** Derive the durable sibling acquisition journal path for a canonical workspace root. */
export const ownedWorktreeAcquisitionJournalPath = (workspaceRoot: string): string => {
  const root = normalizedAbsolute(workspaceRoot)
  return NodePath.join(
    NodePath.dirname(root),
    `.${NodePath.basename(root)}.owned-worktree-acquisition.json`,
  )
}

const pathExists = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    (cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ENOENT') return false
      throw cause
    },
  )

const syncDirectoryNative = async (path: string): Promise<void> => {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const syncDirectory = ({
  path,
  runtime,
}: {
  path: string
  runtime: OwnedWorktreeAcquisitionRuntime
}) =>
  io({
    path,
    message: `Cannot fsync directory '${path}'`,
    recoveryPaths: [path],
    try: () => {
      const sync = (): Promise<void> => syncDirectoryNative(path)
      return runtime.directoryFsync?.({ path, sync }) ?? sync()
    },
  })

interface HeldAcquisitionLock {
  readonly lockPath: string
  readonly ownerPath: string
  readonly bytes: string
  readonly dev: number
  readonly ino: number
}

const canonicalLockOwner = (owner: AcquisitionLockOwner): string =>
  `${JSON.stringify({ nonce: owner.nonce, pid: owner.pid, version: owner.version })}\n`

const decodeCanonicalLockOwner = ({
  bytes,
  path,
}: {
  bytes: string
  path: string
}): AcquisitionLockOwner => {
  const owner = Schema.decodeUnknownSync(LockOwnerJson, strictParseOptions)(bytes)
  if (canonicalLockOwner(owner) !== bytes) {
    throw error({
      reason: 'StaleLockRecoveryRefused',
      path,
      message: `Owned-worktree lock owner at '${path}' is not canonical`,
      recoveryPaths: [path],
    })
  }
  return owner
}

const acquisitionLockedError = async ({
  workspaceRoot,
  lockPath,
  cause,
}: {
  workspaceRoot: string
  lockPath: string
  cause: unknown
}): Promise<OwnedWorktreeAcquisitionError> => {
  try {
    const bytes = await readFile(lockPath, 'utf8')
    const owner = decodeCanonicalLockOwner({ bytes, path: lockPath })
    const ownerPath = `${lockPath}.owner-${owner.nonce}`
    return error({
      reason: 'AcquisitionLocked',
      path: lockPath,
      message:
        `Owned-worktree lifecycle for '${workspaceRoot}' is locked by pid ${owner.pid} ` +
        `with token '${owner.nonce}'. After that exact owner exits, call ` +
        `recoverStaleOwnedWorktreeAcquisitionLock({ workspaceRoot: '${workspaceRoot}', token: '${owner.nonce}' }).`,
      recoveryPaths: [lockPath, ownerPath],
      cause,
    })
  } catch (ownerCause) {
    if (ownerCause instanceof OwnedWorktreeAcquisitionError) {
      return error({
        reason: 'AcquisitionLocked',
        path: lockPath,
        message:
          `Owned-worktree lifecycle for '${workspaceRoot}' is locked, but its owner/token record is malformed. ` +
          `Exact-token recovery is unavailable and automatic deletion is refused.`,
        recoveryPaths: [lockPath],
        cause: ownerCause,
      })
    }
    return error({
      reason: 'AcquisitionLocked',
      path: lockPath,
      message:
        `Owned-worktree lifecycle for '${workspaceRoot}' is locked, but its owner/token cannot be read. ` +
        `Exact-token recovery is unavailable and automatic deletion is refused.`,
      recoveryPaths: [lockPath],
      cause: ownerCause,
    })
  }
}

const acquireAcquisitionLock = ({
  workspaceRoot,
  runtime,
}: {
  workspaceRoot: string
  runtime: OwnedWorktreeAcquisitionRuntime
}) => {
  const paths = derivePaths({ workspaceRoot, ownedMember: '_lock-path-only_' })
  return io({
    path: paths.lockPath,
    message: `Cannot acquire owned-worktree lifecycle lock '${paths.lockPath}'`,
    recoveryPaths: [paths.lockPath],
    try: async () => {
      const owner: AcquisitionLockOwner = {
        nonce: randomBytes(16).toString('hex'),
        pid: process.pid,
        version: OWNED_WORKTREE_ACQUISITION_VERSION,
      }
      const bytes = canonicalLockOwner(owner)
      const ownerPath = `${paths.lockPath}.owner-${owner.nonce}`
      let linked = false
      try {
        const handle = await open(ownerPath, 'wx', 0o600)
        try {
          await handle.writeFile(bytes, 'utf8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        await link(ownerPath, paths.lockPath)
        linked = true
        const sync = (): Promise<void> => syncDirectoryNative(paths.parent)
        await (runtime.directoryFsync?.({ path: paths.parent, sync }) ?? sync())
        const identity = await lstat(ownerPath)
        return {
          lockPath: paths.lockPath,
          ownerPath,
          bytes,
          dev: identity.dev,
          ino: identity.ino,
        } satisfies HeldAcquisitionLock
      } catch (cause) {
        if (linked === true) await unlink(paths.lockPath).catch(() => undefined)
        await unlink(ownerPath).catch(() => undefined)
        const code =
          cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
            ? cause.code
            : undefined
        if (code === 'EEXIST') {
          throw await acquisitionLockedError({ workspaceRoot, lockPath: paths.lockPath, cause })
        }
        throw cause
      }
    },
  })
}

const releaseAcquisitionLock = ({
  held,
  runtime,
}: {
  held: HeldAcquisitionLock
  runtime: OwnedWorktreeAcquisitionRuntime
}) =>
  io({
    path: held.lockPath,
    message: `Cannot release owned-worktree lifecycle lock '${held.lockPath}'`,
    recoveryPaths: [held.lockPath, held.ownerPath],
    try: async () => {
      const [lockIdentity, ownerIdentity, lockBytes] = await Promise.all([
        lstat(held.lockPath),
        lstat(held.ownerPath),
        readFile(held.lockPath, 'utf8'),
      ])
      if (
        lockIdentity.dev !== held.dev ||
        lockIdentity.ino !== held.ino ||
        ownerIdentity.dev !== held.dev ||
        ownerIdentity.ino !== held.ino ||
        lockBytes !== held.bytes
      ) {
        throw error({
          reason: 'RecoveryConflict',
          path: held.lockPath,
          message: `Owned-worktree lifecycle lock ownership changed before release`,
          recoveryPaths: [held.lockPath, held.ownerPath],
        })
      }
      await unlink(held.lockPath)
      await unlink(held.ownerPath)
      const sync = (): Promise<void> => syncDirectoryNative(NodePath.dirname(held.lockPath))
      await (runtime.directoryFsync?.({ path: NodePath.dirname(held.lockPath), sync }) ?? sync())
    },
  })

const defaultProcessAlive = async (pid: number): Promise<OwnedWorktreeOwnerProcessState> => {
  if (process.platform !== 'linux' && process.platform !== 'darwin') return 'unknown'
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (cause) {
    const code =
      cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
        ? cause.code
        : undefined
    return code === 'ESRCH' ? 'dead' : 'unknown'
  }
}

const recoverStaleOwnedWorktreeAcquisitionLockUnlocked = ({
  workspaceRoot: rawWorkspaceRoot,
  token: rawToken,
  runtime = {},
}: {
  workspaceRoot: string
  token: string
  runtime?: Pick<OwnedWorktreeAcquisitionRuntime, 'directoryFsync' | 'processAlive'>
}): Effect.Effect<void, OwnedWorktreeAcquisitionError> => {
  const workspaceRoot = normalizedAbsolute(rawWorkspaceRoot)
  const paths = derivePaths({ workspaceRoot, ownedMember: '_lock-path-only_' })
  return io({
    path: paths.lockPath,
    message: `Cannot recover stale owned-worktree lifecycle lock '${paths.lockPath}'`,
    reason: 'StaleLockRecoveryRefused',
    recoveryPaths: [paths.lockPath],
    try: async () => {
      const token = Schema.decodeUnknownSync(
        OwnedWorktreeAcquisitionLockToken,
        strictParseOptions,
      )(rawToken)
      const lockBytes = await readFile(paths.lockPath, 'utf8')
      const owner = decodeCanonicalLockOwner({ bytes: lockBytes, path: paths.lockPath })
      const ownerPath = `${paths.lockPath}.owner-${owner.nonce}`
      if (token !== owner.nonce) {
        throw error({
          reason: 'StaleLockRecoveryRefused',
          path: paths.lockPath,
          message: `Stale-lock recovery token does not match owner token '${owner.nonce}'`,
          recoveryPaths: [paths.lockPath, ownerPath],
        })
      }
      const processState = await (runtime.processAlive?.(owner.pid) ??
        defaultProcessAlive(owner.pid))
      if (processState !== 'dead') {
        throw error({
          reason: 'StaleLockRecoveryRefused',
          path: paths.lockPath,
          message:
            `Lock owner pid ${owner.pid} with token '${owner.nonce}' is ${processState}; ` +
            `only a definitely dead exact-token owner may be recovered.`,
          recoveryPaths: [paths.lockPath, ownerPath],
        })
      }
      const [lockIdentity, ownerIdentity, ownerBytes] = await Promise.all([
        lstat(paths.lockPath),
        lstat(ownerPath),
        readFile(ownerPath, 'utf8'),
      ])
      if (
        lockIdentity.dev !== ownerIdentity.dev ||
        lockIdentity.ino !== ownerIdentity.ino ||
        ownerBytes !== lockBytes
      ) {
        throw error({
          reason: 'StaleLockRecoveryRefused',
          path: paths.lockPath,
          message: `Exact-token lock owner identity changed during stale recovery`,
          recoveryPaths: [paths.lockPath, ownerPath],
        })
      }
      await unlink(ownerPath)
      const claimedIdentity = await lstat(paths.lockPath)
      if (claimedIdentity.dev !== lockIdentity.dev || claimedIdentity.ino !== lockIdentity.ino) {
        throw error({
          reason: 'StaleLockRecoveryRefused',
          path: paths.lockPath,
          message: `Lock identity changed after exact owner claim; refusing deletion`,
          recoveryPaths: [paths.lockPath],
        })
      }
      await unlink(paths.lockPath)
      const sync = (): Promise<void> => syncDirectoryNative(paths.parent)
      await (runtime.directoryFsync?.({ path: paths.parent, sync }) ?? sync())
    },
  })
}

const withAcquisitionLock = <A, E, R>({
  workspaceRoot,
  runtime,
  effect,
}: {
  workspaceRoot: string
  runtime: OwnedWorktreeAcquisitionRuntime
  effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, E | OwnedWorktreeAcquisitionError, R> =>
  Effect.acquireUseRelease(
    acquireAcquisitionLock({ workspaceRoot, runtime }),
    () => effect,
    (held) => releaseAcquisitionLock({ held, runtime }).pipe(Effect.orDie),
  )

const canonicalJournal = (journal: Journal): string =>
  `${JSON.stringify({
    adminDir: journal.adminDir,
    bareRepo: journal.bareRepo,
    branchRef: journal.branchRef,
    head: journal.head,
    ownedMember: journal.ownedMember,
    state: journal.state,
    statusPorcelainBase64: journal.statusPorcelainBase64,
    tempPath: journal.tempPath,
    version: journal.version,
    workspaceRoot: journal.workspaceRoot,
  })}\n`

const canonicalRootManifest = (manifest: RootManifest): string =>
  `${JSON.stringify({
    adminDir: manifest.adminDir,
    bareRepo: manifest.bareRepo,
    branchRef: manifest.branchRef,
    head: manifest.head,
    ownedMember: manifest.ownedMember,
    statusPorcelainBase64: manifest.statusPorcelainBase64,
    tempPath: manifest.tempPath,
    version: manifest.version,
    workspaceRoot: manifest.workspaceRoot,
  })}\n`

const writeAtomicDurable = ({
  path,
  content,
  runtime,
}: {
  path: string
  content: string
  runtime: OwnedWorktreeAcquisitionRuntime
}) =>
  Effect.gen(function* () {
    const temporary = `${path}.tmp-${process.pid}-${runtime.nonce?.() ?? randomBytes(8).toString('hex')}`
    yield* io({
      path,
      message: `Cannot atomically write '${path}'`,
      recoveryPaths: [path, temporary],
      try: async () => {
        let published = false
        try {
          const handle = await open(temporary, 'wx', 0o600)
          try {
            await handle.writeFile(content, 'utf8')
            await handle.sync()
          } finally {
            await handle.close()
          }
          await rename(temporary, path)
          published = true
        } finally {
          if (published === false) await unlink(temporary).catch(() => undefined)
        }
      },
    })
    yield* syncDirectory({ path: NodePath.dirname(path), runtime })
  })

const removeDurable = ({
  path,
  runtime,
}: {
  path: string
  runtime: OwnedWorktreeAcquisitionRuntime
}) =>
  Effect.gen(function* () {
    yield* io({
      path,
      message: `Cannot remove '${path}'`,
      recoveryPaths: [path],
      try: () => unlink(path),
    })
    yield* syncDirectory({ path: NodePath.dirname(path), runtime })
  })

const decodeJournal = (path: string) =>
  io({
    path,
    message: `Cannot read acquisition journal '${path}'`,
    reason: 'RecoveryConflict',
    recoveryPaths: [path],
    try: () => readFile(path, 'utf8'),
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(
        JournalJson,
        strictParseOptions,
      )(json).pipe(
        Effect.mapError((cause) =>
          error({
            reason: 'RecoveryConflict',
            path,
            message: `Acquisition journal '${path}' is invalid`,
            recoveryPaths: [path],
            cause,
          }),
        ),
      ),
    ),
  )

const decodeRootManifest = (path: string) =>
  io({
    path,
    message: `Cannot read root ownership manifest '${path}'`,
    reason: 'RecoveryConflict',
    recoveryPaths: [path],
    try: () => readFile(path, 'utf8'),
  }).pipe(
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(
        RootManifestJson,
        strictParseOptions,
      )(json).pipe(
        Effect.mapError((cause) =>
          error({
            reason: 'RecoveryConflict',
            path,
            message: `Root ownership manifest '${path}' is invalid`,
            recoveryPaths: [path],
            cause,
          }),
        ),
      ),
    ),
  )

const writeJournal = ({
  journal,
  state,
  path,
  runtime,
}: {
  journal: Journal
  state: OwnedWorktreeAcquisitionState
  path: string
  runtime: OwnedWorktreeAcquisitionRuntime
}) => writeAtomicDurable({ path, content: canonicalJournal({ ...journal, state }), runtime })

const afterBoundary = ({
  runtime,
  boundary,
  journalPath,
}: {
  runtime: OwnedWorktreeAcquisitionRuntime
  boundary: OwnedWorktreeAcquisitionBoundary
  journalPath: string
}) =>
  runtime.afterBoundary === undefined
    ? Effect.void
    : io({
        path: journalPath,
        message: `Injected acquisition boundary '${boundary}' failed`,
        recoveryPaths: [journalPath],
        try: () => runtime.afterBoundary!(boundary),
      })

const readGitdir = (worktree: string) =>
  io({
    path: NodePath.join(worktree, '.git'),
    message: `Cannot inspect linked-worktree admin pointer at '${worktree}'`,
    reason: 'GitIdentityConflict',
    recoveryPaths: [worktree],
    try: async () => {
      const dotGit = NodePath.join(worktree, '.git')
      const info = await lstat(dotGit)
      if (info.isFile() === false) throw new TypeError(`Expected '${dotGit}' to be a file`)
      const value = await readFile(dotGit, 'utf8')
      const match = /^gitdir: (.+)\n?$/u.exec(value)
      if (match?.[1] === undefined)
        throw new TypeError(`Invalid linked-worktree pointer '${dotGit}'`)
      const candidate = NodePath.resolve(NodePath.dirname(dotGit), match[1])
      return normalizedAbsolute(await realpath(candidate))
    },
  })

const statusSnapshot = (worktree: string) =>
  command(
    worktree,
    Git.runCommand({
      cwd: worktree,
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
    }),
  ).pipe(Effect.map((bytes) => Buffer.from(bytes, 'utf8').toString('base64')))

const currentIdentity = (worktree: string) =>
  Effect.gen(function* () {
    const [adminDir, branchRef, head, statusPorcelainBase64] = yield* Effect.all([
      readGitdir(worktree),
      command(
        worktree,
        Git.runCommand({ cwd: worktree, args: ['rev-parse', '--symbolic-full-name', 'HEAD'] }),
      ),
      command(worktree, Git.runCommand({ cwd: worktree, args: ['rev-parse', 'HEAD'] })),
      statusSnapshot(worktree),
    ])
    if (branchRef.startsWith('refs/heads/') === false) {
      return yield* error({
        reason: 'PreflightRefused',
        path: worktree,
        message: `Owned worktree '${worktree}' is not attached to a branch`,
      })
    }
    return { adminDir, branchRef, head, statusPorcelainBase64 } satisfies ObservedIdentity
  })

const assertRegistration = ({
  bareRepo,
  expectedPath,
  branchRef,
  head,
  workspaceRoot,
  requireNoNested,
}: {
  bareRepo: string
  expectedPath: string
  branchRef: string
  head: string
  workspaceRoot: string
  requireNoNested: boolean
}) =>
  Effect.gen(function* () {
    const registrations = yield* command(bareRepo, Git.listWorktrees(bareRepo))
    const expectedBranch = branchRef.slice('refs/heads/'.length)
    const atExpected = registrations.filter(
      (registration) => normalizedAbsolute(registration.path) === expectedPath,
    )
    if (atExpected.length !== 1) {
      return yield* error({
        reason: 'GitIdentityConflict',
        path: expectedPath,
        message: `Expected exactly one bare-repo worktree registration at '${expectedPath}', found ${atExpected.length}`,
        recoveryPaths: [bareRepo, workspaceRoot, expectedPath],
      })
    }
    const registration = atExpected[0]!
    if (
      registration.head !== head ||
      Option.getOrUndefined(registration.branch) !== expectedBranch
    ) {
      return yield* error({
        reason: 'GitIdentityConflict',
        path: expectedPath,
        message: `Registration at '${expectedPath}' does not match ${branchRef}@${head}`,
        recoveryPaths: [bareRepo, expectedPath],
      })
    }
    const branchRegistrations = registrations.filter(
      (candidate) => Option.getOrUndefined(candidate.branch) === expectedBranch,
    )
    if (branchRegistrations.length !== 1) {
      return yield* error({
        reason: 'PreflightRefused',
        path: expectedPath,
        message: `Branch '${branchRef}' has ${branchRegistrations.length} worktree registrations`,
        recoveryPaths: branchRegistrations.map((candidate) => candidate.path),
      })
    }
    if (
      requireNoNested === true &&
      registrations.some((candidate) =>
        isStrictDescendant({ parent: workspaceRoot, path: normalizedAbsolute(candidate.path) }),
      ) === true
    ) {
      return yield* error({
        reason: 'PreflightRefused',
        path: workspaceRoot,
        message: `Workspace '${workspaceRoot}' contains a nested registered worktree`,
        recoveryPaths: [bareRepo, workspaceRoot],
      })
    }
  })

const verifyIdentity = ({
  bareRepo,
  worktree,
  workspaceRoot,
  expected,
}: {
  bareRepo: string
  worktree: string
  workspaceRoot: string
  expected: ObservedIdentity
}) =>
  Effect.gen(function* () {
    yield* assertRegistration({
      bareRepo,
      expectedPath: worktree,
      branchRef: expected.branchRef,
      head: expected.head,
      workspaceRoot,
      requireNoNested: false,
    })
    const observed = yield* currentIdentity(worktree)
    if (
      observed.adminDir !== expected.adminDir ||
      observed.branchRef !== expected.branchRef ||
      observed.head !== expected.head ||
      observed.statusPorcelainBase64 !== expected.statusPorcelainBase64
    ) {
      return yield* error({
        reason: 'GitIdentityConflict',
        path: worktree,
        message: `Worktree identity or status changed at '${worktree}'`,
        recoveryPaths: [bareRepo, worktree],
      })
    }
  })

const observeOwnedWorkspaceIdentity = ({
  manifest,
  worktree,
}: {
  manifest: RootManifest
  worktree: string
}) =>
  Effect.gen(function* () {
    const observed = yield* currentIdentity(worktree)
    if (observed.adminDir !== manifest.adminDir || observed.branchRef !== manifest.branchRef) {
      return yield* error({
        reason: 'GitIdentityConflict',
        path: worktree,
        message: `Owned workspace branch or admin identity changed at '${worktree}'`,
        recoveryPaths: [manifest.bareRepo, worktree],
      })
    }
    const bareHead = yield* command(
      manifest.bareRepo,
      Git.runCommand({
        cwd: manifest.bareRepo,
        args: ['rev-parse', '--verify', manifest.branchRef],
      }),
    )
    if (bareHead !== observed.head) {
      return yield* error({
        reason: 'GitIdentityConflict',
        path: worktree,
        message: `Owned workspace HEAD disagrees with '${manifest.branchRef}'`,
      })
    }
    yield* assertRegistration({
      bareRepo: manifest.bareRepo,
      expectedPath: worktree,
      branchRef: observed.branchRef,
      head: observed.head,
      workspaceRoot: manifest.workspaceRoot,
      requireNoNested: false,
    })
    return observed
  })

const discoverConfigName = (
  worktree: string,
): Effect.Effect<OwnedWorktreeConfigName, OwnedWorktreeAcquisitionError, FileSystem.FileSystem> =>
  findConfigPath(EffectPath.unsafe.absoluteDir(`${worktree}/`)).pipe(
    Effect.mapError((cause) =>
      error({
        reason: 'IoFailure',
        path: worktree,
        message: `Cannot discover megarepo config in '${worktree}'`,
        cause,
      }),
    ),
    Effect.flatMap((configPath) => {
      if (configPath === undefined) {
        return Effect.fail(
          error({
            reason: 'ConfigMissing',
            path: worktree,
            message: `Owned worktree '${worktree}' has no megarepo.kdl or megarepo.json`,
          }),
        )
      }
      const configName = NodePath.basename(configPath)
      if (configName !== 'megarepo.kdl' && configName !== 'megarepo.json') {
        return Effect.fail(
          error({
            reason: 'ConfigMissing',
            path: configPath,
            message: `Unsupported authority config '${configName}'`,
          }),
        )
      }
      return Effect.succeed(configName)
    }),
  )

const preflight = ({
  bareRepo: rawBareRepo,
  workspaceRoot: rawWorkspaceRoot,
  ownedMember,
  branch,
  callerCwd,
}: {
  bareRepo: string
  workspaceRoot: string
  ownedMember: string
  branch: string
  callerCwd: string
}) =>
  Effect.gen(function* () {
    if (
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(ownedMember) === false ||
      ownedMember === '.' ||
      ownedMember === '..'
    ) {
      return yield* error({
        reason: 'InvalidRequest',
        path: rawWorkspaceRoot,
        message: `Invalid owned member name '${ownedMember}'`,
      })
    }
    if (branch.length === 0 || branch.startsWith('-') === true || branch.includes('..') === true) {
      return yield* error({
        reason: 'InvalidRequest',
        path: rawWorkspaceRoot,
        message: `Invalid branch name '${branch}'`,
      })
    }
    const bareRepo = normalizedAbsolute(rawBareRepo)
    const workspaceRoot = normalizedAbsolute(rawWorkspaceRoot)
    const paths = derivePaths({ workspaceRoot, ownedMember })
    const [physicalBareRepo, physicalWorkspaceRoot] = yield* Effect.all([
      io({
        path: bareRepo,
        message: `Cannot resolve bare repository '${bareRepo}'`,
        try: () => realpath(bareRepo),
      }),
      io({
        path: workspaceRoot,
        message: `Cannot resolve workspace root '${workspaceRoot}'`,
        try: () => realpath(workspaceRoot),
      }),
    ])
    if (
      normalizedAbsolute(physicalBareRepo) !== bareRepo ||
      normalizedAbsolute(physicalWorkspaceRoot) !== workspaceRoot
    ) {
      return yield* error({
        reason: 'PreflightRefused',
        path: workspaceRoot,
        message: `Bare repository and workspace root must be canonical physical paths`,
        recoveryPaths: [bareRepo, workspaceRoot],
      })
    }
    const normalizedCwd = normalizedAbsolute(callerCwd)
    if (isWithin({ parent: workspaceRoot, path: normalizedCwd }) === true) {
      return yield* error({
        reason: 'PreflightRefused',
        path: normalizedCwd,
        message: `Caller cwd '${normalizedCwd}' is inside worktree '${workspaceRoot}'`,
      })
    }

    const collisions = [paths.tempPath, paths.rootStagePath, paths.ownedWorktree, paths.journalPath]
    for (const collision of collisions) {
      if (
        (yield* io({
          path: collision,
          message: `Cannot inspect '${collision}'`,
          try: () => pathExists(collision),
        })) === true
      ) {
        return yield* error({
          reason: 'Collision',
          path: collision,
          message: `Acquisition path collision at '${collision}'`,
          recoveryPaths: [collision],
        })
      }
    }

    const [rootStats, parentStats] = yield* Effect.all([
      io({
        path: workspaceRoot,
        message: `Cannot stat '${workspaceRoot}'`,
        try: () => stat(workspaceRoot),
      }),
      io({
        path: paths.parent,
        message: `Cannot stat '${paths.parent}'`,
        try: () => stat(paths.parent),
      }),
    ])
    if (rootStats.isDirectory() === false || rootStats.dev !== parentStats.dev) {
      return yield* error({
        reason: 'PreflightRefused',
        path: workspaceRoot,
        message: `Workspace root and sibling temporary path must be directories on one filesystem`,
      })
    }

    yield* command(
      bareRepo,
      Git.runCommand({ cwd: bareRepo, args: ['check-ref-format', '--branch', branch] }),
    )
    const identity = yield* currentIdentity(workspaceRoot)
    const expectedAdminParent = normalizedAbsolute(
      yield* io({
        path: NodePath.join(bareRepo, 'worktrees'),
        message: `Cannot resolve bare worktree administration directory`,
        try: () => realpath(NodePath.join(bareRepo, 'worktrees')),
      }),
    )
    if (NodePath.dirname(identity.adminDir) !== expectedAdminParent) {
      return yield* error({
        reason: 'GitIdentityConflict',
        path: identity.adminDir,
        message: `Worktree admin pointer is not owned by bare repository '${bareRepo}'`,
        recoveryPaths: [bareRepo, identity.adminDir],
      })
    }
    const requestedRef = `refs/heads/${branch}`
    if (identity.branchRef !== requestedRef) {
      return yield* error({
        reason: 'GitIdentityConflict',
        path: workspaceRoot,
        message: `Worktree branch is '${identity.branchRef}', expected '${requestedRef}'`,
      })
    }
    const bareHead = yield* command(
      bareRepo,
      Git.runCommand({ cwd: bareRepo, args: ['rev-parse', '--verify', requestedRef] }),
    )
    if (bareHead !== identity.head) {
      return yield* error({
        reason: 'GitIdentityConflict',
        path: bareRepo,
        message: `Bare ref '${requestedRef}' and worktree HEAD disagree`,
      })
    }
    yield* assertRegistration({
      bareRepo,
      expectedPath: workspaceRoot,
      branchRef: requestedRef,
      head: identity.head,
      workspaceRoot,
      requireNoNested: true,
    })

    const submodules = yield* command(
      workspaceRoot,
      Git.runCommand({ cwd: workspaceRoot, args: ['submodule', 'status', '--recursive'] }),
    )
    if (submodules.length > 0) {
      return yield* error({
        reason: 'PreflightRefused',
        path: workspaceRoot,
        message: `Owned worktree contains submodules and cannot be moved safely`,
      })
    }

    const configName = yield* discoverConfigName(workspaceRoot)
    return {
      bareRepo,
      workspaceRoot,
      ownedMember,
      configName,
      paths,
      ...identity,
    } satisfies Prepared
  })

const journalFromPrepared = (prepared: Prepared): Journal => ({
  adminDir: prepared.adminDir,
  bareRepo: prepared.bareRepo,
  branchRef: prepared.branchRef,
  head: prepared.head,
  ownedMember: prepared.ownedMember,
  state: 'prepared',
  statusPorcelainBase64: prepared.statusPorcelainBase64,
  tempPath: prepared.paths.tempPath,
  version: OWNED_WORKTREE_ACQUISITION_VERSION,
  workspaceRoot: prepared.workspaceRoot,
})

const rootManifestFromJournal = (journal: Journal): RootManifest => ({
  adminDir: journal.adminDir,
  bareRepo: journal.bareRepo,
  branchRef: journal.branchRef,
  head: journal.head,
  ownedMember: journal.ownedMember,
  statusPorcelainBase64: journal.statusPorcelainBase64,
  tempPath: journal.tempPath,
  version: journal.version,
  workspaceRoot: journal.workspaceRoot,
})

const createManagedRoot = ({
  journal,
  paths,
  runtime,
}: {
  journal: Journal
  paths: Paths
  runtime: OwnedWorktreeAcquisitionRuntime
}) =>
  Effect.gen(function* () {
    yield* io({
      path: paths.rootStagePath,
      message: `Cannot create staged workspace root '${paths.rootStagePath}'`,
      recoveryPaths: [paths.journalPath, paths.rootStagePath],
      try: async () => {
        await mkdir(paths.rootStagePath, { mode: 0o755 })
        await mkdir(NodePath.join(paths.rootStagePath, 'repos'), { mode: 0o755 })
      },
    })
    const stageManifest = NodePath.join(paths.rootStagePath, OWNED_WORKTREE_ROOT_MANIFEST)
    yield* writeAtomicDurable({
      path: stageManifest,
      content: canonicalRootManifest(rootManifestFromJournal(journal)),
      runtime,
    })
    yield* syncDirectory({ path: paths.rootStagePath, runtime })
    yield* io({
      path: paths.workspaceRoot,
      message: `Cannot publish managed workspace root '${paths.workspaceRoot}'`,
      recoveryPaths: [paths.journalPath, paths.rootStagePath, paths.workspaceRoot],
      try: () => rename(paths.rootStagePath, paths.workspaceRoot),
    })
    yield* syncDirectory({ path: paths.parent, runtime })
  })

const assertManagedEmptyRoot = ({
  workspaceRoot,
  expected,
}: {
  workspaceRoot: string
  expected: RootManifest
}) =>
  Effect.gen(function* () {
    const manifestPath = NodePath.join(workspaceRoot, OWNED_WORKTREE_ROOT_MANIFEST)
    const observed = yield* decodeRootManifest(manifestPath)
    if (canonicalRootManifest(observed) !== canonicalRootManifest(expected)) {
      return yield* error({
        reason: 'ForeignRootEntry',
        path: manifestPath,
        message: `Workspace root ownership manifest does not match acquisition journal`,
        recoveryPaths: [workspaceRoot, manifestPath],
      })
    }
    const entries = yield* io({
      path: workspaceRoot,
      message: `Cannot inspect managed workspace root '${workspaceRoot}'`,
      try: () => readdir(workspaceRoot),
    })
    if (
      entries.length !== 2 ||
      entries.includes('repos') === false ||
      entries.includes(OWNED_WORKTREE_ROOT_MANIFEST) === false
    ) {
      return yield* error({
        reason: 'ForeignRootEntry',
        path: workspaceRoot,
        message: `Managed workspace root contains foreign entries`,
        recoveryPaths: entries.map((entry) => NodePath.join(workspaceRoot, entry)),
      })
    }
    const repos = NodePath.join(workspaceRoot, 'repos')
    const repoEntries = yield* io({
      path: repos,
      message: `Cannot inspect managed repos directory '${repos}'`,
      try: () => readdir(repos),
    })
    if (repoEntries.length !== 0) {
      return yield* error({
        reason: 'ForeignRootEntry',
        path: repos,
        message: `Managed repos directory is not empty before install`,
        recoveryPaths: repoEntries.map((entry) => NodePath.join(repos, entry)),
      })
    }
  })

const removeManagedEmptyRoot = ({
  workspaceRoot,
  expected,
  runtime,
}: {
  workspaceRoot: string
  expected: RootManifest
  runtime: OwnedWorktreeAcquisitionRuntime
}) =>
  Effect.gen(function* () {
    yield* assertManagedEmptyRoot({ workspaceRoot, expected })
    yield* io({
      path: workspaceRoot,
      message: `Cannot remove managed empty workspace root '${workspaceRoot}'`,
      recoveryPaths: [workspaceRoot],
      try: async () => {
        await unlink(NodePath.join(workspaceRoot, OWNED_WORKTREE_ROOT_MANIFEST))
        await rmdir(NodePath.join(workspaceRoot, 'repos'))
        await rmdir(workspaceRoot)
      },
    })
    yield* syncDirectory({ path: NodePath.dirname(workspaceRoot), runtime })
  })

const removeManagedRootStage = ({
  paths,
  expected,
  runtime,
}: {
  paths: Paths
  expected: RootManifest
  runtime: OwnedWorktreeAcquisitionRuntime
}) =>
  Effect.gen(function* () {
    const entries = yield* io({
      path: paths.rootStagePath,
      message: `Cannot inspect staged workspace root '${paths.rootStagePath}'`,
      try: () => readdir(paths.rootStagePath),
    })
    if (entries.length === 0) {
      yield* io({
        path: paths.rootStagePath,
        message: `Cannot remove incomplete empty staged root '${paths.rootStagePath}'`,
        try: () => rmdir(paths.rootStagePath),
      })
      yield* syncDirectory({ path: paths.parent, runtime })
      return
    }
    if (entries.includes(OWNED_WORKTREE_ROOT_MANIFEST) === true) {
      return yield* removeManagedEmptyRoot({
        workspaceRoot: paths.rootStagePath,
        expected,
        runtime,
      })
    }
    if (entries.length !== 1 || entries[0] !== 'repos') {
      return yield* error({
        reason: 'ForeignRootEntry',
        path: paths.rootStagePath,
        message: `Incomplete staged root contains foreign entries`,
        recoveryPaths: entries.map((entry) => NodePath.join(paths.rootStagePath, entry)),
      })
    }
    const repos = NodePath.join(paths.rootStagePath, 'repos')
    const repoEntries = yield* io({
      path: repos,
      message: `Cannot inspect staged repos '${repos}'`,
      try: () => readdir(repos),
    })
    if (repoEntries.length !== 0) {
      return yield* error({
        reason: 'ForeignRootEntry',
        path: repos,
        message: `Incomplete staged root contains foreign repositories`,
        recoveryPaths: repoEntries.map((entry) => NodePath.join(repos, entry)),
      })
    }
    yield* io({
      path: paths.rootStagePath,
      message: `Cannot remove incomplete staged root '${paths.rootStagePath}'`,
      try: async () => {
        await rmdir(repos)
        await rmdir(paths.rootStagePath)
      },
    })
    yield* syncDirectory({ path: paths.parent, runtime })
  })

const configContext = ({
  workspaceRoot,
  ownedMember,
  configName,
}: {
  workspaceRoot: string
  ownedMember: string
  configName: OwnedWorktreeConfigName
}): OwnedWorkspaceGenerationContext => {
  const ownedWorktree = NodePath.join(workspaceRoot, 'repos', ownedMember)
  return {
    workspaceRoot: EffectPath.unsafe.absoluteDir(`${workspaceRoot}/`),
    ownedWorktree: EffectPath.unsafe.absoluteDir(`${ownedWorktree}/`),
    configPath: EffectPath.unsafe.absoluteFile(NodePath.join(ownedWorktree, configName)),
    configName,
  }
}

const ensureConfigSymlink = ({
  context,
  runtime,
  createIfMissing = true,
}: {
  context: OwnedWorkspaceGenerationContext
  runtime: OwnedWorktreeAcquisitionRuntime
  createIfMissing?: boolean
}) =>
  Effect.gen(function* () {
    const linkPath = NodePath.join(context.workspaceRoot, context.configName)
    const expectedTarget = NodePath.posix.join(
      'repos',
      NodePath.basename(context.ownedWorktree),
      context.configName,
    )
    const targetExists = yield* io({
      path: context.configPath,
      message: `Cannot inspect authority config '${context.configPath}'`,
      try: () => pathExists(context.configPath),
    })
    if (targetExists === false) {
      return yield* error({
        reason: 'ConfigMissing',
        path: context.configPath,
        message: `Authority config '${context.configPath}' is missing after worktree install`,
      })
    }
    const linkExists = yield* io({
      path: linkPath,
      message: `Cannot inspect root config link '${linkPath}'`,
      try: () => pathExists(linkPath),
    })
    if (linkExists === false && createIfMissing === false) {
      return yield* error({
        reason: 'ConfigSymlinkInvalid',
        path: linkPath,
        message: `Root config authority symlink is missing`,
        recoveryPaths: [linkPath, context.configPath],
      })
    }
    if (linkExists === false) {
      yield* io({
        path: linkPath,
        message: `Cannot create root config link '${linkPath}'`,
        recoveryPaths: [linkPath],
        try: () => symlink(expectedTarget, linkPath),
      })
      yield* syncDirectory({ path: context.workspaceRoot, runtime })
    }
    const [linkStats, actualTarget] = yield* Effect.all([
      io({ path: linkPath, message: `Cannot lstat '${linkPath}'`, try: () => lstat(linkPath) }),
      io({
        path: linkPath,
        message: `Cannot readlink '${linkPath}'`,
        try: () => readlink(linkPath),
      }),
    ])
    if (linkStats.isSymbolicLink() === false || actualTarget !== expectedTarget) {
      return yield* error({
        reason: 'ConfigSymlinkInvalid',
        path: linkPath,
        message: `Root config must be the relative symlink '${expectedTarget}'`,
        recoveryPaths: [linkPath, context.configPath],
      })
    }
    const resolved = yield* io({
      path: linkPath,
      message: `Cannot resolve root config link '${linkPath}'`,
      try: () => realpath(linkPath),
    })
    if (normalizedAbsolute(resolved) !== normalizedAbsolute(context.configPath)) {
      return yield* error({
        reason: 'ConfigSymlinkInvalid',
        path: linkPath,
        message: `Root config link resolves outside the owned worktree authority`,
      })
    }
  })

const resultFromContext = (
  context: OwnedWorkspaceGenerationContext,
): OwnedWorktreeAcquisitionResult => ({
  _tag: 'Acquired',
  workspaceRoot: context.workspaceRoot,
  ownedWorktree: context.ownedWorktree,
  defaultCwd: context.ownedWorktree,
  configPath: context.configPath,
  configName: context.configName,
})

const finishForward = <R, E>({
  journal,
  configName,
  generate,
  runtime,
}: {
  journal: Journal
  configName: OwnedWorktreeConfigName
  generate: (context: OwnedWorkspaceGenerationContext) => Effect.Effect<void, E, R>
  runtime: OwnedWorktreeAcquisitionRuntime
}) =>
  Effect.gen(function* () {
    const paths = derivePaths({
      workspaceRoot: journal.workspaceRoot,
      ownedMember: journal.ownedMember,
    })
    const expected = rootManifestFromJournal(journal)
    yield* verifyIdentity({
      bareRepo: journal.bareRepo,
      worktree: paths.ownedWorktree,
      workspaceRoot: paths.workspaceRoot,
      expected,
    })
    const observedManifest = yield* decodeRootManifest(paths.rootManifestPath)
    if (canonicalRootManifest(observedManifest) !== canonicalRootManifest(expected)) {
      return yield* error({
        reason: 'RecoveryConflict',
        path: paths.rootManifestPath,
        message: `Installed workspace ownership manifest conflicts with journal`,
      })
    }
    const context = configContext({
      workspaceRoot: journal.workspaceRoot,
      ownedMember: journal.ownedMember,
      configName,
    })
    const generationAlreadyJournaled = journal.state === 'generated' || journal.state === 'complete'
    yield* ensureConfigSymlink({
      context,
      runtime,
      createIfMissing: generationAlreadyJournaled === false,
    })
    if (generationAlreadyJournaled === false) {
      yield* afterBoundary({ runtime, boundary: 'ConfigLinked', journalPath: paths.journalPath })
      yield* generate(context).pipe(
        Effect.mapError((cause) =>
          normalizeError({
            cause,
            path: journal.workspaceRoot,
            message: `Workspace generation failed for '${journal.workspaceRoot}'`,
            reason: 'GenerationFailed',
            recoveryPaths: [paths.journalPath, journal.workspaceRoot],
          }),
        ),
      )
      yield* afterBoundary({ runtime, boundary: 'Generated', journalPath: paths.journalPath })
      yield* writeJournal({ journal, state: 'generated', path: paths.journalPath, runtime })
      yield* afterBoundary({
        runtime,
        boundary: 'GeneratedJournaled',
        journalPath: paths.journalPath,
      })
    }
    if (journal.state !== 'complete') {
      yield* writeJournal({ journal, state: 'complete', path: paths.journalPath, runtime })
      yield* afterBoundary({
        runtime,
        boundary: 'CompleteJournaled',
        journalPath: paths.journalPath,
      })
    }
    yield* removeDurable({ path: paths.journalPath, runtime })
    yield* afterBoundary({ runtime, boundary: 'JournalRemoved', journalPath: paths.journalPath })
    return resultFromContext(context)
  })

/**
 * Move an existing canonical branch worktree into `workspaceRoot/repos/<ownedMember>` without
 * checking out, copying, resetting, stashing, pruning, or creating a branch.
 */
const acquireOwnedWorktreeUnlocked = <R, E>({
  bareRepo,
  workspaceRoot,
  ownedMember,
  branch,
  generate,
  callerCwd = process.cwd(),
  runtime = {},
}: {
  bareRepo: string
  workspaceRoot: string
  ownedMember: string
  branch: string
  generate: (context: OwnedWorkspaceGenerationContext) => Effect.Effect<void, E, R>
  callerCwd?: string
  runtime?: OwnedWorktreeAcquisitionRuntime
}): Effect.Effect<
  OwnedWorktreeAcquisitionResult,
  OwnedWorktreeAcquisitionError,
  R | FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const normalizedRoot = normalizedAbsolute(workspaceRoot)
    const completeManifestPath = NodePath.join(normalizedRoot, OWNED_WORKTREE_ROOT_MANIFEST)
    const completeManifestExists = yield* io({
      path: completeManifestPath,
      message: `Cannot inspect complete workspace manifest '${completeManifestPath}'`,
      try: () => pathExists(completeManifestPath),
    })
    if (completeManifestExists === true) {
      const manifest = yield* readCompleteManifest(normalizedRoot)
      const requestedBareRepo = normalizedAbsolute(bareRepo)
      if (
        manifest.bareRepo !== requestedBareRepo ||
        manifest.ownedMember !== ownedMember ||
        manifest.branchRef !== `refs/heads/${branch}`
      ) {
        return yield* error({
          reason: 'GitIdentityConflict',
          path: completeManifestPath,
          message: `Complete workspace identity conflicts with the acquisition request`,
          recoveryPaths: [completeManifestPath, manifest.bareRepo],
        })
      }
      const paths = derivePaths({ workspaceRoot: normalizedRoot, ownedMember })
      const journalExists = yield* io({
        path: paths.journalPath,
        message: `Cannot inspect '${paths.journalPath}'`,
        try: () => pathExists(paths.journalPath),
      })
      if (journalExists === true) {
        return yield* error({
          reason: 'RecoveryConflict',
          path: paths.journalPath,
          message: `Complete workspace still has an acquisition journal; explicit recovery is required`,
          recoveryPaths: [paths.journalPath, normalizedRoot],
        })
      }
      yield* observeOwnedWorkspaceIdentity({ manifest, worktree: paths.ownedWorktree })
      const configName = yield* discoverConfigName(paths.ownedWorktree)
      const context = configContext({ workspaceRoot: normalizedRoot, ownedMember, configName })
      yield* ensureConfigSymlink({ context, runtime, createIfMissing: false })
      return resultFromContext(context)
    }

    const prepared = yield* preflight({ bareRepo, workspaceRoot, ownedMember, branch, callerCwd })
    const journal = journalFromPrepared(prepared)
    const { paths } = prepared
    yield* afterBoundary({ runtime, boundary: 'PreflightComplete', journalPath: paths.journalPath })
    yield* writeJournal({ journal, state: 'prepared', path: paths.journalPath, runtime })
    yield* afterBoundary({ runtime, boundary: 'JournalPrepared', journalPath: paths.journalPath })

    yield* command(
      prepared.bareRepo,
      Git.moveWorktree({
        repoPath: prepared.bareRepo,
        fromPath: paths.workspaceRoot,
        toPath: paths.tempPath,
      }),
    )
    yield* afterBoundary({ runtime, boundary: 'MovedToTemp', journalPath: paths.journalPath })
    yield* verifyIdentity({
      bareRepo: prepared.bareRepo,
      worktree: paths.tempPath,
      workspaceRoot: paths.workspaceRoot,
      expected: journal,
    })
    yield* writeJournal({ journal, state: 'moved_to_temp', path: paths.journalPath, runtime })
    yield* afterBoundary({
      runtime,
      boundary: 'MovedToTempJournaled',
      journalPath: paths.journalPath,
    })

    yield* createManagedRoot({ journal, paths, runtime })
    yield* afterBoundary({ runtime, boundary: 'RootCreated', journalPath: paths.journalPath })
    yield* assertManagedEmptyRoot({
      workspaceRoot: paths.workspaceRoot,
      expected: rootManifestFromJournal(journal),
    })
    yield* writeJournal({ journal, state: 'root_created', path: paths.journalPath, runtime })
    yield* afterBoundary({
      runtime,
      boundary: 'RootCreatedJournaled',
      journalPath: paths.journalPath,
    })

    yield* command(
      prepared.bareRepo,
      Git.moveWorktree({
        repoPath: prepared.bareRepo,
        fromPath: paths.tempPath,
        toPath: paths.ownedWorktree,
      }),
    )
    yield* afterBoundary({ runtime, boundary: 'Installed', journalPath: paths.journalPath })
    yield* verifyIdentity({
      bareRepo: prepared.bareRepo,
      worktree: paths.ownedWorktree,
      workspaceRoot: paths.workspaceRoot,
      expected: journal,
    })
    yield* writeJournal({ journal, state: 'installed', path: paths.journalPath, runtime })
    yield* afterBoundary({
      runtime,
      boundary: 'InstalledJournaled',
      journalPath: paths.journalPath,
    })
    return yield* finishForward({ journal, configName: prepared.configName, generate, runtime })
  })

/** Reconcile an interrupted acquisition from observed paths and the bare repository registration. */
const recoverOwnedWorktreeAcquisitionUnlocked = <R, E>({
  workspaceRoot: rawWorkspaceRoot,
  generate,
  runtime = {},
}: {
  workspaceRoot: string
  generate: (context: OwnedWorkspaceGenerationContext) => Effect.Effect<void, E, R>
  runtime?: OwnedWorktreeAcquisitionRuntime
}): Effect.Effect<
  OwnedWorktreeRecoveryResult,
  OwnedWorktreeAcquisitionError,
  R | FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const workspaceRoot = normalizedAbsolute(rawWorkspaceRoot)
    const journalPath = ownedWorktreeAcquisitionJournalPath(workspaceRoot)
    const journal = yield* decodeJournal(journalPath)
    if (journal.workspaceRoot !== workspaceRoot) {
      return yield* error({
        reason: 'RecoveryConflict',
        path: journalPath,
        message: `Journal workspace '${journal.workspaceRoot}' does not match '${workspaceRoot}'`,
        recoveryPaths: [journalPath, workspaceRoot],
      })
    }
    const paths = derivePaths({ workspaceRoot, ownedMember: journal.ownedMember })
    if (journal.tempPath !== paths.tempPath) {
      return yield* error({
        reason: 'RecoveryConflict',
        path: journalPath,
        message: `Journal temporary path is not canonical for '${workspaceRoot}'`,
      })
    }
    const registrations = yield* command(journal.bareRepo, Git.listWorktrees(journal.bareRepo))
    const matching = registrations.filter(
      (registration) =>
        registration.head === journal.head &&
        Option.getOrUndefined(registration.branch) ===
          journal.branchRef.slice('refs/heads/'.length),
    )
    if (matching.length !== 1) {
      return yield* error({
        reason: 'RecoveryConflict',
        path: journal.bareRepo,
        message: `Cannot uniquely locate journaled branch registration`,
        recoveryPaths: matching.map((registration) => registration.path),
      })
    }
    const registeredPath = normalizedAbsolute(matching[0]!.path)
    if (registeredPath === paths.ownedWorktree) {
      const configName = yield* discoverConfigName(paths.ownedWorktree)
      const result = yield* finishForward({ journal, configName, generate, runtime })
      return { ...result, _tag: 'RolledForward' } as const
    }
    if (registeredPath !== paths.workspaceRoot && registeredPath !== paths.tempPath) {
      return yield* error({
        reason: 'RecoveryConflict',
        path: registeredPath,
        message: `Journaled branch is registered at an unexpected path '${registeredPath}'`,
        recoveryPaths: [journalPath, registeredPath],
      })
    }

    if (registeredPath === paths.tempPath) {
      const rootExists = yield* io({
        path: paths.workspaceRoot,
        message: `Cannot inspect '${paths.workspaceRoot}'`,
        try: () => pathExists(paths.workspaceRoot),
      })
      if (rootExists === true) {
        yield* removeManagedEmptyRoot({
          workspaceRoot: paths.workspaceRoot,
          expected: rootManifestFromJournal(journal),
          runtime,
        })
      }
      const rootStageExists = yield* io({
        path: paths.rootStagePath,
        message: `Cannot inspect '${paths.rootStagePath}'`,
        try: () => pathExists(paths.rootStagePath),
      })
      if (rootStageExists === true) {
        yield* removeManagedRootStage({
          paths,
          expected: rootManifestFromJournal(journal),
          runtime,
        })
      }
      yield* command(
        journal.bareRepo,
        Git.moveWorktree({
          repoPath: journal.bareRepo,
          fromPath: paths.tempPath,
          toPath: paths.workspaceRoot,
        }),
      )
    }
    yield* verifyIdentity({
      bareRepo: journal.bareRepo,
      worktree: paths.workspaceRoot,
      workspaceRoot: paths.workspaceRoot,
      expected: journal,
    })
    yield* removeDurable({ path: journalPath, runtime })
    return { _tag: 'RolledBack', workspaceRoot: paths.workspaceRoot }
  })

const readCompleteManifest = (workspaceRoot: string) =>
  decodeRootManifest(NodePath.join(workspaceRoot, OWNED_WORKTREE_ROOT_MANIFEST)).pipe(
    Effect.flatMap((manifest) => {
      if (manifest.workspaceRoot !== workspaceRoot) {
        return error({
          reason: 'RecoveryConflict',
          path: workspaceRoot,
          message: `Root ownership manifest belongs to '${manifest.workspaceRoot}'`,
        })
      }
      return Effect.succeed(manifest)
    }),
  )

const assertCleanupShape = ({
  manifest,
  configName,
}: {
  manifest: RootManifest
  configName: OwnedWorktreeConfigName
}) =>
  Effect.gen(function* () {
    const rootEntries = (yield* io({
      path: manifest.workspaceRoot,
      message: `Cannot inspect cleaned workspace '${manifest.workspaceRoot}'`,
      try: () => readdir(manifest.workspaceRoot),
    })).toSorted()
    const expectedEntries = [OWNED_WORKTREE_ROOT_MANIFEST, 'repos', configName].toSorted()
    if (
      rootEntries.length !== expectedEntries.length ||
      rootEntries.some((entry, index) => entry !== expectedEntries[index]) === true
    ) {
      return yield* error({
        reason: 'ForeignRootEntry',
        path: manifest.workspaceRoot,
        message: `Generated cleanup left foreign or generated root entries`,
        recoveryPaths: rootEntries.map((entry) => NodePath.join(manifest.workspaceRoot, entry)),
      })
    }
    const repos = NodePath.join(manifest.workspaceRoot, 'repos')
    const repoEntries = yield* io({
      path: repos,
      message: `Cannot inspect cleaned repos directory '${repos}'`,
      try: () => readdir(repos),
    })
    if (repoEntries.length !== 1 || repoEntries[0] !== manifest.ownedMember) {
      return yield* error({
        reason: 'ForeignRootEntry',
        path: repos,
        message: `Generated cleanup must leave only the owned worktree`,
        recoveryPaths: repoEntries.map((entry) => NodePath.join(repos, entry)),
      })
    }
  })

/** Restore the canonical worktree pathname after callback-owned generated state has been removed. */
const teardownOwnedWorkspaceUnlocked = <R, E>({
  workspaceRoot: rawWorkspaceRoot,
  cleanup,
  callerCwd = process.cwd(),
  runtime = {},
}: {
  workspaceRoot: string
  cleanup: (context: OwnedWorkspaceGenerationContext) => Effect.Effect<void, E, R>
  callerCwd?: string
  runtime?: OwnedWorktreeAcquisitionRuntime
}): Effect.Effect<
  OwnedWorkspaceTeardownResult,
  OwnedWorktreeAcquisitionError,
  R | FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const workspaceRoot = normalizedAbsolute(rawWorkspaceRoot)
    const normalizedCwd = normalizedAbsolute(callerCwd)
    if (isWithin({ parent: workspaceRoot, path: normalizedCwd }) === true) {
      return yield* error({
        reason: 'PreflightRefused',
        path: normalizedCwd,
        message: `Caller cwd '${normalizedCwd}' is inside workspace '${workspaceRoot}'`,
      })
    }
    const manifest = yield* readCompleteManifest(workspaceRoot)
    const paths = derivePaths({ workspaceRoot, ownedMember: manifest.ownedMember })
    if (
      (yield* io({
        path: paths.tempPath,
        message: `Cannot inspect '${paths.tempPath}'`,
        try: () => pathExists(paths.tempPath),
      })) === true
    ) {
      return yield* error({
        reason: 'Collision',
        path: paths.tempPath,
        message: `Teardown temporary path already exists`,
      })
    }
    const teardownIdentity = yield* observeOwnedWorkspaceIdentity({
      manifest,
      worktree: paths.ownedWorktree,
    })
    const configName = yield* discoverConfigName(paths.ownedWorktree)
    const context = configContext({ workspaceRoot, ownedMember: manifest.ownedMember, configName })
    yield* ensureConfigSymlink({ context, runtime, createIfMissing: false })
    yield* cleanup(context).pipe(
      Effect.mapError((cause) =>
        normalizeError({
          cause,
          path: workspaceRoot,
          message: `Generated workspace cleanup failed for '${workspaceRoot}'`,
          reason: 'CleanupFailed',
          recoveryPaths: [workspaceRoot],
        }),
      ),
    )
    yield* ensureConfigSymlink({ context, runtime, createIfMissing: false })
    yield* assertCleanupShape({ manifest, configName })
    yield* verifyIdentity({
      bareRepo: manifest.bareRepo,
      worktree: paths.ownedWorktree,
      workspaceRoot,
      expected: teardownIdentity,
    })
    yield* command(
      manifest.bareRepo,
      Git.moveWorktree({
        repoPath: manifest.bareRepo,
        fromPath: paths.ownedWorktree,
        toPath: paths.tempPath,
      }),
    )
    yield* verifyIdentity({
      bareRepo: manifest.bareRepo,
      worktree: paths.tempPath,
      workspaceRoot,
      expected: teardownIdentity,
    })
    yield* io({
      path: workspaceRoot,
      message: `Cannot remove workspace authority metadata`,
      recoveryPaths: [workspaceRoot, paths.tempPath],
      try: async () => {
        await unlink(NodePath.join(workspaceRoot, configName))
        await unlink(paths.rootManifestPath)
      },
    })
    yield* syncDirectory({ path: workspaceRoot, runtime })
    yield* io({
      path: workspaceRoot,
      message: `Cannot remove empty synthesized workspace root '${workspaceRoot}'`,
      recoveryPaths: [workspaceRoot, paths.tempPath],
      try: async () => {
        await rmdir(NodePath.join(workspaceRoot, 'repos'))
        await rmdir(workspaceRoot)
      },
    })
    yield* syncDirectory({ path: paths.parent, runtime })
    yield* command(
      manifest.bareRepo,
      Git.moveWorktree({
        repoPath: manifest.bareRepo,
        fromPath: paths.tempPath,
        toPath: workspaceRoot,
      }),
    )
    yield* verifyIdentity({
      bareRepo: manifest.bareRepo,
      worktree: workspaceRoot,
      workspaceRoot,
      expected: teardownIdentity,
    })
    return { _tag: 'TornDown', restoredWorktree: workspaceRoot, defaultCwd: workspaceRoot }
  })
