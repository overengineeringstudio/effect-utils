import { randomBytes } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'

import { Clock, DateTime, Effect, Option, Schema, Semaphore } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { readCensusMonotonicNs, requestCensus } from './store-demand-census-socket.ts'
import {
  CensusRequest,
  CensusUnavailable,
  type CensusResponse,
  type CensusStamp,
} from './store-demand-census-wire.ts'
import {
  isInsideWorktree,
  parseProcStat,
  type InUseResult,
  type ProcessIdentity,
} from './store-inuse.ts'
import {
  admitActivityManifest,
  PROCESS_SNAPSHOT_PRODUCER,
  readBudgetWorktreeInUse,
  type BudgetWorkspaceActivity,
  type WorkspaceActivityManifest,
} from './store-workspace-activity.ts'

const NS = 1_000_000_000n
const unavailable = (details: string) => new CensusUnavailable({ reason: 'admission', details })
const key = (identity: ProcessIdentity): string => `${identity.pid}:${identity.startTime}`
const inside = (path: string, roots: ReadonlyArray<string>): boolean =>
  roots.some((root) => isInsideWorktree({ candidate: path, worktreePath: root }))
const sameSet = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  new Set(left).size === left.length &&
  new Set(right).size === right.length &&
  left.length === right.length &&
  left.every((entry) => right.includes(entry))
const canonicalPath = (path: string): boolean =>
  isAbsolute(path) && normalize(path) === path && !path.includes('\0')

/** Causal and cross-field checks supplement, rather than replace, v2 value admission. */
export const validateDemandCensusResponse = ({
  request,
  response,
  receivedAt,
  deadlineNs,
}: {
  readonly request: CensusRequest
  readonly response: CensusResponse
  readonly receivedAt: CensusStamp
  readonly deadlineNs: bigint
}): Effect.Effect<Extract<CensusResponse, { readonly _tag: 'Complete' }>, CensusUnavailable> =>
  Effect.gen(function* () {
    if (response._tag === 'Refused')
      return yield* new CensusUnavailable({
        reason: 'admission',
        details: `Collector refused: ${response.reason}`,
        refusalReason: response.reason,
      })
    const snapshot = response.snapshot
    const unreadable = response.coverage.find((entry) => entry._tag === 'Unreadable')
    if (unreadable !== undefined && unreadable._tag === 'Unreadable')
      return yield* new CensusUnavailable({
        reason: 'admission',
        details: 'Named lifetime is unreadable',
        unreadable: { lifetime: unreadable.lifetime, reason: unreadable.reason },
      })
    if (response.bootId !== request.bootId || response.nonce !== request.nonce)
      return yield* unavailable('Boot or nonce mismatch')
    const requested = BigInt(request.requestedAt.monotonicNs)
    const started = BigInt(response.captureStartedAt.monotonicNs)
    const ended = BigInt(response.captureEndedAt.monotonicNs)
    const received = BigInt(receivedAt.monotonicNs)
    if (
      !(requested < started && started <= ended && ended <= received) ||
      ended - started > 10n * NS ||
      received > deadlineNs ||
      received - requested > 12n * NS
    )
      return yield* unavailable('Noncausal capture or exceeded monotonic deadline')
    if (
      !response.complete ||
      !snapshot.complete ||
      snapshot.errors.length !== 0 ||
      snapshot.producer.name !== PROCESS_SNAPSHOT_PRODUCER ||
      snapshot.epoch.snapshotId !== request.bootId ||
      snapshot.epoch.storeIndex !== 0 ||
      snapshot.processCoverage !== 'all-uids' ||
      snapshot.processIdentities === undefined ||
      !sameSet(snapshot.processRoots ?? [], request.authorizedRoots) ||
      DateTime.toEpochMillis(snapshot.capturedAt) !==
        DateTime.toEpochMillis(response.captureEndedAt.wall)
    )
      return yield* unavailable('Incomplete or inconsistent v2 capture')
    const identities = new Map(
      snapshot.processIdentities.map((identity) => [identity.pid, identity.startTime]),
    )
    if (
      identities.size !== snapshot.processIdentities.length ||
      snapshot.processIdentities.some(
        (identity) =>
          !Number.isSafeInteger(identity.pid) ||
          identity.pid <= 0 ||
          !/^(0|[1-9][0-9]*)$/.test(identity.startTime),
      )
    )
      return yield* unavailable('Invalid or duplicate snapshot process identities')
    if (
      !sameSet(
        response.coverage.map((entry) => key(entry.lifetime)),
        request.namedLifetimes.map(key),
      )
    )
      return yield* unavailable('Coverage does not exactly match requested lifetimes')
    for (const claim of snapshot.claims) {
      if (
        !canonicalPath(claim.workspace) ||
        !inside(claim.workspace, request.authorizedRoots) ||
        !claim.active ||
        claim.sources.length !== 1 ||
        claim.sources[0] !== 'process' ||
        claim.agents.length !== 0 ||
        claim.activeRuntimeIds.length !== 0
      )
        return yield* unavailable('Invalid process ownership claim')
      const attributed = new Set<number>()
      for (const process of claim.processes ?? []) {
        if (attributed.has(process.pid) || identities.get(process.pid) !== process.startTime)
          return yield* unavailable('Inconsistent claim lifetime attribution')
        attributed.add(process.pid)
      }
    }
    for (const entry of response.coverage) {
      if (entry._tag === 'Unreadable') continue
      const liveStart = identities.get(entry.lifetime.pid)
      if (entry._tag === 'Exited') {
        if (liveStart === entry.lifetime.startTime)
          return yield* unavailable('Exited lifetime occurs in live identities')
        continue
      }
      if (liveStart !== entry.lifetime.startTime)
        return yield* unavailable('Covered lifetime missing from snapshot identities')
      const claims = snapshot.claims.filter((claim) =>
        claim.processes?.some((process) => key(process) === key(entry.lifetime)),
      )
      if (entry.evidence._tag === 'ForeignUidProjection') {
        const roots = entry.evidence.ownershipRoots
        if (
          !sameSet(
            roots,
            claims.map((claim) => claim.workspace),
          ) ||
          roots.some((root) => !canonicalPath(root) || !inside(root, request.authorizedRoots))
        )
          return yield* unavailable('Foreign ownership projection differs from process claims')
      } else {
        const evidence = entry.evidence
        const paths = [
          ...evidence.cwd,
          ...evidence.root,
          ...evidence.fdTargets,
          ...evidence.mapTargets,
        ]
        if (
          evidence.cwd.length > 1 ||
          evidence.root.length > 1 ||
          paths.some((path) => !canonicalPath(path) || !inside(path, request.authorizedRoots))
        )
          return yield* unavailable('Own-UID evidence contains invalid paths')
        const overlaps = (a: string, b: string) =>
          isInsideWorktree({ candidate: a, worktreePath: b }) ||
          isInsideWorktree({ candidate: b, worktreePath: a })
        // Unattributed claims remain conservative holders, but cannot attest that a
        // particular lifetime contributed a foreign projection or waive a daemon.
        if (
          paths.some(
            (path) =>
              !snapshot.claims.some(
                (claim) =>
                  overlaps(path, claim.workspace) &&
                  (claim.processes === undefined ||
                    claim.processes.some((identity) => key(identity) === key(entry.lifetime))),
              ),
          ) ||
          claims.some((claim) => !paths.some((path) => overlaps(path, claim.workspace)))
        )
          return yield* unavailable('Own-UID details disagree with ownership claims')
      }
    }
    return response
  }).pipe(Effect.withSpan('store.validateDemandCensusResponse'))

export interface DemandCensusProbe {
  readonly holder: InUseResult
  readonly activity: BudgetWorkspaceActivity | undefined
  readonly failure?: CensusUnavailable | undefined
}

export interface DemandCensusProbeOptions {
  readonly worktreePath: string
  readonly activity: BudgetWorkspaceActivity | undefined
  readonly ignoredProcesses?: ReadonlyArray<ProcessIdentity> | undefined
}

export interface DemandCensusController {
  readonly probe: (options: DemandCensusProbeOptions) => Effect.Effect<DemandCensusProbe>
}

/** Endpoint override for real-socket tests; authentication is never optional. */
export interface DemandCensusTestOptions {
  readonly socketPath?: string
}

/** One controller per maintenance run, never one per worktree or destructive action. */
export const makeDemandCensus = Effect.fn('store.makeDemandCensus')(function* ({
  fs,
  roots,
  producers,
  testOptions,
}: {
  readonly fs: FileSystem.FileSystem
  readonly roots: ReadonlyArray<string>
  readonly producers: ReadonlyArray<string>
  readonly testOptions?: DemandCensusTestOptions
}): Effect.fn.Return<DemandCensusController> {
  const gate = yield* Semaphore.make(1)
  const rpc = requestCensus
  const monotonicNs = readCensusMonotonicNs
  const scan = readBudgetWorktreeInUse
  let attempts = 0
  let runDeadline: bigint | undefined
  let failure: CensusUnavailable | undefined
  let failedHolder: InUseResult = { _tag: 'unknown', reason: 'scan-failed' }
  const captures: Array<WorkspaceActivityManifest> = []
  const detailCaptures: Array<WorkspaceActivityManifest> = []
  const requestedLifetimes = new Set<string>()
  let admittedRootIdentity: ReadonlyArray<string> | undefined
  const rootIdentity = Effect.fn('store.censusRootIdentity')(function* () {
    if (roots.length === 0 || roots.length > 32 || new Set(roots).size !== roots.length)
      return yield* unavailable('Invalid authorized root set')
    return yield* Effect.forEach(roots, (root) =>
      Effect.gen(function* () {
        if (!canonicalPath(root) || (yield* fs.realPath(root)) !== root)
          return yield* unavailable('Authorized root is not canonical')
        const info = yield* fs.stat(root)
        const ino = Option.getOrUndefined(info.ino)
        if (info.type !== 'Directory' || ino === undefined)
          return yield* unavailable('Authorized root identity is unavailable')
        return `${root}\0${info.dev}:${ino}`
      }),
    )
  })
  const bootId = fs
    .readFileString('/proc/sys/kernel/random/boot_id')
    .pipe(Effect.map((value) => value.trim()))
  const mergeActivity = Effect.fn('store.mergeDemandCensusActivity')(function* (
    base: BudgetWorkspaceActivity | undefined,
    ignoredProcesses?: ReadonlyArray<ProcessIdentity>,
  ) {
    if (captures.length === 0) return base
    const admitted = yield* Effect.forEach(captures, (manifest) =>
      admitActivityManifest({ fs, manifest, producers, ignoredProcesses }),
    )
    const details = yield* Effect.forEach(detailCaptures, (manifest) =>
      admitActivityManifest({ fs, manifest, producers, ignoredProcesses }),
    )
    const latest = admitted[admitted.length - 1]!
    return {
      ...latest,
      activePaths: new Set([
        ...(base?.activePaths ?? []),
        ...admitted.flatMap((entry) => [...entry.activePaths]),
      ]),
      processClaimPaths: new Set([
        ...(base?.processClaimPaths ?? []),
        ...admitted.flatMap((entry) => [...(entry.processClaimPaths ?? [])]),
      ]),
      processPaths: new Set([
        ...(base?.processPaths ?? []),
        ...details.flatMap((entry) => [...(entry.processClaimPaths ?? [])]),
      ]),
      nativeEvidence: base?.nativeEvidence,
      ownerClaims: base?.ownerClaims,
      // Native identity remains the caller's admission gate, never a socket grant.
      epoch: base?.epoch ?? latest.epoch,
    } satisfies BudgetWorkspaceActivity
  })
  const probe = Effect.fn('store.probeDemandCensus')(function* ({
    worktreePath,
    activity,
    ignoredProcesses,
  }: DemandCensusProbeOptions) {
    let current = activity
    let holder: InUseResult = { _tag: 'unknown', reason: 'scan-failed' }
    const result = yield* Effect.gen(function* () {
      if (
        admittedRootIdentity !== undefined &&
        !sameSet(admittedRootIdentity, yield* rootIdentity())
      )
        return yield* unavailable('Authorized root identity changed after capture')
      current = yield* mergeActivity(activity, ignoredProcesses)
      holder = yield* scan({ worktreePath, activity: current, ignoredProcesses }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      )
      const expectedWorktree = worktreePath === '/' ? '/' : worktreePath.replace(/\/+$/u, '')
      if ((yield* fs.realPath(worktreePath)) !== expectedWorktree)
        return yield* unavailable('Candidate worktree is not canonical')
      while (holder._tag === 'unknown' && holder.pid !== undefined && failure === undefined) {
        if (!inside(worktreePath, roots)) break
        // A readable, stable field 22 names a lifetime; an unreadable stat never requests.
        const before = parseProcStat(yield* fs.readFileString(`/proc/${holder.pid}/stat`))
        const after = parseProcStat(yield* fs.readFileString(`/proc/${holder.pid}/stat`))
        if (before === undefined || after === undefined || before.startTime !== after.startTime)
          break
        const lifetime = { pid: holder.pid, startTime: after.startTime }
        if (requestedLifetimes.has(key(lifetime))) break
        if (attempts >= 3) return yield* unavailable('Run connection attempt limit exhausted')
        const beforeRoots = yield* rootIdentity()
        const boot = yield* bootId
        const now = yield* monotonicNs
        if (runDeadline === undefined) runDeadline = now + 35n * NS
        if (now >= runDeadline) return yield* unavailable('Run monotonic deadline exhausted')
        const deadlineNs = now + 12n * NS < runDeadline ? now + 12n * NS : runDeadline
        const request = yield* Schema.decodeUnknownEffect(CensusRequest)({
          version: 1,
          bootId: boot,
          nonce: randomBytes(32).toString('hex'),
          requestedAt: {
            monotonicNs: now.toString(),
            wall: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
          },
          requesterUid: process.getuid?.(),
          authorizedRoots: roots,
          namedLifetimes: [lifetime],
        })
        attempts++
        requestedLifetimes.add(key(lifetime))
        const reply = yield* rpc({
          request,
          deadlineNs,
          ...(testOptions?.socketPath === undefined ? {} : { socketPath: testOptions.socketPath }),
        })
        const response = yield* validateDemandCensusResponse({ request, ...reply, deadlineNs })
        if ((yield* bootId) !== boot) return yield* unavailable('Local boot changed during capture')
        const afterRoots = yield* rootIdentity()
        if (!sameSet(beforeRoots, afterRoots))
          return yield* unavailable('Authorized root identity changed during capture')
        // Every disclosed own-UID path is a conservative holder too, including
        // references below a coarser ownership projection in the full snapshot.
        const detailsClaims = response.coverage.flatMap((entry) => {
          if (entry._tag !== 'Covered' || entry.evidence._tag !== 'OwnUidDetails') return []
          const evidence = entry.evidence
          const process = response.snapshot.claims
            .flatMap((claim) => claim.processes ?? [])
            .find((identity) => key(identity) === key(entry.lifetime))
          return [
            ...evidence.cwd,
            ...evidence.root,
            ...evidence.fdTargets,
            ...evidence.mapTargets,
          ].map((workspace) => ({
            workspace,
            sources: ['process'] as const,
            agents: [],
            activeRuntimeIds: [],
            active: true,
            ...(process === undefined ? {} : { processes: [process] }),
          }))
        })
        const details = { ...response.snapshot, claims: detailsClaims }
        yield* admitActivityManifest({
          fs,
          manifest: response.snapshot,
          producers,
          ignoredProcesses,
        })
        yield* admitActivityManifest({ fs, manifest: details, producers, ignoredProcesses })
        if ((yield* monotonicNs) > deadlineNs)
          return yield* unavailable('Admission exceeded the RPC or run deadline')
        captures.push(response.snapshot)
        detailCaptures.push(details)
        admittedRootIdentity = afterRoots
        current = yield* mergeActivity(activity, ignoredProcesses)
        holder = yield* scan({ worktreePath, activity: current, ignoredProcesses }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        )
      }
      return { holder, activity: current, failure } satisfies DemandCensusProbe
    }).pipe(
      Effect.catch((error) => {
        failure =
          error instanceof CensusUnavailable
            ? error
            : unavailable(`Census unavailable: ${String(error)}`)
        if (holder._tag === 'unknown') failedHolder = holder
        return Effect.succeed({ holder, activity: current, failure } satisfies DemandCensusProbe)
      }),
      Effect.catchCause((cause) => {
        failure = unavailable(`Census unavailable: ${String(cause)}`)
        if (holder._tag === 'unknown') failedHolder = holder
        return Effect.succeed({ holder, activity: current, failure } satisfies DemandCensusProbe)
      }),
    )
    return failure !== undefined && result.holder._tag === 'free'
      ? { ...result, holder: failedHolder }
      : result
  })
  return { probe: (options: DemandCensusProbeOptions) => gate.withPermits(1)(probe(options)) }
})
