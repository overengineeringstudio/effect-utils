import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'

import { Effect, Schema, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as ChildProcess from 'effect/process/ChildProcess'

import { type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { inspectPoolHeadHistory, type PoolHeadHistory } from './store-pool-head-history.ts'
import { PoolError } from './store-pool-state.ts'

/** Run a declared tool with its real exit status and captured stdout. */
export const runPoolCommand = ({
  cwd,
  command,
  args,
  env,
}: {
  cwd: string
  command: string
  args: ReadonlyArray<string>
  env?: Record<string, string>
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make(command, args, {
        cwd,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'inherit',
        ...(env === undefined ? {} : { env }),
      })
      const chunks = yield* Stream.runCollect(child.stdout)
      const code = yield* child.exitCode
      if (code !== 0) return yield* new PoolError({ message: `${command} exited ${code}` })
      return Buffer.concat(Array.from(chunks)).toString('utf8').trim()
    }),
  )

/** Execute root-owned tasks without buffering build output or overriding activation. */
export const runPoolTasks = ({ path, tasks }: { path: string; tasks: ReadonlyArray<string> }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make('devenv', ['tasks', 'run', ...tasks], {
        cwd: path,
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      })
      const code = yield* child.exitCode
      if (code !== 0) return yield* new PoolError({ message: `Canonical tasks exited ${code}` })
    }),
  )

/** Actual normal-doctor binding, not provider qualification or live-use authority. */
export interface PoolInstallBinding {
  readonly identity: string
  readonly backingPaths: ReadonlyArray<string>
  readonly storeCacheRoot: string
  readonly pnpmProvider: string
  readonly sourceHistory: PoolHeadHistory
}

/** The root-owned pnpm doctor validates the complete projection and install receipts.
 * Pool code adds source/platform and actual GVS path binding, not a second graph validator.
 */
export const inspectPoolInstall = ({
  path,
  commit,
  base,
}: {
  path: string
  commit: string
  base: AbsoluteDirPath
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      if ((yield* Git.resolveRef({ repoPath: path, ref: 'HEAD' })) !== commit)
        return yield* new PoolError({ message: 'Pool source commit changed' })
      const reportRoot = `${base}/.state/pool-reports`
      yield* fs.makeDirectory(reportRoot, { recursive: true })
      const reportDirectory = yield* fs.makeTempDirectoryScoped({
        directory: reportRoot,
        prefix: 'doctor-',
      })
      const report = `${reportDirectory}/readiness.json`
      yield* runPoolCommand({
        cwd: path,
        command: 'devenv',
        args: ['tasks', 'run', '--mode', 'single', 'pnpm:doctor', '--no-tui'],
        env: { PNPM_DOCTOR_OUTPUT_FILE: report },
      })
      const proof = yield* Schema.decodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            phase: Schema.Literal('doctor'),
            version: Schema.Literal(1),
            root: Schema.String,
            decision: Schema.Literal('healthy'),
            installHash: Schema.String,
            projectionHash: Schema.String,
            storageState: Schema.String,
            storeCacheRoot: Schema.String,
            pnpm: Schema.String,
            node: Schema.String,
          }),
        ),
      )(yield* fs.readFileString(report))
      if (
        proof.installHash === '' ||
        proof.projectionHash === '' ||
        isAbsolute(proof.storeCacheRoot) === false ||
        (yield* fs.realPath(proof.storeCacheRoot)) !== proof.storeCacheRoot ||
        (yield* fs.realPath(proof.root)) !== (yield* fs.realPath(path))
      )
        return yield* new PoolError({
          message: 'Root-owned pnpm readiness evidence is stale or unhealthy',
        })
      const storeCacheRoot = proof.storeCacheRoot
      const pnpmProvider = yield* fs.realPath(proof.pnpm)
      const hash = createHash('sha256')
      hash.update(
        yield* Schema.encodeEffect(
          Schema.fromJsonString(
            Schema.Tuple([Schema.Literal(1), Schema.String, Schema.String, Schema.String]),
          ),
        )([1, commit, process.platform, process.arch]),
      )
      hash.update(
        yield* Schema.encodeEffect(
          Schema.fromJsonString(
            Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite])),
          ),
        )(proof),
      )
      hash.update(pnpmProvider)
      hash.update(yield* fs.realPath(proof.node))
      for (const name of [
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'package.json',
        'megarepo.lock',
        'pnpm-install-contract.json',
        'devenv.lock',
        'flake.lock',
        'devenv.nix',
        'devenv.yaml',
        'node_modules/.modules.yaml',
      ]) {
        const file = `${path}/${name}`
        hash.update(name)
        if ((yield* fs.exists(file)) === true) hash.update(yield* fs.readFile(file))
        else if (['pnpm-lock.yaml', 'node_modules/.modules.yaml'].includes(name) === true)
          return yield* new PoolError({ message: `Missing installed input ${name}` })
        else hash.update('absent')
      }
      // Pinned pnpm 12 writes JSON into .modules.yaml (shared pnpm-gvs.test.sh).
      const modules = yield* fs.readFileString(`${path}/node_modules/.modules.yaml`).pipe(
        Effect.flatMap(
          Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                storeDir: Schema.String,
                virtualStoreDir: Schema.String,
              }),
            ),
          ),
        ),
      )
      if (isAbsolute(modules.storeDir) === false)
        return yield* new PoolError({ message: 'Installed store path must be absolute' })
      const realStore = yield* fs.realPath(modules.storeDir)
      const realVirtual = yield* fs.realPath(resolve(path, 'node_modules', modules.virtualStoreDir))
      const realModules = yield* fs.realPath(`${path}/node_modules`)
      if (
        realVirtual !== `${realStore}/links` ||
        realStore.startsWith(`${path}/`) === true ||
        realStore === storeCacheRoot ||
        realStore.startsWith(join(storeCacheRoot, '/')) === false
      )
        return yield* new PoolError({
          message: 'Installed root is not bound to its configured shared GVS',
        })
      hash.update(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))([
          realStore,
          realVirtual,
          realModules,
        ]),
      )
      hash.update(
        yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Record(Schema.String, Schema.UndefinedOr(Schema.String))),
        )(process.versions),
      )
      hash.update(yield* runPoolCommand({ cwd: path, command: 'uname', args: ['-srmp'] }))
      if (process.platform === 'linux') {
        const getconf = process.env.MR_GETCONF_BIN
        if (getconf === undefined || isAbsolute(getconf) === false)
          return yield* new PoolError({
            message: 'MR_GETCONF_BIN must declare an absolute provider',
          })
        hash.update(yield* fs.realPath(getconf))
        hash.update(
          yield* runPoolCommand({ cwd: path, command: getconf, args: ['GNU_LIBC_VERSION'] }),
        )
      }
      const sourceHistory = yield* inspectPoolHeadHistory({
        path,
        admin: yield* Git.getAbsoluteGitDir(path),
        commit,
      })
      hash.update('pool-head-history-v1\0')
      hash.update(
        yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String, Schema.Finite])),
        )([sourceHistory.commit, sourceHistory.digest, sourceHistory.byteLength]),
      )
      const binding: PoolInstallBinding = {
        identity: hash.digest('hex'),
        backingPaths: [realStore, realVirtual, realModules],
        storeCacheRoot,
        pnpmProvider,
        sourceHistory,
      }
      return binding
    }),
  )

/** GNU-du logical or allocated bytes; neither measures exclusive physical reclamation. */
export const poolBytes = ({ path, kind }: { path: string; kind: 'logical' | 'allocated' }) =>
  Effect.gen(function* () {
    const output = yield* runPoolCommand({
      cwd: path,
      command: 'du',
      args: [
        '--block-size=1',
        '--summarize',
        ...(kind === 'logical' ? ['--apparent-size'] : []),
        '--',
        '.',
      ],
    })
    const match = /^([0-9]+)\s/u.exec(output)
    const bytes = match === null ? Number.NaN : Number(match[1])
    if (Number.isSafeInteger(bytes) === false || bytes < 0)
      return yield* new PoolError({ message: 'Cannot account pool bytes' })
    return bytes
  })
