import { dirname, join, resolve } from 'node:path'

import { Effect, Option, Schema, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import {
  BuckDaemonStatus,
  findWorktreeBuckDaemons,
  hasWorktreeBuckClients,
  newestBuckLogWriteMs,
  runBuck2,
  stopWorktreeBuckDaemons,
  type WorktreeBuckDaemon,
} from './store-buck-daemons.ts'
import { buckDurationMs, loadStoreBuckMaintainConfig } from './store-buck-maintain-config.ts'
import { decideBuckOut, decideMaintainGate, isInBlackout } from './store-buck-maintain-policy.ts'
import {
  acquireDeletionLease,
  deletionLeasePath,
  releaseDeletionLease,
} from './store-deletion-lease.ts'
import { loadStoreGcConfig } from './store-gc-config.ts'
import { isInsideWorktree, parseProcStat, readProcessReferences } from './store-inuse.ts'
import {
  isWorkspaceActive,
  readBudgetWorkspaceActivity,
  readBudgetWorktreeInUse,
} from './store-workspace-activity.ts'
import { Store, StoreLayer } from './store.ts'

/** Ownership evidence retained in maintenance receipts, including unknown process owners. */
export interface BuckMaintainOwnerEvidence {
  readonly source: 'process' | 'st3-seat'
  readonly owner: string | null
  readonly pid?: number
  readonly workspace?: string
}

/** Stable outcome for one discovered worktree. */
export interface BuckMaintainEntry {
  readonly worktree: string
  readonly action: 'none' | 'clean-stale' | 'full-clean' | 'stop-daemon'
  readonly reason: string
  readonly bytesBefore: number | null
  readonly bytesAfter: number | null
  readonly daemon: ReadonlyArray<{ readonly pid: number; readonly isolation: string }>
  readonly ownerEvidence: ReadonlyArray<BuckMaintainOwnerEvidence>
}

/** Versioned receipt for both report-only and acting maintenance runs. */
export interface BuckMaintainReceipt {
  readonly version: 1
  readonly dryRun: boolean
  readonly entries: ReadonlyArray<BuckMaintainEntry>
  readonly summary: {
    readonly worktrees: number
    readonly actions: number
    readonly skipped: number
  }
}

const command = Effect.fn('store.buckMaintain.command')(function* (
  binary: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner
  return yield* Effect.gen(function* () {
    const handle = yield* spawner.spawn(ChildProcess.make(binary, args, { cwd }))
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(handle.stdout)),
        Stream.mkString(Stream.decodeText(handle.stderr)),
        handle.exitCode,
      ],
      { concurrency: 3 },
    )
    return { stdout, stderr, exitCode }
  }).pipe(Effect.scoped, Effect.timeout('2 minutes'), Effect.option)
})

/** Discover nested slash refs, never descending into a worktree or an archive. */
export const discoverBuckMaintainWorktrees = Effect.fn('store.discoverBuckMaintainWorktrees')(
  function* (roots: ReadonlyArray<string>) {
    const fs = yield* FileSystem.FileSystem
    const found = new Set<string>()
    const seen = new Set<string>()
    const visit = (path: string): Effect.Effect<void, never, FileSystem.FileSystem> =>
      Effect.gen(function* () {
        const canonical = yield* fs.realPath(path).pipe(Effect.option)
        if (Option.isNone(canonical) === true || seen.has(canonical.value) === true) return
        seen.add(canonical.value)
        if (canonical.value.split('/').includes('.archive') === true) return
        const gitRoot = yield* fs.exists(join(canonical.value, '.git')).pipe(Effect.option)
        if (Option.isNone(gitRoot) === true) return
        if (gitRoot.value === true) {
          found.add(canonical.value)
          return
        }
        const children = yield* fs
          .readDirectory(canonical.value)
          .pipe(Effect.orElseSucceed(() => []))
        for (const child of children.toSorted()) {
          if (child.startsWith('.') === true) continue
          const next = join(canonical.value, child)
          const info = yield* fs.stat(next).pipe(Effect.option)
          if (Option.isSome(info) === true && info.value.type === 'Directory') yield* visit(next)
        }
      })
    for (const root of roots) yield* visit(root)
    return [...found].toSorted()
  },
)

const allocatedBytes = Effect.fn('store.buckMaintain.allocatedBytes')(function* (worktree: string) {
  const fs = yield* FileSystem.FileSystem
  if ((yield* fs.exists(join(worktree, 'buck-out'))) === false) return 0
  const result = yield* command('du', ['--summarize', '--block-size=1', '--', 'buck-out'], worktree)
  if (Option.isNone(result) === true || result.value.exitCode !== 0) return undefined
  const value = Number(/^([0-9]+)\s/u.exec(result.value.stdout)?.[1])
  return Number.isSafeInteger(value) === true && value >= 0 ? value : undefined
})

const gitEvidence = Effect.fn('store.buckMaintain.gitEvidence')(function* (worktree: string) {
  const fs = yield* FileSystem.FileSystem
  const gitFile = yield* fs.readFileString(join(worktree, '.git')).pipe(Effect.option)
  const gitDir =
    Option.isSome(gitFile) === true && gitFile.value.startsWith('gitdir: ') === true
      ? resolve(worktree, gitFile.value.slice('gitdir: '.length).trim())
      : join(worktree, '.git')
  const info = yield* fs.stat(gitDir).pipe(Effect.option)
  if (Option.isNone(info) === true || info.value.type !== 'Directory')
    return { locked: undefined, lastActivityMs: undefined }
  let lastActivityMs: number | undefined
  let complete = true
  for (const name of ['HEAD', 'index', 'logs/HEAD']) {
    const path = join(gitDir, name)
    if ((yield* fs.exists(path)) === false) continue
    const stat = yield* fs.stat(path).pipe(Effect.option)
    const mtime =
      Option.isSome(stat) === true ? Option.getOrUndefined(stat.value.mtime)?.getTime() : undefined
    if (mtime === undefined) complete = false
    else lastActivityMs = Math.max(lastActivityMs ?? 0, mtime)
  }
  return {
    locked: yield* fs.exists(join(gitDir, 'locked')),
    lastActivityMs: complete === true ? lastActivityMs : undefined,
  }
})

/** Resolve the installed admission launcher to its native sibling for daemon-free cleanup. */
const nativeBinary = Effect.fn('store.buckMaintain.nativeBinary')(function* (
  daemons: ReadonlyArray<WorktreeBuckDaemon>,
) {
  const fs = yield* FileSystem.FileSystem
  if (daemons[0] !== undefined)
    return yield* fs.readLink(`/proc/${daemons[0].daemon.pid}/exe`).pipe(Effect.option)
  for (const directory of (process.env['PATH'] ?? '').split(':')) {
    const candidate = join(directory, 'buck2')
    if ((yield* fs.exists(candidate)) === false) continue
    const real = yield* fs.realPath(candidate).pipe(Effect.option)
    if (Option.isNone(real) === true) continue
    const native = join(dirname(dirname(real.value)), 'libexec', 'buck2')
    if ((yield* fs.exists(native)) === true) return Option.some(native)
    // A libexec executable is already native. Never run an unknown bin launcher.
    if (dirname(real.value).endsWith('/libexec') === true) return Option.some(real.value)
  }
  return Option.none<string>()
})

/** Owner evidence is process-lifetime checked; absent/unreadable ST_AGENT stays unknown. */
const processOwners = Effect.fn('store.buckMaintain.processOwners')(function* (
  worktree: string,
  daemons: ReadonlyArray<WorktreeBuckDaemon>,
) {
  const fs = yield* FileSystem.FileSystem
  const scan = yield* readProcessReferences({ fs, selfPid: process.pid, scope: 'all-uids' })
  const references = scan._tag === 'complete' ? scan.references : []
  const pids = new Set(
    references
      .filter((reference) =>
        isInsideWorktree({ candidate: reference.path, worktreePath: worktree }),
      )
      .map((reference) => reference.pid),
  )
  for (const entry of daemons) pids.add(entry.daemon.pid)
  const evidence: BuckMaintainOwnerEvidence[] = []
  for (const pid of pids) {
    const before = yield* fs.readFileString(`/proc/${pid}/stat`).pipe(Effect.option)
    const environ = yield* fs.readFileString(`/proc/${pid}/environ`).pipe(Effect.option)
    const after = yield* fs.readFileString(`/proc/${pid}/stat`).pipe(Effect.option)
    const start =
      Option.isSome(before) === true ? parseProcStat(before.value)?.startTime : undefined
    const end = Option.isSome(after) === true ? parseProcStat(after.value)?.startTime : undefined
    const owner =
      start !== undefined && start === end && Option.isSome(environ) === true
        ? environ.value
            .split('\0')
            .find((value) => value.startsWith('ST_AGENT=') === true)
            ?.slice('ST_AGENT='.length)
        : undefined
    evidence.push({
      source: 'process',
      owner: owner === undefined || owner === '' ? null : owner,
      pid,
    })
  }
  return evidence
})

/** Maintain scoped worktrees through native Buck commands, gated by ownership, activity and leases. */
export const runBuckMaintain = Effect.fn('store.runBuckMaintain')(function* ({
  configPath,
  dryRun,
}: {
  configPath: string | undefined
  dryRun: boolean
}) {
  const fs = yield* FileSystem.FileSystem
  const config = yield* loadStoreBuckMaintainConfig(
    configPath === undefined ? {} : { path: configPath },
  )
  const roots = config.worktreeRoots.map((root) =>
    resolve(configPath === undefined ? process.cwd() : dirname(resolve(configPath)), root),
  )
  const { basePath: storeBase } = yield* Store
  const activityConfig = (yield* loadStoreGcConfig({ storeBasePath: storeBase })).generatedArtifacts
  const currentAgent = process.env['ST_AGENT'] === '' ? undefined : process.env['ST_AGENT']
  const reportOnly = dryRun || (currentAgent === undefined && config.maintainOwners.length === 0)
  const blackout = isInBlackout({ now: Date.now(), blackout: config.blackout })
  const entries: BuckMaintainEntry[] = []
  for (const worktree of yield* discoverBuckMaintainWorktrees(roots)) {
    const daemons = yield* findWorktreeBuckDaemons({ worktreePath: worktree })
    const ignoredProcesses = daemons.flatMap((entry) => entry.processes)
    const ownerEvidence = yield* processOwners(worktree, daemons)
    const capture = Effect.fn('store.buckMaintain.capture')(function* () {
      const activity = yield* readBudgetWorkspaceActivity({
        fs,
        config: activityConfig,
        ignoredOwnProcesses: ignoredProcesses,
        ignoredManifestProcesses: ignoredProcesses,
      })
      const git = yield* gitEvidence(worktree)
      const holder = yield* readBudgetWorktreeInUse({
        worktreePath: worktree,
        activity,
        ignoredProcesses,
      })
      const seatEvidence: BuckMaintainOwnerEvidence[] = (activity?.ownerClaims ?? [])
        .filter(
          (claim) =>
            isInsideWorktree({ candidate: worktree, worktreePath: claim.workspace }) ||
            isInsideWorktree({ candidate: claim.workspace, worktreePath: worktree }),
        )
        .flatMap((claim) =>
          claim.agents.map((owner) => ({
            source: 'st3-seat' as const,
            owner,
            workspace: claim.workspace,
          })),
        )
      const evidence = [...(yield* processOwners(worktree, daemons)), ...seatEvidence]
      const owners =
        evidence.length === 0 || evidence.some((entry) => entry.owner === null) === true
          ? undefined
          : evidence.flatMap((entry) => (entry.owner === null ? [] : [entry.owner]))
      const reason = decideMaintainGate({
        blackout: isInBlackout({ now: Date.now(), blackout: config.blackout }),
        gitLocked: git.locked,
        liveHolder: holder._tag === 'unknown' ? undefined : holder._tag === 'in-use',
        activeClaim:
          activity === undefined
            ? undefined
            : isWorkspaceActive({ activity, canonicalWorktree: worktree }),
        owners,
        currentAgent,
        maintainOwners: config.maintainOwners,
        maintainUnowned: config.maintainUnowned,
        leaseHeld: false,
      })
      return { reason, git, evidence, activity }
    })
    const initial = blackout === true ? undefined : yield* capture()
    const bytes = blackout === true ? undefined : yield* allocatedBytes(worktree)
    const base = {
      worktree,
      bytesBefore: bytes ?? null,
      bytesAfter: bytes ?? null,
      daemon: daemons.map((entry) => ({
        pid: entry.daemon.pid,
        isolation: entry.daemon.isolation,
      })),
      ownerEvidence: initial?.evidence ?? ownerEvidence,
    }
    if (blackout === true || initial?.reason !== undefined) {
      entries.push({
        ...base,
        action: 'none',
        reason: blackout === true ? 'blackout' : (initial?.reason ?? 'active-claim'),
      })
      continue
    }
    if (bytes === undefined) {
      entries.push({ ...base, action: 'none', reason: 'size-unavailable' })
      continue
    }
    const binary = yield* nativeBinary(daemons)
    if (Option.isNone(binary) === true) {
      entries.push({ ...base, action: 'none', reason: 'native-binary-unavailable' })
      continue
    }
    const lease =
      reportOnly === true
        ? Option.none()
        : yield* acquireDeletionLease({
            storeBasePath: storeBase,
            ownerPath: worktree,
            now: Date.now(),
          }).pipe(Effect.option)
    if (
      (reportOnly === true &&
        (yield* fs.exists(deletionLeasePath({ storeBasePath: storeBase, ownerPath: worktree }))) ===
          true) ||
      (reportOnly === false && Option.isNone(lease) === true)
    ) {
      entries.push({ ...base, action: 'none', reason: 'lease-held' })
      continue
    }
    const entry = yield* Effect.gen(function* () {
      const final = yield* capture()
      if (final.reason !== undefined)
        return { ...base, action: 'none' as const, reason: final.reason }
      if ((yield* hasWorktreeBuckClients(worktree, daemons)) === true)
        return { ...base, action: 'none' as const, reason: 'attached-client' }
      const currentDaemons = yield* findWorktreeBuckDaemons({ worktreePath: worktree })
      const currentBytes = yield* allocatedBytes(worktree)
      if (currentBytes === undefined)
        return { ...base, action: 'none' as const, reason: 'size-unavailable' }
      const action = decideBuckOut({
        sizeBytes: currentBytes,
        lastActivityMs: final.git.lastActivityMs,
        now: Date.now(),
        policy: config.buckOut,
        inactive: currentDaemons.length === 0,
      })
      if (action !== 'within-budget') {
        if (reportOnly === true) return { ...base, action, reason: 'dry-run' }
        const isolations = new Set(currentDaemons.map((item) => item.daemon.isolation))
        const outputChildren = yield* fs
          .readDirectory(join(worktree, 'buck-out'))
          .pipe(Effect.orElseSucceed(() => []))
        for (const child of outputChildren) {
          const info = yield* fs.stat(join(worktree, 'buck-out', child)).pipe(Effect.option)
          if (Option.isSome(info) === true && info.value.type === 'Directory') isolations.add(child)
        }
        if (isolations.size === 0) isolations.add('v2')
        for (const isolation of isolations) {
          const result = yield* command(
            binary.value,
            [
              '--isolation-dir',
              isolation,
              'clean',
              ...(action === 'clean-stale' ? [`--stale=${config.buckOut.keepSince}`] : []),
            ],
            worktree,
          )
          if (Option.isNone(result) === true || result.value.exitCode !== 0)
            return {
              ...base,
              action,
              reason: 'clean-failed',
              bytesAfter: (yield* allocatedBytes(worktree)) ?? null,
            }
        }
        return {
          ...base,
          action,
          reason: 'completed',
          bytesAfter: (yield* allocatedBytes(worktree)) ?? null,
        }
      }
      if (daemons.length === 0) return { ...base, action: 'none' as const, reason: 'within-budget' }
      if (reportOnly === true) {
        // Native status is read-only and does not start a missing daemon.
        for (const { daemon } of daemons) {
          const result = yield* runBuck2({ binary: binary.value, daemon, subcommand: 'status' })
          const status =
            Option.isSome(result) === true && result.value.exitCode === 0
              ? yield* Schema.decodeEffect(
                  Schema.fromJsonString(
                    Schema.Struct({ ...BuckDaemonStatus.fields, start_time: Schema.String }),
                  ),
                )(result.value.stdout).pipe(Effect.option)
              : Option.none()
          const log = yield* newestBuckLogWriteMs(daemon)
          const started = Option.isSome(status) === true ? Date.parse(status.value.start_time) : NaN
          if (
            Option.isNone(status) === true ||
            status.value.process_info.pid !== daemon.pid ||
            status.value.daemon_constraints.daemon_id !== daemon.daemonId ||
            status.value.active_commands.length > 0 ||
            Number.isFinite(started) === false ||
            Date.now() - Math.max(started, log ?? 0) < buckDurationMs(config.daemon.idleStopAfter)
          )
            return { ...base, action: 'none' as const, reason: 'daemon-not-idle' }
        }
        return { ...base, action: 'stop-daemon' as const, reason: 'dry-run' }
      }
      const stopped = yield* stopWorktreeBuckDaemons({
        worktreePath: worktree,
        binary: binary.value,
        reportRaces: false,
        idleSinceMs: Date.now() - buckDurationMs(config.daemon.idleStopAfter),
        beforeKill: () =>
          Effect.gen(function* () {
            const fresh = yield* capture()
            return (
              fresh.reason === undefined &&
              (yield* hasWorktreeBuckClients(worktree, daemons)) === false
            )
          }).pipe(Effect.orElseSucceed(() => false)),
      })
      const raced = stopped.some(
        (result) => result._tag === 'stopped' && result.raced !== undefined,
      )
      const didStop = stopped.some((result) => result._tag === 'stopped')
      return {
        ...base,
        action: didStop === true ? ('stop-daemon' as const) : ('none' as const),
        reason:
          raced === true ? 'daemon-stop-raced' : didStop === true ? 'completed' : 'daemon-not-idle',
        bytesAfter: (yield* allocatedBytes(worktree)) ?? null,
      }
    }).pipe(
      Effect.ensuring(
        Option.isSome(lease) === true ? releaseDeletionLease(lease.value) : Effect.void,
      ),
    )
    entries.push(entry)
  }
  const actions = entries.filter((entry) => entry.action !== 'none').length
  return {
    version: 1,
    dryRun: reportOnly,
    entries,
    summary: { worktrees: entries.length, actions, skipped: entries.length - actions },
  } satisfies BuckMaintainReceipt
}, Effect.provide(StoreLayer))
