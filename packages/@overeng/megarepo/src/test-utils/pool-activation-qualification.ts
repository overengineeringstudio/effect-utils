import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Console, Effect, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { EffectPath } from '@overeng/effect-path'

import * as Git from '../core/git.ts'
import { deletionLeasePath, persistentDeletionLeaseOwnerAlive } from '../store/store-deletion-lease.ts'
import { collectWorkspaceLivePathsStrict, readWorkspaceRegistration } from '../store/store-liveness.ts'
import { poolInstallIdentity, runPoolCommand } from '../store/store-pool-install.ts'
import { PoolError, readPoolState } from '../store/store-pool-state.ts'
import { Store, StoreLayer } from '../store/store.ts'

/** Explicit previously qualified inputs, never environment overrides or qualification grants. */
const Config = Schema.Struct({
  storeBase: Schema.String, slotId: Schema.String, identity: Schema.String, commit: Schema.String,
  callerRoot: Schema.String, callerBare: Schema.String, callerCommit: Schema.String,
  callerState: Schema.String, callerDotfile: Schema.String,
  slotState: Schema.String, slotDotfile: Schema.String,
  mr: Schema.String, devenv: Schema.String, bash: Schema.String, node: Schema.String,
  evidenceRoot: Schema.String,
})
const Context = Schema.Struct({
  cwd: Schema.String, devenvRoot: Schema.NullOr(Schema.String),
  devenvState: Schema.NullOr(Schema.String), devenvDotfile: Schema.NullOr(Schema.String),
})
const Doctor = Schema.Struct({
  phase: Schema.Literal('doctor'), version: Schema.Literal(1), root: Schema.String,
  decision: Schema.String, installHash: Schema.String, projectionHash: Schema.String,
  storageState: Schema.String, pnpm: Schema.String, node: Schema.String, runtimeContext: Context,
})
const check = (condition: boolean, message: string): Effect.Effect<void, PoolError> =>
  condition === true ? Effect.void : Effect.fail(new PoolError({ message }))

// Metadata only, no followed links, copied file bytes, access times or exclusions.
const snapshot = String.raw`
const fs = require('node:fs'), crypto = require('node:crypto')
const hash = crypto.createHash('sha256')
const visit = (path) => {
  const st = fs.lstatSync(path, { bigint: true })
  hash.update(JSON.stringify([path, ...[st.dev, st.ino, st.mode, st.uid, st.gid,
    st.nlink, st.size, st.mtimeNs, st.ctimeNs].map(String)]))
  if (st.isSymbolicLink()) hash.update(fs.readlinkSync(path))
  if (st.isDirectory()) for (const name of fs.readdirSync(path).sort()) visit(path + '/' + name)
}
for (const root of process.argv.slice(1)) visit(root)
console.log(hash.digest('hex'))
`
const inner = [
  'umask 077',
  '"$1" -e "$2" "$3" "$4" > "$5"',
  '"$6" store pool claim --identity "$7" --owner activation-qualification --execution-only -- "$8" "$9" "${10}" inside-claim "${11}"',
  '"$1" -e "$2" "$3" "$4" > "${12}"',
].join('\n')

const [configFile, mode, insideEvidence] = process.argv.slice(2)
const program = Effect.gen(function* () {
  yield* check(process.platform === 'linux', 'This fixture requires a permitted Linux qualification lane')
  const fs = yield* FileSystem.FileSystem
  const store = yield* Store
  if (configFile === undefined || (mode !== undefined && mode !== 'inside-claim'))
    return yield* new PoolError({ message: 'Expected an explicit private qualification config file' })
  yield* check(isAbsolute(configFile) && (yield* fs.realPath(configFile)) === configFile,
    'Qualification config must have one canonical absolute path')
  const config = yield* Schema.decodeEffect(Schema.fromJsonString(Config))(yield* fs.readFileString(configFile))
  yield* check(store.basePath.replace(/\/$/u, '') === config.storeBase, 'Normal store binding differs')
  for (const path of [config.callerRoot, config.callerBare, config.evidenceRoot])
    yield* check(isAbsolute(path) && (yield* fs.realPath(path)) === path, 'Noncanonical fixture input')
  for (const path of [config.mr, config.devenv, config.bash, config.node, process.execPath])
    yield* check(isAbsolute(path) && (yield* fs.realPath(path)).startsWith('/nix/store/'), 'Undeclared runtime provider')
  const evidenceInfo = yield* Effect.tryPromise(() => lstat(config.evidenceRoot))
  yield* check(evidenceInfo.isDirectory() && (evidenceInfo.mode & 0o777) === 0o700 &&
    evidenceInfo.uid === process.getuid?.(), 'Evidence root must be owned mode 0700')
  const slot = (yield* readPoolState({ base: store.basePath })).slots.find((item) => item.id === config.slotId)
  if (slot === undefined) return yield* new PoolError({ message: 'Expected existing qualified slot' })
  yield* check(slot.identity === config.identity && slot.commit === config.commit, 'Slot source/install binding differs')
  yield* check(slot.path !== config.callerRoot && (yield* fs.realPath(slot.path)) === slot.path,
    'Caller and slot must be distinct canonical physical roots')
  for (const root of [slot.path, config.callerRoot])
    yield* check(config.evidenceRoot !== root && config.evidenceRoot.startsWith(`${root}/`) === false,
      'Evidence must be outside both worktree roots')
  const lease = { ownerPath: slot.path, token: slot.barrierToken,
    leasePath: deletionLeasePath({ storeBasePath: store.basePath, ownerPath: slot.path }) }
  const write = (path: string, value: string) => fs.writeFileString(path, value, { flag: 'wx', mode: 0o600 })
  if (mode === 'inside-claim') {
    if (insideEvidence === undefined) return yield* new PoolError({ message: 'Missing owned evidence directory' })
    yield* check((yield* fs.realPath(insideEvidence)).startsWith(`${config.evidenceRoot}/`), 'Evidence binding differs')
    yield* check(slot.state === 'leased' && process.env.MR_POOL_SLOT === slot.id &&
      Number(process.env.MR_POOL_GENERATION) === slot.generation &&
      slot.activity?.claimed?.provider.pid === process.ppid, 'Not inside the actual claimed provider child')
    const inherited = { cwd: process.cwd(), devenvRoot: process.env.DEVENV_ROOT ?? null,
      devenvState: process.env.DEVENV_STATE ?? null, devenvDotfile: process.env.DEVENV_DOTFILE ?? null }
    yield* check(inherited.cwd === slot.path && inherited.devenvRoot === config.callerRoot &&
      inherited.devenvState === config.callerState && inherited.devenvDotfile === config.callerDotfile,
      'Actual foreign activation context was not inherited')
    yield* write(`${insideEvidence}/inherited.json`, JSON.stringify(inherited))
    yield* check(yield* persistentDeletionLeaseOwnerAlive(lease), 'Live exact persistent barrier not proven')
    const runner = Bun.which('devenv')
    yield* check(runner !== null && (yield* fs.realPath(runner)) === (yield* fs.realPath(config.devenv)),
      'Normal task PATH does not bind the declared runner')
    yield* runPoolCommand({ cwd: slot.path, command: config.devenv,
      args: ['tasks', 'run', '--mode', 'single', 'pnpm:doctor', '--no-tui'],
      env: { PNPM_DOCTOR_OUTPUT_FILE: `${insideEvidence}/doctor.json` } })
    const identity = yield* poolInstallIdentity({ path: slot.path, commit: slot.commit, base: store.basePath })
    yield* check(identity === slot.identity, 'Actual installed identity changed')
    yield* write(`${insideEvidence}/identity`, identity)
    const workspaceRoot = EffectPath.unsafe.absoluteDir(`${slot.path}/`)
    const registered = yield* readWorkspaceRegistration({ store, workspaceRoot })
    const actual = yield* collectWorkspaceLivePathsStrict({ store, workspaceRoot })
    yield* check(actual.size > 0 && JSON.stringify([...actual].sort()) ===
      JSON.stringify([...registered.livePaths].sort()), 'Actual member pins and exact registration differ')
    yield* write(`${insideEvidence}/registration.json`, JSON.stringify(registered))
    yield* check(yield* persistentDeletionLeaseOwnerAlive(lease), 'Barrier changed during actual task')
    return
  }
  yield* check(slot.state === 'ready' && slot.executionRoot?.authored === false,
    'Expected unclaimed, un-authored ready execution slot')
  yield* check((yield* Git.getCurrentCommit(config.callerRoot)) === config.callerCommit, 'Caller source differs')
  const caller = yield* Git.readLinkedWorktreeAdmission({ owner: config.callerRoot, barePath: config.callerBare })
  const callerNative = (yield* Git.listWorktrees(config.callerBare)).find((item) => item.path === config.callerRoot)
  yield* check(callerNative !== undefined && Option.isSome(callerNative.branch), 'Caller must be a canonical branch root')
  const evidence = yield* fs.makeTempDirectory({ directory: config.evidenceRoot, prefix: 'activation-' })
  // Private outer stdio adapter; the inner canonical activation/task argv and inherited root env are unchanged.
  yield* runPoolCommand({ cwd: config.callerRoot, command: config.bash,
    args: ['-euc', 'umask 077; log="$1"; shift; exec "$@" > "$log" 2>&1', 'activation-evidence',
      `${evidence}/full.log`, config.devenv, 'shell', '--', config.bash, '-euc', inner, 'activation-fixture',
      config.node, snapshot, config.callerRoot, caller.gitdir, `${evidence}/caller-before`,
      config.mr, config.identity, process.execPath, fileURLToPath(import.meta.url), configFile, evidence,
      `${evidence}/caller-after`] })
  const before = yield* fs.readFileString(`${evidence}/caller-before`)
  yield* check(before === (yield* fs.readFileString(`${evidence}/caller-after`)),
    'Caller root/admin changed during claimed execution; retained evidence, no exclusions')
  const proof = yield* Schema.decodeEffect(Schema.fromJsonString(Doctor))(yield* fs.readFileString(`${evidence}/doctor.json`))
  yield* check(proof.decision === 'healthy' && proof.root === slot.path && proof.runtimeContext.cwd === slot.path &&
    proof.runtimeContext.devenvRoot === slot.path && proof.runtimeContext.devenvState === config.slotState &&
    proof.runtimeContext.devenvDotfile === config.slotDotfile, 'Actual task root/state/dotfile binding differs')
  yield* check((yield* fs.readFileString(`${evidence}/identity`)) === config.identity, 'Actual identity receipt differs')
  const completed = (yield* readPoolState({ base: store.basePath })).slots.find((item) => item.id === slot.id)
  yield* check(completed?.state === 'completed' && completed.generation === slot.generation + 1 &&
    completed.chargeKnown === false && completed.executionRoot?.authored === false, 'Exact claim did not complete safely')
  const native = (yield* Git.listWorktrees(slot.bare)).find((item) => item.path === slot.path)
  yield* check(native !== undefined && Option.isNone(native.symbolicRef) && native.head === config.commit &&
    Option.getOrUndefined(native.lockReason) === `mr-pool:${slot.id}:preparing`, 'Native detached lock/source differs')
  yield* check(yield* fs.exists(lease.leasePath), 'Persistent barrier disappeared after completion')
  yield* write(`${evidence}/receipt.json`, JSON.stringify({
    slotId: slot.id, generation: slot.generation + 1, commit: slot.commit, identity: config.identity,
    callerCommit: config.callerCommit, callerMetadataDigest: before.trim(), doctor: proof,
    observedAtUtc: new Date().toISOString(), establishesHolderQualification: false, authorizesRemoval: false,
  }))
  yield* Console.log('Actual activation root binding passed; private evidence retained; slot remains completed')
})

program.pipe(Effect.provide(StoreLayer), Effect.provide(NodeServices.layer), NodeRuntime.runMain)
