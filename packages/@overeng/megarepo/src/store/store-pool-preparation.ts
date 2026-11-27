import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'

import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { PlatformError } from 'effect/PlatformError'

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
const CapabilityReferencesJson = Schema.fromJsonString(Schema.Array(Schema.String))
const decodeCapabilityReferences = Schema.decodeEffect(CapabilityReferencesJson)
const encodeCapabilityReferences = Schema.encodeSync(CapabilityReferencesJson)

/** The publisher copies selected metadata into a watched real directory while
 * retaining older tool packages. Only the selected immutable profile is authority.
 */
const inspectBuckCapabilities = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const cell = join(path, '.buck2/capabilities')
    const realDirectory = ({
      directory,
      immutable = false,
    }: {
      directory: string
      immutable?: boolean
    }) =>
      Effect.gen(function* () {
        const info = yield* fs.lstat(directory)
        if (
          info.type !== 'Directory' ||
          (yield* fs.realPath(directory)) !== directory ||
          (immutable === true && (info.mode & 0o222) !== 0)
        )
          return yield* hold()
      })
    const realFile = ({ file, immutable = false }: { file: string; immutable?: boolean }) =>
      Effect.gen(function* () {
        const info = yield* fs.lstat(file)
        if (
          info.type !== 'File' ||
          (yield* fs.realPath(file)) !== file ||
          (immutable === true && (info.mode & 0o222) !== 0)
        )
          return yield* hold()
        return yield* fs.readFile(file)
      })
    yield* realDirectory({ directory: join(path, '.buck2') })
    yield* realDirectory({ directory: cell })
    const defs = yield* realFile({ file: join(cell, 'defs.bzl') })
    const text = Buffer.from(defs).toString('utf8')
    const generation = /^GENERATION = "([0-9a-f]{64})"$/mu.exec(text)?.[1]
    if (generation === undefined || [...text.matchAll(/^GENERATION\s*=/gmu)].length !== 1)
      return yield* hold()
    const roots = join(path, '.buck2/capability-roots')
    yield* realDirectory({ directory: roots })
    const root = join(roots, generation)
    if ((yield* fs.lstat(root)).type !== 'SymbolicLink') return yield* hold()
    const profile = yield* fs.realPath(root)
    if (/^\/nix\/store\/[^/]+$/u.test(profile) === false) return yield* hold()
    yield* realDirectory({ directory: profile, immutable: true })
    const hash = createHash('sha256')
    const record = (values: readonly string[]) =>
      hash.update(`${encodeCapabilityReferences(values)}\n`)
    record(['profile', profile, generation, yield* fs.readLink(root)])
    const compareFile = (relative: string) =>
      Effect.gen(function* () {
        const source = yield* realFile({ file: join(profile, relative), immutable: true })
        const selected = yield* realFile({ file: join(cell, relative) })
        if (Buffer.from(source).equals(Buffer.from(selected)) === false) return yield* hold()
        record(['file', relative, createHash('sha256').update(selected).digest('hex')])
      })
    yield* compareFile('defs.bzl')
    yield* compareFile('BUCK')
    const compareTool = (
      relative: string,
    ): Effect.Effect<void, PoolError | PlatformError, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        yield* realDirectory({ directory: join(profile, relative), immutable: true })
        yield* realDirectory({ directory: join(cell, relative) })
        const names = (yield* fs.readDirectory(join(profile, relative))).toSorted()
        const copied = (yield* fs.readDirectory(join(cell, relative))).toSorted()
        if (
          names.length !== copied.length ||
          names.some((name, index) => name !== copied[index]) === true
        )
          return yield* hold()
        for (const name of names) {
          const entry = join(relative, name)
          const source = join(profile, entry)
          const selected = join(cell, entry)
          const info = yield* fs.lstat(source)
          if (info.type === 'Directory') yield* compareTool(entry)
          else if (info.type === 'File') yield* compareFile(entry)
          else if (info.type === 'SymbolicLink') {
            const target = yield* fs.readLink(source)
            if (
              (name !== 'executable' && name !== 'directory') ||
              /^\/nix\/store\/[^/]+(?:\/.*)?$/u.test(target) === false ||
              resolve(target) !== target ||
              (yield* fs.realPath(target)) !== target ||
              (yield* fs.lstat(selected)).type !== 'SymbolicLink' ||
              (yield* fs.readLink(selected)) !== target
            )
              return yield* hold()
            const targetInfo = yield* fs.lstat(target)
            if (
              (targetInfo.mode & 0o222) !== 0 ||
              targetInfo.type !== (name === 'executable' ? 'File' : 'Directory') ||
              (name === 'executable' && (targetInfo.mode & 0o111) === 0)
            )
              return yield* hold()
            record(['link', entry, target])
          } else return yield* hold()
        }
      })
    const references: string[] = []
    yield* realDirectory({ directory: join(profile, 'tools'), immutable: true })
    yield* realDirectory({ directory: join(cell, 'tools') })
    for (const platform of (yield* fs.readDirectory(join(profile, 'tools'))).toSorted()) {
      yield* realDirectory({ directory: join(profile, 'tools', platform), immutable: true })
      yield* realDirectory({ directory: join(cell, 'tools', platform) })
      for (const tool of (yield* fs.readDirectory(join(profile, 'tools', platform))).toSorted()) {
        yield* realDirectory({ directory: join(profile, 'tools', platform, tool), immutable: true })
        yield* realDirectory({ directory: join(cell, 'tools', platform, tool) })
        for (const digest of (yield* fs.readDirectory(
          join(profile, 'tools', platform, tool),
        )).toSorted()) {
          const relative = `tools/${platform}/${tool}/${digest}`
          if (
            /^tools\/[a-z0-9][a-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9._+-]*\/[0-9a-f]{64}$/u.test(
              relative,
            ) === false ||
            createHash('sha256')
              .update(
                yield* realFile({
                  file: join(profile, relative, 'manifest.json'),
                  immutable: true,
                }),
              )
              .digest('hex') !== digest
          )
            return yield* hold()
          references.push(relative)
          yield* compareTool(relative)
        }
      }
    }
    const metadata = join(path, '.buck2/capability-references')
    yield* realDirectory({ directory: metadata })
    const selectedReferences = yield* realFile({ file: join(metadata, `${generation}.json`) })
    const decoded = yield* decodeCapabilityReferences(
      Buffer.from(selectedReferences).toString('utf8'),
    ).pipe(Effect.mapError(hold))
    // Publication canonicalizes complete reference strings, not individual path
    // components: "buck2-fingerprint/..." sorts before "buck2/...".
    const expectedReferences = references.toSorted()
    if (
      decoded.length !== expectedReferences.length ||
      decoded.some((reference, index) => reference !== expectedReferences[index]) === true
    )
      return yield* hold()
    record(['references', ...decoded])
    // Recheck the watched selector: a concurrent publication cannot qualify the
    // tool set of one generation with the definitions of another.
    if (
      Buffer.from(yield* realFile({ file: join(cell, 'defs.bzl') })).equals(Buffer.from(defs)) ===
        false ||
      (yield* fs.realPath(root)) !== profile
    )
      return yield* hold()
    return hash.digest('hex')
  }).pipe(Effect.mapError(hold))

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

/** Read-only identity after normal Buck preparation. The watched mutable cell
 * must exactly project the selected canonical immutable Nix profile.
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
    if (provider.type !== 'File' || (provider.mode & 0o111) === 0 || (provider.mode & 0o222) !== 0)
      return yield* hold()
    const capabilities = yield* inspectBuckCapabilities(path)
    const hash = createHash('sha256')
    hash.update('mr-pool-buck-root-v2\0')
    hash.update(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([
        commit,
        process.platform,
        process.arch,
        config,
        capabilities,
      ]).pipe(Effect.mapError(hold)),
    )
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
