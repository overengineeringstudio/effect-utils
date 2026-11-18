import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'

import { Effect, Schema, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as ChildProcess from 'effect/process/ChildProcess'

import * as Git from '../core/git.ts'
import { PoolError } from './store-pool-state.ts'

export const runPoolCommand = (cwd: string, command: string, args: ReadonlyArray<string>) =>
  Effect.scoped(Effect.gen(function* () {
    const child = yield* ChildProcess.make(command, args, {
      cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit',
    })
    const chunks = yield* Stream.runCollect(child.stdout)
    const code = yield* child.exitCode
    if (code !== 0) return yield* new PoolError({ message: `${command} exited ${code}` })
    return Buffer.concat(Array.from(chunks)).toString('utf8').trim()
  }))

export const preparePoolInstall = (path: string) => Effect.scoped(Effect.gen(function* () {
  const child = yield* ChildProcess.make('devenv', ['tasks', 'run', 'pnpm:install'], {
    cwd: path, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
  })
  const code = yield* child.exitCode
  if (code !== 0) return yield* new PoolError({ message: `Canonical pnpm:install exited ${code}` })
}))

/** The root-owned pnpm doctor validates the complete projection and install receipts.
 * Pool code adds source/platform and actual GVS path binding, not a second graph validator.
 */
export const poolInstallIdentity = (path: string, commit: string) => Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  if ((yield* Git.resolveRef({ repoPath: path, ref: 'HEAD' })) !== commit)
    return yield* new PoolError({ message: 'Pool source commit changed' })
  const output = yield* runPoolCommand(path, 'devenv', ['tasks', 'run', 'pnpm:doctor', '--no-tui'])
  const reports = output.split('\n').map((line) => line.trim())
    .filter((line) => line.startsWith('{"phase":"doctor"'))
  if (reports.length !== 1)
    return yield* new PoolError({ message: 'Expected exactly one root-owned pnpm readiness report' })
  const proof = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
    phase: Schema.Literal('doctor'), version: Schema.Literal(1), root: Schema.String,
    decision: Schema.String, installHash: Schema.String, projectionHash: Schema.String,
    storageState: Schema.String, pnpm: Schema.String, node: Schema.String,
  })))(reports[0])
  if (proof.decision !== 'healthy' || proof.installHash === '' || proof.projectionHash === '' ||
      (yield* fs.realPath(proof.root)) !== (yield* fs.realPath(path)))
    return yield* new PoolError({ message: 'Root-owned pnpm readiness evidence is stale or unhealthy' })
  const hash = createHash('sha256')
  hash.update(JSON.stringify([1, commit, process.platform, process.arch]))
  hash.update(JSON.stringify(proof))
  hash.update(yield* fs.realPath(proof.pnpm))
  hash.update(yield* fs.realPath(proof.node))
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'megarepo.lock',
    'pnpm-install-contract.json', 'devenv.lock', 'flake.lock', 'devenv.nix', 'devenv.yaml', 'node_modules/.modules.yaml']) {
    const file = `${path}/${name}`
    hash.update(name)
    if (yield* fs.exists(file)) hash.update(yield* fs.readFile(file))
    else if (['pnpm-lock.yaml', 'node_modules/.modules.yaml'].includes(name))
      return yield* new PoolError({ message: `Missing installed input ${name}` })
    else hash.update('absent')
  }
  // Pinned pnpm 12 writes JSON into .modules.yaml (shared pnpm-gvs.test.sh).
  const modules = yield* fs.readFileString(`${path}/node_modules/.modules.yaml`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({
      storeDir: Schema.String, virtualStoreDir: Schema.String,
    })))),
  )
  if (!isAbsolute(modules.storeDir))
    return yield* new PoolError({ message: 'Installed store path must be absolute' })
  const realStore = yield* fs.realPath(modules.storeDir)
  const realVirtual = yield* fs.realPath(resolve(path, 'node_modules', modules.virtualStoreDir))
  const realModules = yield* fs.realPath(`${path}/node_modules`)
  if (realVirtual !== `${realStore}/links` || realStore.startsWith(`${path}/`))
    return yield* new PoolError({ message: 'Installed root is not a shared GVS projection' })
  hash.update(JSON.stringify([realStore, realVirtual, realModules]))
  hash.update(JSON.stringify(process.versions))
  hash.update(yield* runPoolCommand(path, 'uname', ['-srmp']))
  if (process.platform === 'linux')
    hash.update(yield* runPoolCommand(path, 'getconf', ['GNU_LIBC_VERSION']))
  return hash.digest('hex')
})

/** Logical bytes are charged conservatively; no claim of physical/exclusive reclamation. */
export const poolBytes = (path: string) => Effect.gen(function* () {
  const output = yield* runPoolCommand(path, 'du', ['-sk', '.'])
  const kib = Number(output.split(/\s+/u)[0])
  if (!Number.isSafeInteger(kib) || kib < 0)
    return yield* new PoolError({ message: 'Cannot account pool bytes' })
  return kib * 1024
})
