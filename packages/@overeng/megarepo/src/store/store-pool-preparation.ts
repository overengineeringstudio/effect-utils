import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'

import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { inspectPoolHeadHistory } from './store-pool-head-history.ts'
import { PoolInstallQualification, withQualifiedPoolInstall } from './store-pool-install-lease.ts'
import {
  inspectPoolInstall,
  type PoolInstallBinding,
  type runPoolTasks,
} from './store-pool-install.ts'
import { requireOutsidePoolGlobal } from './store-pool-lock-order.ts'
import { PoolError } from './store-pool-state.ts'

const ImmutableExecutable = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (path) =>
      isAbsolute(path) &&
      resolve(path) === path &&
      /^\/nix\/store\/[^/]+\/.+$/u.test(path) &&
      !path.includes('\0'),
  ),
)
const TaskName = Schema.NonEmptyString.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9:._-]*$/u))

/** Explicit root contract: Buck-only roots never manufacture a pnpm/GVS binding. */
export const PoolPreparation = Schema.Union([
  Schema.Struct({ mode: Schema.Literal('pnpm-gvs'), qualification: PoolInstallQualification }),
  Schema.Struct({
    mode: Schema.Literal('buck2'),
    buck2Provider: ImmutableExecutable,
    prepareTasks: Schema.Array(TaskName).check(Schema.makeFilter((tasks) => tasks.length > 0)),
  }),
])
export type PoolPreparation = typeof PoolPreparation.Type
/** Prepared root identity, physical backing paths and authenticated source history. */
export type PoolRootBinding = Pick<
  PoolInstallBinding,
  'identity' | 'backingPaths' | 'sourceHistory'
>

const hold = () =>
  new PoolError({ message: 'Pool root preparation binding is unavailable or changed; HOLD' })
const decodePreparation = Schema.decodeUnknownEffect(PoolPreparation, { onExcessProperty: 'error' })

/** Run the root's real declared preparation tasks through its controller-owned task scope. */
export const preparePoolRoot = ({
  path,
  preparation,
  runTasks,
}: {
  path: string
  preparation: PoolPreparation
  runTasks: typeof runPoolTasks
}) =>
  Effect.gen(function* () {
    yield* requireOutsidePoolGlobal(hold)
    const config = yield* decodePreparation(preparation).pipe(Effect.mapError(hold))
    yield* runTasks({
      path,
      tasks: config.mode === 'pnpm-gvs' ? ['pnpm:install'] : config.prepareTasks,
    })
  })

/** Read-only identity after normal Buck preparation. The capability cell is the
 * canonical immutable Nix projection, not copied mutable node_modules or a GVS claim.
 * Daemons are never started by this inspector; the physical owner drains them.
 */
export const inspectPoolRoot = ({
  base,
  path,
  commit,
  preparation,
}: {
  base: AbsoluteDirPath
  path: string
  commit: string
  preparation: PoolPreparation
}) =>
  Effect.gen(function* () {
    yield* requireOutsidePoolGlobal(hold)
    const config = yield* decodePreparation(preparation).pipe(Effect.mapError(hold))
    if (config.mode === 'pnpm-gvs') return yield* inspectPoolInstall({ base, path, commit })
    const fs = yield* FileSystem.FileSystem
    if (
      (yield* fs.realPath(path)) !== path ||
      (yield* Git.getCurrentCommit(path)) !== commit ||
      (yield* Git.getWorktreeStatus({ worktreePath: path, readOnly: true })).isDirty === true ||
      (yield* fs.realPath(config.buck2Provider)) !== config.buck2Provider
    )
      return yield* hold()
    const provider = yield* fs.lstat(config.buck2Provider)
    if (provider.type !== 'File' || (provider.mode & 0o111) === 0 || (provider.mode & 0o022) !== 0)
      return yield* hold()
    const capabilities = yield* fs.realPath(join(path, '.buck2/capabilities'))
    if (
      /^\/nix\/store\/[^/]+(?:\/.*)?$/u.test(capabilities) === false ||
      (yield* fs.stat(capabilities)).type !== 'Directory'
    )
      return yield* hold()
    const hash = createHash('sha256')
    hash.update('mr-pool-buck-root-v1\0')
    hash.update(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
        commit,
        process.platform,
        process.arch,
        config,
        capabilities,
      ]).pipe(Effect.mapError(hold)),
    )
    hash.update(yield* fs.readFile(join(capabilities, 'defs.bzl')))
    for (const name of ['.buckconfig', '.buckconfig.local']) {
      const file = join(path, name)
      hash.update(name)
      if ((yield* fs.exists(file)) === false) {
        if (name === '.buckconfig') return yield* hold()
        hash.update('absent')
        continue
      }
      const info = yield* fs.lstat(file)
      if (info.type !== 'File' || (yield* fs.realPath(file)) !== file) return yield* hold()
      hash.update(yield* fs.readFile(file))
    }
    const sourceHistory = yield* inspectPoolHeadHistory({
      path,
      admin: yield* Git.getAbsoluteGitDir(path),
      commit,
    })
    hash.update(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(sourceHistory).pipe(
        Effect.mapError(hold),
      ),
    )
    const binding: PoolRootBinding = {
      identity: hash.digest('hex'),
      backingPaths: [],
      sourceHistory,
    }
    return binding
  })

/** GVS use retains its real shared maintenance lease. Buck-only use binds the
 * immutable provider/capability projection; physical ROOT/pins remain caller-owned.
 */
export const withPoolInstallUse =
  ({
    base,
    path,
    commit,
    preparation,
  }: {
    base: AbsoluteDirPath
    path: string
    commit: string
    preparation: PoolPreparation
  }) =>
  <A, E, R>(use: (binding: PoolRootBinding) => Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const config = yield* decodePreparation(preparation).pipe(Effect.mapError(hold))
      if (config.mode === 'pnpm-gvs')
        return yield* withQualifiedPoolInstall({
          base,
          path,
          commit,
          qualification: config.qualification,
        })(use)
      return yield* use(yield* inspectPoolRoot({ base, path, commit, preparation: config }))
    })
