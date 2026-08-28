import * as NodePath from 'node:path'

import { Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { compositionApply } from '../../lib/composition-apply.ts'
import type {
  CompositionApplyOutput,
  CompositionApplyRequest,
  CompositionCommandOutput,
} from '../../lib/composition-apply-schema.ts'
import { resolveCompositionCapabilities } from '../../lib/composition-capability-resolver.ts'
import { compositionApplyRuntimeFromEnv } from '../../lib/composition-runtime.ts'
import {
  getMemberPath,
  isRemoteSource,
  parseSourceString,
  readMegarepoConfig,
  type CompositionGeneratorConfig,
} from '../../lib/config.ts'
import {
  BUCK_MEMBER_MANIFEST_FILENAME,
  decodeBuckMemberManifestJson,
  type BuckMemberManifest,
} from '../../lib/generators/composition-root.ts'
import * as Git from '../../lib/git.ts'
import { LOCK_FILE_NAME, readLockFile, type LockFile } from '../../lib/lock.ts'
import {
  acquireOwnedWorktree,
  ownedWorktreeAcquisitionJournalPath,
  planOwnedWorktreeAcquisition,
  recoverOwnedWorktreeAcquisition,
  type OwnedWorkspaceGenerationContext,
} from '../../lib/owned-worktree-acquisition.ts'
import {
  OWNED_WORKTREE_ROOT_MANIFEST,
  OwnedWorktreeAcquisitionJournal,
  OwnedWorktreeRootManifest,
} from '../../lib/owned-worktree-acquisition-schema.ts'
import { refreshWorkspaceRegistry } from '../../lib/store-liveness.ts'
import { Store, type MegarepoStore } from '../../lib/store.ts'

const strictParseOptions = { errors: 'all', onExcessProperty: 'error' } as const
const OwnedManifestJson = Schema.fromJsonString(OwnedWorktreeRootManifest)
const AcquisitionJournalJson = Schema.fromJsonString(OwnedWorktreeAcquisitionJournal)

interface OwnedIdentity {
  readonly workspaceRoot: AbsoluteDirPath
  readonly ownedMemberKey: string
  readonly ownedSourcePath: AbsoluteDirPath
  readonly ownedMemberPath: AbsoluteDirPath
  readonly bareRepo: string
  readonly branch: string
  readonly synthesized: boolean
}

const ownedKeyFromManifest = (manifest: BuckMemberManifest): string => {
  const match = /^repos\/([A-Za-z0-9][A-Za-z0-9._-]*)$/u.exec(manifest.mount)
  if (match === null) throw new TypeError(`Owned manifest mount must be repos/<member>: ${manifest.mount}`)
  return match[1]!
}

const readManifest = ({ fs, memberRoot }: { readonly fs: FileSystem.FileSystem; readonly memberRoot: string }) =>
  fs
    .readFileString(
      EffectPath.unsafe.absoluteFile(NodePath.join(memberRoot, BUCK_MEMBER_MANIFEST_FILENAME)),
    )
    .pipe(Effect.map(decodeBuckMemberManifestJson))

const deriveLegacyIdentity = ({
  workspaceRoot,
  manifest,
}: {
  readonly workspaceRoot: AbsoluteDirPath
  readonly manifest: BuckMemberManifest
}) =>
  Effect.gen(function* () {
    const branchOption = yield* Git.getCurrentBranch(workspaceRoot)
    if (Option.isNone(branchOption) === true) {
      return yield* Effect.fail(new TypeError('Composition requires a branch-attached owned worktree'))
    }
    const bareRepo = yield* Git.runCommand({
      cwd: workspaceRoot,
      args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    })
    const ownedMemberKey = ownedKeyFromManifest(manifest)
    return {
      workspaceRoot,
      ownedMemberKey,
      ownedSourcePath: workspaceRoot,
      ownedMemberPath: getMemberPath({ megarepoRoot: workspaceRoot, name: ownedMemberKey }),
      bareRepo,
      branch: branchOption.value,
      synthesized: false,
    } satisfies OwnedIdentity
  })

const readOwnedIdentity = ({
  workspaceRoot,
  fs,
}: {
  readonly workspaceRoot: AbsoluteDirPath
  readonly fs: FileSystem.FileSystem
}) =>
  Effect.gen(function* () {
    const manifestPath = EffectPath.unsafe.absoluteFile(
      NodePath.join(workspaceRoot, OWNED_WORKTREE_ROOT_MANIFEST),
    )
    const rootManifest = yield* fs.readFileString(manifestPath).pipe(
      Effect.flatMap((bytes) =>
        Schema.decodeUnknownEffect(OwnedManifestJson, strictParseOptions)(bytes),
      ),
    )
    const ownedMemberPath = getMemberPath({
      megarepoRoot: workspaceRoot,
      name: rootManifest.ownedMember,
    })
    return {
      workspaceRoot,
      ownedMemberKey: rootManifest.ownedMember,
      ownedSourcePath: ownedMemberPath,
      ownedMemberPath,
      bareRepo: rootManifest.bareRepo,
      branch: rootManifest.branchRef.slice('refs/heads/'.length),
      synthesized: true,
    } satisfies OwnedIdentity
  })

const loadOwnedIdentity = ({
  workspaceRoot,
}: {
  readonly workspaceRoot: AbsoluteDirPath
}): Effect.Effect<OwnedIdentity, unknown, FileSystem.FileSystem | ChildProcessSpawner> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const managedManifestPath = EffectPath.unsafe.absoluteFile(
      NodePath.join(workspaceRoot, OWNED_WORKTREE_ROOT_MANIFEST),
    )
    if (yield* fs.exists(managedManifestPath)) {
      return yield* readOwnedIdentity({ workspaceRoot, fs })
    }
    const journalPath = EffectPath.unsafe.absoluteFile(
      ownedWorktreeAcquisitionJournalPath(workspaceRoot),
    )
    if (yield* fs.exists(journalPath)) {
      const journal = yield* fs.readFileString(journalPath).pipe(
        Effect.flatMap((bytes) =>
          Schema.decodeUnknownEffect(AcquisitionJournalJson, strictParseOptions)(bytes),
        ),
      )
      const ownedMemberPath = getMemberPath({
        megarepoRoot: workspaceRoot,
        name: journal.ownedMember,
      })
      const installed = yield* fs.exists(ownedMemberPath)
      const temporary = EffectPath.unsafe.absoluteDir(`${journal.tempPath}/`)
      return {
        workspaceRoot,
        ownedMemberKey: journal.ownedMember,
        ownedSourcePath: installed === true ? ownedMemberPath : temporary,
        ownedMemberPath,
        bareRepo: journal.bareRepo,
        branch: journal.branchRef.slice('refs/heads/'.length),
        synthesized: false,
      } satisfies OwnedIdentity
    }
    const manifest = yield* readManifest({ fs, memberRoot: workspaceRoot })
    return yield* deriveLegacyIdentity({ workspaceRoot, manifest })
  })

const lockedMembers = ({
  configMembers,
  lockFile,
  store,
}: {
  readonly configMembers: Readonly<Record<string, string>>
  readonly lockFile: LockFile
  readonly store: MegarepoStore
}) =>
  Effect.gen(function* () {
    const values: Array<CompositionApplyRequest['lockedMembers'][number]> = []
    for (const [key, sourceString] of Object.entries(configMembers).toSorted(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    )) {
      const source = parseSourceString(sourceString)
      if (source === undefined || isRemoteSource(source) === false) {
        return yield* Effect.fail(
          new TypeError(`Composition member '${key}' must have an immutable remote source`),
        )
      }
      const locked = lockFile.members[key]
      if (locked === undefined) {
        return yield* Effect.fail(
          new TypeError(`Composition apply requires a lock entry for '${key}'; run mr fetch first`),
        )
      }
      const sourcePath = store.getWorktreePath({
        source,
        ref: locked.commit,
        refType: 'commit',
      })
      if ((yield* store.hasWorktree({ source, ref: locked.commit, refType: 'commit' })) === false) {
        return yield* Effect.fail(
          new TypeError(
            `Composition apply requires immutable commit source '${sourcePath}'; run mr fetch first`,
          ),
        )
      }
      const actualCommit = yield* Git.getCurrentCommit(sourcePath)
      if (actualCommit !== locked.commit) {
        return yield* Effect.fail(
          new TypeError(`Immutable source '${sourcePath}' is not at locked commit '${locked.commit}'`),
        )
      }
      values.push({ key, sourcePath: sourcePath.replace(/\/+$/u, ''), lockedCommit: locked.commit })
    }
    return values
  })

const compositionRequest = ({
  identity,
  compositionConfig,
  locked,
  dryRun,
  env,
}: {
  readonly identity: OwnedIdentity
  readonly compositionConfig: CompositionGeneratorConfig
  readonly locked: CompositionApplyRequest['lockedMembers']
  readonly dryRun: boolean
  readonly env: Readonly<Record<string, string | undefined>>
}): CompositionApplyRequest => ({
  workspaceRoot: identity.workspaceRoot.replace(/\/+$/u, ''),
  ownedMemberKey: identity.ownedMemberKey,
  ownedMemberPath: identity.ownedMemberPath.replace(/\/+$/u, ''),
  compositionConfig,
  cacheSections: [],
  lockedMembers: locked,
  dryRun,
  allowVerifiedDarwinAdvance:
    compositionConfig.allowVerifiedDarwinAdvance === true ||
    env['MR_COMPOSITION_DARWIN_ADVANCE_VERIFIED'] === '1',
})

/** Apply decision-0020 composition or produce its exact acquisition and application plans. */
export const runCompositionApply = ({
  workspaceRoot,
  dryRun,
  callerCwd,
  env = process.env,
}: {
  readonly workspaceRoot: AbsoluteDirPath
  readonly dryRun: boolean
  readonly callerCwd: AbsoluteDirPath
  readonly env?: Readonly<Record<string, string | undefined>>
}): Effect.Effect<
  CompositionCommandOutput,
  unknown,
  FileSystem.FileSystem | ChildProcessSpawner | Store
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const store = yield* Store
    const identity = yield* loadOwnedIdentity({ workspaceRoot })
    const { config } = yield* readMegarepoConfig(identity.ownedSourcePath)
    const compositionConfig = config.generators?.composition
    if (compositionConfig?.enabled !== true) {
      return yield* Effect.fail(new TypeError('Composition runtime is not enabled'))
    }
    if (Object.hasOwn(config.members, identity.ownedMemberKey) === true) {
      return yield* Effect.fail(
        new TypeError(`Owned member '${identity.ownedMemberKey}' must remain implicit`),
      )
    }
    const lockPath = EffectPath.ops.join(
      identity.ownedSourcePath,
      EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
    )
    const lockOption = yield* readLockFile(lockPath)
    if (Option.isNone(lockOption) === true) {
      return yield* Effect.fail(
        new TypeError(`Composition apply requires '${lockPath}'; run mr fetch first`),
      )
    }
    const locked = yield* lockedMembers({ configMembers: config.members, lockFile: lockOption.value, store })
    const acquisition = yield* planOwnedWorktreeAcquisition({
      bareRepo: identity.bareRepo,
      workspaceRoot: identity.workspaceRoot,
      ownedMember: identity.ownedMemberKey,
      branch: identity.branch,
      callerCwd,
    })
    if (acquisition._tag === 'Refused') return yield* Effect.fail(acquisition.error)

    if (dryRun === true) {
      const runtimeBase = compositionApplyRuntimeFromEnv({
        workspaceRoot: identity.workspaceRoot.replace(/\/+$/u, ''),
        env,
      })
      const plannedIdentity = {
        ...identity,
        ownedMemberPath: EffectPath.unsafe.absoluteDir(`${acquisition.ownedWorktree}/`),
      }
      const runtime = {
        ...runtimeBase,
        primitives: {
          readManifest: (memberRoot: string) =>
            memberRoot === acquisition.ownedWorktree
              ? Effect.runPromise(readManifest({ fs, memberRoot: identity.ownedSourcePath }))
              : Effect.runPromise(readManifest({ fs, memberRoot })),
          resolveCapabilities: (input) =>
            resolveCompositionCapabilities({
              ...input,
              memberRoot:
                input.memberRoot === acquisition.ownedWorktree
                  ? identity.ownedSourcePath.replace(/\/+$/u, '')
                  : input.memberRoot,
            }),
        },
      } satisfies ReturnType<typeof compositionApplyRuntimeFromEnv>
      const composition = yield* compositionApply({
        request: compositionRequest({
          identity: plannedIdentity,
          compositionConfig,
          locked,
          dryRun: true,
          env,
        }),
        runtime,
      })
      return {
        _tag: 'CompositionDryRun',
        acquisition,
        composition,
        workspaceRoot: identity.workspaceRoot,
        defaultCwd: acquisition.ownedWorktree,
      }
    }

    let composition: CompositionApplyOutput | undefined
    const generate = (context: OwnedWorkspaceGenerationContext) => {
      const appliedIdentity: OwnedIdentity = {
        ...identity,
        ownedSourcePath: context.ownedWorktree,
        ownedMemberPath: context.ownedWorktree,
        synthesized: true,
      }
      const runtime = compositionApplyRuntimeFromEnv({
        workspaceRoot: context.workspaceRoot.replace(/\/+$/u, ''),
        env,
      })
      return compositionApply({
        request: compositionRequest({
          identity: appliedIdentity,
          compositionConfig,
          locked,
          dryRun: false,
          env,
        }),
        runtime,
      }).pipe(Effect.tap((output) => Effect.sync(() => (composition = output))), Effect.asVoid)
    }

    if (acquisition._tag === 'Recover') {
      const recovered = yield* recoverOwnedWorktreeAcquisition({
        workspaceRoot: identity.workspaceRoot,
        generate,
      })
      if (recovered._tag === 'RolledBack') {
        yield* acquireOwnedWorktree({
          bareRepo: identity.bareRepo,
          workspaceRoot: identity.workspaceRoot,
          ownedMember: identity.ownedMemberKey,
          branch: identity.branch,
          callerCwd,
          generate,
        })
      }
    } else {
      const acquired = yield* acquireOwnedWorktree({
        bareRepo: identity.bareRepo,
        workspaceRoot: identity.workspaceRoot,
        ownedMember: identity.ownedMemberKey,
        branch: identity.branch,
        callerCwd,
        generate,
      })
      if (composition === undefined) {
        yield* generate({
          workspaceRoot: EffectPath.unsafe.absoluteDir(`${acquired.workspaceRoot}/`),
          ownedWorktree: EffectPath.unsafe.absoluteDir(`${acquired.ownedWorktree}/`),
          configPath: EffectPath.unsafe.absoluteFile(acquired.configPath),
          configName: acquired.configName,
        })
      }
    }
    if (composition === undefined) {
      return yield* Effect.fail(
        new TypeError(
          `Composition generation did not complete; recover '${ownedWorktreeAcquisitionJournalPath(identity.workspaceRoot)}'`,
        ),
      )
    }
    yield* refreshWorkspaceRegistry({
      workspaceRoot: identity.workspaceRoot,
      store,
      now: Date.now(),
    })
    return {
      _tag: 'CompositionApplied',
      acquisition,
      composition,
      workspaceRoot: identity.workspaceRoot,
      defaultCwd: identity.ownedMemberPath,
    }
  })
