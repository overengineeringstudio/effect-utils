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
  readBuckProjectRoot,
  runBuck2,
  stopWorktreeBuckDaemons,
  type WorktreeBuckDaemon,
} from './store-buck-daemons.ts'
import { buckDurationMs, loadStoreBuckMaintainConfig } from './store-buck-maintain-config.ts'
import {
  discoverBuckMaintainWorktrees,
  readBuckMaintainGitEvidence,
  readBuckMaintainOutputActivity,
} from './store-buck-maintain-evidence.ts'
import {
  decideBuckOut,
  decideMaintainGate,
  fullCleanLastActivityMs,
  isInBlackout,
} from './store-buck-maintain-policy.ts'
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
  readWorkspaceActivity,
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

const allocatedBytes = Effect.fn('store.buckMaintain.allocatedBytes')(function* (worktree: string) {
  const fs = yield* FileSystem.FileSystem
  if ((yield* fs.exists(join(worktree, 'buck-out'))) === false) return 0
  const result = yield* command('du', ['--summarize', '--block-size=1', '--', 'buck-out'], worktree)
  if (Option.isNone(result) === true || result.value.exitCode !== 0) return undefined
  const value = Number(/^([0-9]+)\s/u.exec(result.value.stdout)?.[1])
  return Number.isSafeInteger(value) === true && value >= 0 ? value : undefined
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

/** Preserve uncertainty separately from a successfully inspected process with no ST_AGENT. */
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
  const evidence: BuckMaintainOwnerEvidence[] =
    scan._tag === 'complete' ? [] : [{ source: 'process', owner: null }]
  for (const pid of pids) {
    const before = yield* fs.readFileString(`/proc/${pid}/stat`).pipe(Effect.option)
    const environ = yield* fs.readFileString(`/proc/${pid}/environ`).pipe(Effect.option)
    const after = yield* fs.readFileString(`/proc/${pid}/stat`).pipe(Effect.option)
    const start =
      Option.isSome(before) === true ? parseProcStat(before.value)?.startTime : undefined
    const end = Option.isSome(after) === true ? parseProcStat(after.value)?.startTime : undefined
    if (start === undefined || start !== end || Option.isNone(environ) === true) {
      evidence.push({ source: 'process', owner: null, pid })
      continue
    }
    const owner = environ.value
      .split('\0')
      .find((value) => value.startsWith('ST_AGENT=') === true)
      ?.slice('ST_AGENT='.length)
    // A readable environment without ST_AGENT is positively unowned, not uncertain.
    if (owner !== undefined && owner !== '') evidence.push({ source: 'process', owner, pid })
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
    let daemons = yield* findWorktreeBuckDaemons({ worktreePath: worktree })
    let ignoredProcesses = daemons.flatMap((entry) => entry.processes)
    const ownerEvidence: BuckMaintainOwnerEvidence[] = []
    const capture = Effect.fn('store.buckMaintain.capture')(function* () {
      const preflightGit = yield* readBuckMaintainGitEvidence(worktree)
      if (preflightGit.locked !== false || preflightGit.lastActivityMs === undefined)
        return {
          reason: preflightGit.locked !== false ? 'git-locked' : 'git-activity-unknown',
          git: preflightGit,
          evidence: ownerEvidence,
          activity: undefined,
          fullLastActivityMs: undefined,
        }
      const activity = yield* readBudgetWorkspaceActivity({
        fs,
        config: activityConfig,
        ignoredOwnProcesses: ignoredProcesses,
        ignoredManifestProcesses: ignoredProcesses,
      })
      const preflightHolder = yield* readBudgetWorktreeInUse({
        worktreePath: worktree,
        activity,
        ignoredProcesses,
      })
      if (preflightHolder._tag !== 'free')
        return {
          reason: preflightHolder._tag === 'in-use' ? 'holder-live' : 'holder-census-incomplete',
          git: preflightGit,
          evidence: ownerEvidence,
          activity,
          fullLastActivityMs: undefined,
        }
      const native = yield* readWorkspaceActivity({ fs })
      const seatEvidence: BuckMaintainOwnerEvidence[] = [
        ...(activity?.ownerClaims ?? []),
        ...(native?.ownerClaims ?? []),
      ]
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
      // Ownership is monotonic within a run: a later scan must not erase an earlier owner
      // or uncertainty, and one unknown source must never hide a known foreign owner.
      ownerEvidence.push(...(yield* processOwners(worktree, daemons)), ...seatEvidence)
      // Refresh filesystem and holder gates after the potentially slow native
      // claim and owner captures, not before them.
      const git = yield* readBuckMaintainGitEvidence(worktree)
      const buckActivityMs =
        config.buckOut.fullCleanWhenInactiveFor === undefined
          ? undefined
          : yield* readBuckMaintainOutputActivity(worktree)
      const holder = yield* readBudgetWorktreeInUse({
        worktreePath: worktree,
        activity,
        ignoredProcesses,
      })
      const evidence = ownerEvidence
      const owners = evidence.map((entry) => entry.owner)
      const reason = decideMaintainGate({
        blackout: isInBlackout({ now: Date.now(), blackout: config.blackout }),
        gitLocked: git.locked,
        liveHolder: holder._tag === 'unknown' ? undefined : holder._tag === 'in-use',
        seatClaimsComplete: native?.ownerClaims !== undefined,
        activeClaim:
          activity === undefined
            ? undefined
            : isWorkspaceActive({ activity, canonicalWorktree: worktree }) ||
              (native !== undefined &&
                isWorkspaceActive({ activity: native, canonicalWorktree: worktree })),
        owners,
        currentAgent,
        maintainOwners: config.maintainOwners,
        maintainUnowned: config.maintainUnowned,
        leaseHeld: false,
      })
      const fullLastActivityMs = fullCleanLastActivityMs({
        gitActivityMs: git.lastActivityMs,
        buckActivityMs,
      })
      const activityReason =
        git.lastActivityMs === undefined
          ? 'git-activity-unknown'
          : config.buckOut.fullCleanWhenInactiveFor !== undefined &&
              daemons.length === 0 &&
              fullLastActivityMs === undefined
            ? 'inactivity-unknown'
            : undefined
      return {
        reason: reason ?? activityReason,
        git,
        evidence,
        activity,
        fullLastActivityMs,
      }
    })
    const initial = blackout === true ? undefined : yield* capture()
    // Skip gates precede all output accounting; a no-op must not walk buck-out.
    const base = {
      worktree,
      bytesBefore: null as number | null,
      bytesAfter: null as number | null,
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
    const root = yield* readBuckProjectRoot({
      cwd: worktree,
      homeDirectory: process.env['HOME'],
    }).pipe(Effect.orElseSucceed(() => undefined))
    if (root !== worktree) {
      entries.push({ ...base, action: 'none', reason: 'project-root-mismatch' })
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
    const maintained = yield* Effect.gen(function* () {
      // Potentially slow accounting is completed before the final safety observation.
      const currentBytes = yield* allocatedBytes(worktree)
      if (currentBytes === undefined)
        return { ...base, action: 'none' as const, reason: 'size-unavailable' }
      base.bytesBefore = currentBytes
      base.bytesAfter = currentBytes
      // "Inactive" means no recorded work for the interval and no daemon now.
      // A recent exit alone is not work: old Git/log/state timestamps can qualify.
      const action = decideBuckOut({
        sizeBytes: currentBytes,
        lastActivityMs: initial?.fullLastActivityMs,
        now: Date.now(),
        policy: config.buckOut,
        inactive: daemons.length === 0,
      })
      // No measurement, directory enumeration or other unrelated work follows this
      // recheck before a native action. Every isolation gets its own fresh check.
      const recheck = Effect.fn('store.buckMaintain.recheck')(function* () {
        const fresh = yield* capture()
        if (fresh.reason !== undefined) return fresh.reason
        const projectRoot = yield* readBuckProjectRoot({
          cwd: worktree,
          homeDirectory: process.env['HOME'],
        }).pipe(Effect.orElseSucceed(() => undefined))
        if (projectRoot !== worktree) return 'project-root-mismatch'
        const current = yield* findWorktreeBuckDaemons({ worktreePath: worktree })
        if (
          current.length !== daemons.length ||
          current.some(
            (entry) =>
              daemons.some(
                (expected) =>
                  expected.daemon.pid === entry.daemon.pid &&
                  expected.daemon.daemonId === entry.daemon.daemonId,
              ) === false,
          ) === true
        )
          return 'daemon-changed'
        if ((yield* hasWorktreeBuckClients(worktree, current)) === true) return 'attached-client'
        if (action === 'full-clean') {
          if (current.length !== 0) return 'daemon-not-idle'
          if (fresh.fullLastActivityMs === undefined) return 'inactivity-unknown'
          if (
            decideBuckOut({
              sizeBytes: currentBytes,
              lastActivityMs: fresh.fullLastActivityMs,
              now: Date.now(),
              policy: config.buckOut,
              inactive: true,
            }) !== 'full-clean'
          )
            return 'activity-changed'
        }
        return undefined
      })
      if (action !== 'within-budget') {
        const isolations = new Set(daemons.map((item) => item.daemon.isolation))
        const outputChildren = yield* fs
          .readDirectory(join(worktree, 'buck-out'))
          .pipe(Effect.orElseSucceed(() => []))
        for (const child of outputChildren) {
          const info = yield* fs.stat(join(worktree, 'buck-out', child)).pipe(Effect.option)
          if (Option.isSome(info) === true && info.value.type === 'Directory') isolations.add(child)
        }
        if (isolations.size === 0) isolations.add('v2')
        let cleaned = false
        for (const isolation of isolations) {
          const reason = yield* recheck()
          if (reason !== undefined)
            return { ...base, action: cleaned === true ? action : ('none' as const), reason }
          if (reportOnly === true) continue
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
          cleaned = true
          // Admit only the exact lifetimes produced/observed after our native action;
          // any later arrival still changes the next action's final daemon census.
          daemons = yield* findWorktreeBuckDaemons({ worktreePath: worktree })
          ignoredProcesses = daemons.flatMap((entry) => entry.processes)
        }
        return {
          ...base,
          action,
          reason: reportOnly === true ? 'dry-run' : 'completed',
          bytesAfter:
            reportOnly === true ? currentBytes : ((yield* allocatedBytes(worktree)) ?? null),
        }
      }
      if (daemons.length === 0) return { ...base, action: 'none' as const, reason: 'within-budget' }
      if (reportOnly === true) {
        const reason = yield* recheck()
        if (reason !== undefined) return { ...base, action: 'none' as const, reason }
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
          recheck().pipe(
            Effect.map((reason) => reason === undefined),
            Effect.orElseSucceed(() => false),
          ),
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
    entries.push(maintained)
  }
  const actions = entries.filter((entry) => entry.action !== 'none').length
  return {
    version: 1,
    dryRun: reportOnly,
    entries,
    summary: { worktrees: entries.length, actions, skipped: entries.length - actions },
  } satisfies BuckMaintainReceipt
}, Effect.provide(StoreLayer))
