import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import { Effect, Schema, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as ChildProcess from 'effect/process/ChildProcess'

import { type AbsoluteDirPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
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

/** Prepare through the root-owned install task with inherited task output. */
export const preparePoolInstall = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const child = yield* ChildProcess.make('devenv', ['tasks', 'run', 'pnpm:install'], {
        cwd: path,
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      })
      const code = yield* child.exitCode
      if (code !== 0)
        return yield* new PoolError({ message: `Canonical pnpm:install exited ${code}` })
    }),
  )

/** The root-owned pnpm doctor validates the complete projection and install receipts.
 * Pool code adds source/platform and actual GVS path binding, not a second graph validator.
 */
export const poolInstallIdentity = ({
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
            decision: Schema.String,
            installHash: Schema.String,
            projectionHash: Schema.String,
            storageState: Schema.String,
            pnpm: Schema.String,
            node: Schema.String,
          }),
        ),
      )(yield* fs.readFileString(report))
      if (
        proof.decision !== 'healthy' ||
        proof.installHash === '' ||
        proof.projectionHash === '' ||
        (yield* fs.realPath(proof.root)) !== (yield* fs.realPath(path))
      )
        return yield* new PoolError({
          message: 'Root-owned pnpm readiness evidence is stale or unhealthy',
        })
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
      hash.update(yield* fs.realPath(proof.pnpm))
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
      if (realVirtual !== `${realStore}/links` || realStore.startsWith(`${path}/`) === true)
        return yield* new PoolError({ message: 'Installed root is not a shared GVS projection' })
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
      return hash.digest('hex')
    }),
  )

/** Logical bytes are charged conservatively; no claim of physical/exclusive reclamation. */
export const poolBytes = (path: string) =>
  Effect.gen(function* () {
    const output = yield* runPoolCommand({
      cwd: path,
      command: 'du',
      args: ['--apparent-size', '-sk', '.'],
    })
    const kib = Number(output.split(/\s+/u)[0])
    if (Number.isSafeInteger(kib) === false || kib < 0)
      return yield* new PoolError({ message: 'Cannot account pool bytes' })
    return kib * 1024
  })
