import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, normalize, sep } from 'node:path'

import { Clock, DateTime, Effect, Option, Schema, Stream } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import type { PlatformError } from 'effect/PlatformError'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import { MR_VERSION } from '../core/version.ts'
import {
  isInsideWorktree,
  readProcessReferences,
  readWorktreeReferencesInUse,
  type InUseResult,
  type ProcessIdentity,
  type ProcessScanScope,
} from './store-inuse.ts'

/** Host admission survives fresh captures; store indices naturally advance during work. */
export interface WorkspaceActivityEpoch {
  readonly host: string
}

/** Canonical workspace paths protected by observed agents and retained PTY records. */
export interface WorkspaceActivity {
  readonly activePaths: ReadonlySet<string>
  /**
   * Kernel-reported process cwd/root/fd/map paths. These only protect a
   * worktree that contains them: a process rooted at `/` owns no worktree.
   */
  readonly processPaths?: ReadonlySet<string> | undefined
  readonly epoch: WorkspaceActivityEpoch
}

const NonEmpty = Schema.NonEmptyString
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const AbsolutePath = NonEmpty.check(
  Schema.makeFilter((path) => isAbsolute(path) && !path.includes('\0')),
)
const Snapshot = Schema.Struct({
  id: NonEmpty,
  host_id: NonEmpty,
  created_at: Schema.DateTimeUtcFromString,
  store_index: Count,
})
const Agent = Schema.Struct({
  id: NonEmpty,
  state: Schema.optionalKey(NonEmpty),
  operational: Schema.optionalKey(Schema.Struct({ layer: NonEmpty, actionable: Schema.Boolean })),
})
const Sync = Schema.Struct({
  state: NonEmpty,
  peers: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        host_id: NonEmpty,
        peer_only_envelopes: Count,
        local_only_envelopes: Count,
      }),
    ),
  ),
})
const AgentPage = Schema.Struct({
  api_version: Schema.Literal('st3.client.v0'),
  snapshot: Snapshot,
  value: Schema.Struct({
    kind: Schema.Literal('page'),
    collection: Schema.Literal('agents'),
    items: Schema.Array(Agent),
    page: Schema.Struct({ has_more: Schema.Boolean, next_cursor: Schema.NullOr(NonEmpty) }),
    sync: Schema.optionalKey(Sync),
  }),
}).annotate({ identifier: 'StoreWorkspaceActivity.AgentPage' })
const Subject = Schema.Struct({
  status: Schema.Struct({
    store_index: Count,
    subjects: Schema.Array(
      Schema.Struct({
        subject: NonEmpty,
        actual: Schema.NullOr(
          Schema.Struct({
            status: NonEmpty,
            workspace: Schema.optionalKey(Schema.NullOr(AbsolutePath)),
            host: Schema.optionalKey(Schema.NullOr(NonEmpty)),
          }),
        ),
      }),
    ),
  }),
}).annotate({ identifier: 'StoreWorkspaceActivity.Subject' })
const PtySessions = Schema.Array(
  Schema.Struct({
    name: NonEmpty,
    status: Schema.Literals(['running', 'exited', 'vanished']),
    pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
    cwd: AbsolutePath,
  }),
).annotate({ identifier: 'StoreWorkspaceActivity.PtySessions' })

export class ActivityUnavailable extends Schema.TaggedError<ActivityUnavailable>()(
  'ActivityUnavailable',
  {
    message: Schema.String,
  },
) {}
const unavailable = (message: string) => new ActivityUnavailable({ message })

const COMMAND_BYTES = 2 * 1024 * 1024
const CAPTURE_BYTES = 16 * 1024 * 1024
const CAPTURE_TIMEOUT_MS = 30_000

/** Both directions matter: a composed root owns child worktrees, and a PTY can sit below one. */
export const isWorkspaceActive = ({
  activity,
  canonicalWorktree,
}: {
  activity: WorkspaceActivity
  canonicalWorktree: string
}): boolean => {
  const worktree = normalize(canonicalWorktree)
  for (const activePath of activity.activePaths) {
    const active = normalize(activePath)
    if (
      active === worktree ||
      active.startsWith(worktree.endsWith(sep) === true ? worktree : `${worktree}${sep}`) ===
        true ||
      worktree.startsWith(active.endsWith(sep) === true ? active : `${active}${sep}`) === true
    )
      return true
  }
  for (const processPath of activity.processPaths ?? []) {
    if (isInsideWorktree({ candidate: processPath, worktreePath: worktree }) === true) return true
  }
  return false
}

/**
 * One bounded JSON command reader per activity capture. Its byte budget spans
 * every command in that capture, so pagination cannot grow without bound.
 */
const makeActivityCommandJson = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner
  let capturedBytes = 0

  const capture = Effect.fn('store.captureWorkspaceActivity')(function* ({
    command,
    args,
  }: {
    command: string
    args: ReadonlyArray<string>
  }) {
    const handle = yield* spawner.spawn(ChildProcess.make(command, args))
    const bounded = ({
      stream,
      limit,
      retain,
    }: {
      stream: typeof handle.stdout
      limit: number
      retain: boolean
    }) => {
      let bytes = 0
      const parts: Uint8Array[] = []
      return stream.pipe(
        Stream.runForEach((part) => {
          bytes += part.byteLength
          capturedBytes += part.byteLength
          if (bytes > limit || capturedBytes > CAPTURE_BYTES) {
            return Effect.fail(unavailable('Activity capture exceeds byte limit'))
          }
          if (retain === true) parts.push(part)
          return Effect.void
        }),
        Effect.flatMap(() =>
          Effect.try({
            try: () => {
              if (retain === false) return ''
              const decoder = new TextDecoder('utf-8', { fatal: true })
              return (
                parts.map((part) => decoder.decode(part, { stream: true })).join('') +
                decoder.decode()
              )
            },
            catch: () => unavailable('Activity command returned invalid UTF-8'),
          }),
        ),
      )
    }
    const [stdout, , exitCode] = yield* Effect.all(
      [
        bounded({ stream: handle.stdout, limit: COMMAND_BYTES, retain: true }),
        bounded({ stream: handle.stderr, limit: 64 * 1024, retain: false }),
        handle.exitCode,
      ],
      { concurrency: 3 },
    )
    if (exitCode !== 0) return yield* unavailable('Activity command failed')
    return stdout
  })
  return <TType, TEncoded>({
    command,
    args,
    schema,
  }: {
    command: string
    args: ReadonlyArray<string>
    schema: Schema.Codec<TType, TEncoded>
  }) =>
    capture({ command, args }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
      Effect.scoped,
      Effect.timeout('5 seconds'),
    )
})

/**
 * Read native st3 actual workspaces and retained local PTYs. Unknown evidence is not
 * an empty set: callers must veto reclamation when this returns undefined.
 * Each invocation is a fresh capture, with bounded pagination, bytes and time.
 */
export const readWorkspaceActivity: (options: {
  readonly fs: FileSystem.FileSystem
  readonly admittedEpoch?: WorkspaceActivityEpoch | undefined
}) => Effect.Effect<WorkspaceActivity | undefined, never, ChildProcessSpawner> = Effect.fn(
  'store.readWorkspaceActivity',
)(function* ({ fs, admittedEpoch }) {
  const host = `host/${hostname()}`
  if (admittedEpoch !== undefined && admittedEpoch.host !== host) return undefined
  const st3Binary = process.env['MEGAREPO_GC_ST3_BIN'] ?? 'st3'
  const ptyBinary = process.env['MEGAREPO_GC_PTY_BIN'] ?? 'pty'
  if (st3Binary.length === 0 || ptyBinary.length === 0) return undefined
  const commandJson = yield* makeActivityCommandJson

  const read = Effect.gen(function* () {
    const agents: Array<typeof Agent.Type> = []
    const ids = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    let snapshotId: string | undefined
    // Native cursors pin a single page snapshot. Never compare its store index
    // with a later capture: normal agent activity changes it continuously.
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = yield* commandJson({
        command: st3Binary,
        args: [
          'agents',
          'ls',
          '--all',
          '--json',
          '--limit',
          '100',
          '--daemon-wait',
          '0',
          ...(cursor === undefined ? [] : ['--cursor', cursor]),
        ],
        schema: AgentPage,
      })
      // created_at is the last incorporated claim's timestamp, not request
      // capture time; an idle (or empty) healthy projection can be arbitrarily old.
      if (
        page.snapshot.host_id !== host ||
        (snapshotId !== undefined && page.snapshot.id !== snapshotId)
      ) {
        return yield* unavailable('Activity snapshot is from another host/epoch')
      }
      snapshotId = page.snapshot.id
      // st3 omits the advisory sync decoration when there is no advisory. A
      // present incoming backlog cannot establish complete foreign activity.
      const sync = page.value.sync
      if (
        sync !== undefined &&
        !(
          sync.state === 'catching-up' &&
          sync.peers !== undefined &&
          sync.peers.length > 0 &&
          sync.peers.every((peer) => peer.peer_only_envelopes === 0) === true
        )
      ) {
        return yield* unavailable('Activity replication evidence is incomplete')
      }
      for (const agent of page.value.items) {
        if (ids.has(agent.id) === true)
          return yield* unavailable('Duplicate agent in activity pagination')
        ids.add(agent.id)
        agents.push(agent)
      }
      const next = page.value.page.next_cursor
      if (page.value.page.has_more === false) {
        if (next !== null) return yield* unavailable('Activity page has inconsistent cursor')
        break
      }
      if (
        next === null ||
        cursors.has(next) === true ||
        page.value.items.length === 0 ||
        pageNumber === 99
      ) {
        return yield* unavailable('Activity pagination is incomplete')
      }
      cursors.add(next)
      cursor = next
    }

    // Only the explicitly stopped historical projection is enough to avoid a
    // subject read. Unknown states still require the authoritative actual.
    const subjects = yield* Effect.forEach(
      agents.filter(
        (agent) =>
          !(
            agent.state === 'stopped' &&
            agent.operational?.layer === 'history' &&
            agent.operational.actionable === false
          ),
      ),
      (agent) =>
        commandJson({
          command: st3Binary,
          args: ['subject', 'show', agent.id, '--json', '--daemon-wait', '0'],
          schema: Subject,
        }).pipe(
          Effect.flatMap((result) => {
            if (
              result.status.subjects.length !== 1 ||
              result.status.subjects[0]?.subject !== agent.id
            ) {
              return Effect.fail(unavailable('Activity subject is missing or ambiguous'))
            }
            return Effect.succeed(result.status.subjects[0].actual)
          }),
        ),
      { concurrency: 8 },
    )
    // true means local evidence requires the path; false is foreign-only.
    const rawPaths = new Map<string, boolean>()
    for (const actual of subjects) {
      if (actual === null) return yield* unavailable('Activity subject has no actual observation')
      // `terminal` means a terminal exists, NOT that the process has exited.
      // stopped/exited are final runtime states; waiting/idle/suspended and
      // unknown future statuses remain protected, regardless of host.
      if (actual.status === 'stopped' || actual.status === 'exited') continue
      if (
        actual.workspace === undefined ||
        actual.workspace === null ||
        actual.host === undefined ||
        actual.host === null
      ) {
        return yield* unavailable('Active agent has incomplete workspace evidence')
      }
      const actualHost =
        actual.host.startsWith('host/') === true ? actual.host : `host/${actual.host}`
      rawPaths.set(actual.workspace, actualHost === host || rawPaths.get(actual.workspace) === true)
    }
    const sessions = yield* commandJson({
      command: ptyBinary,
      args: ['list', '--json', '--tags'],
      schema: PtySessions,
    })
    const names = new Set<string>()
    for (const session of sessions) {
      if (names.has(session.name) === true)
        return yield* unavailable('Duplicate PTY activity record')
      names.add(session.name)
      if (session.status === 'running' && session.pid === null) {
        return yield* unavailable('Running PTY has no process')
      }
      // Retained terminal metadata still owns its workspace even after exit.
      // Only removing the PTY record releases this conservative GC protection.
      rawPaths.set(session.cwd, true)
    }
    // A foreign host can have a workspace absent from this host's filesystem.
    // Keep foreign paths that exist here (shared/migration leftovers), but only
    // a definite absence may be ignored. Permission/canonicalization failures
    // remain unknown; local agents and local PTYs always require their path.
    const paths = yield* Effect.forEach(
      rawPaths,
      ([path, required]) =>
        fs
          .realPath(path)
          .pipe(
            Effect.catch((error) =>
              required === true
                ? Effect.fail(error)
                : fs
                    .exists(path)
                    .pipe(
                      Effect.flatMap((exists) =>
                        exists === true ? Effect.fail(error) : Effect.void,
                      ),
                    ),
            ),
          ),
      { concurrency: 8 },
    )
    const activePaths = new Set<string>()
    for (const path of paths) {
      if (path === undefined) continue
      if (isAbsolute(path) === false) return yield* unavailable('Noncanonical workspace path')
      activePaths.add(path)
    }
    return { activePaths, epoch: { host } }
  })
  return yield* read.pipe(
    Effect.timeout(CAPTURE_TIMEOUT_MS),
    Effect.orElseSucceed(() => undefined),
  )
})

/** Schema tag of the producer-neutral activity manifest. */
export const WORKSPACE_ACTIVITY_V2_SCHEMA = 'megarepo.workspace-activity.v2'

/** Producer name for evidence megarepo captures itself from PTY records and `/proc`. */
export const BUILTIN_ACTIVITY_PRODUCER = 'builtin'

/** Producer name of `mr store activity snapshot`: root-run, process-only evidence. */
export const PROCESS_SNAPSHOT_PRODUCER = 'mr-process'

/** Manifest lifetime ceiling: older evidence cannot describe the current host. */
export const WORKSPACE_ACTIVITY_MAX_TTL_MS = 5 * 60 * 1000

const MANIFEST_BYTES = 4 * 1024 * 1024

const ActivityManifest = Schema.Struct({
  schemaVersion: Schema.Literal(WORKSPACE_ACTIVITY_V2_SCHEMA),
  producer: Schema.Struct({ name: NonEmpty, version: NonEmpty }),
  epoch: Schema.Struct({ host: NonEmpty, snapshotId: NonEmpty, storeIndex: Count }),
  capturedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
  complete: Schema.Boolean,
  errors: Schema.Array(Schema.String),
  /**
   * `all-uids`: the producer read every process on the host (root), so its
   * `process` claims cover processes the reading owner cannot inspect, but
   * only for worktrees inside `processRoots`. `processIdentities` proves which
   * unreadable own-UID lifetimes were scanned. Says nothing about agents/PTYs.
   */
  processCoverage: Schema.optionalKey(Schema.Literal('all-uids')),
  processRoots: Schema.optionalKey(Schema.Array(AbsolutePath)),
  processIdentities: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        pid: Schema.Int.check(Schema.isGreaterThan(0)),
        startTime: NonEmpty.check(Schema.makeFilter((value) => /^[0-9]+$/.test(value))),
      }).annotate({ identifier: 'StoreWorkspaceActivity.ProcessIdentity' }),
    ),
  ),
  claims: Schema.Array(
    Schema.Struct({
      workspace: AbsolutePath,
      sources: Schema.Array(Schema.Literals(['st3-seat', 'pty', 'process'])),
      agents: Schema.Array(NonEmpty),
      activeRuntimeIds: Schema.Array(NonEmpty),
      active: Schema.Boolean,
    }),
  ),
}).annotate({ identifier: 'StoreWorkspaceActivity.ActivityManifest' })

/** Decoded `megarepo.workspace-activity.v2` manifest. */
export type WorkspaceActivityManifest = typeof ActivityManifest.Type

/**
 * Which liveness evidence a budget scan admits. `manifestPath` names an external
 * `megarepo.workspace-activity.v2` manifest whose producer must be listed in
 * `agentLivenessProducers`; `builtin` (default true) adds megarepo's own PTY
 * record and `/proc` capture. A configured manifest never falls back to builtin.
 */
export interface BudgetActivityConfig {
  readonly manifestPath?: string | undefined
  readonly agentLivenessProducers?: ReadonlyArray<string> | undefined
  readonly builtin?: boolean | undefined
}

/**
 * Identity of the admitted evidence. A scan is valid only when the evidence
 * read after it carries the same epoch; capture times are deliberately absent
 * so a plan hash survives fresh captures of an unchanged producer snapshot.
 */
export interface BudgetWorkspaceActivityEpoch extends WorkspaceActivityEpoch {
  readonly producer: string
  readonly snapshotId: string
  readonly storeIndex: number
}

/** Activity whose epoch identifies the admitted producer snapshot. */
export interface BudgetWorkspaceActivity extends WorkspaceActivity {
  readonly epoch: BudgetWorkspaceActivityEpoch
  /**
   * Present only for an admitted, unexpired root-controlled `all-uids` manifest:
   * foreign uids inside `roots` are covered by its claims. The owner's fresh
   * probe still reads available processes fully; only these exact lifetimes
   * may waive unreadable own-UID references.
   */
  readonly processCoverage?:
    | {
        readonly roots: ReadonlyArray<string>
        readonly processIdentities: ReadonlyArray<ProcessIdentity>
      }
    | undefined
}

/** Absolute path when it resolves to itself, `missing` when gone, else unavailable. */
const canonicalExisting = ({ fs, path }: { fs: FileSystem.FileSystem; path: string }) =>
  fs.realPath(path).pipe(
    Effect.map((resolved) => (resolved === normalize(path) ? resolved : ('noncanonical' as const))),
    Effect.catch((error: PlatformError) =>
      error.reason._tag === 'NotFound'
        ? Effect.succeed('missing' as const)
        : Effect.fail(unavailable('Activity workspace cannot be canonicalized')),
    ),
  )

/** Only root may have written it: uid 0 and neither group- nor world-writable. */
const isRootControlled = (info: FileSystem.File.Info): boolean =>
  Option.getOrUndefined(info.uid) === 0 && (info.mode & 0o022) === 0

/** Identity and content-shaping metadata unchanged between two stats. */
const sameFile = ({
  before,
  after,
}: {
  before: FileSystem.File.Info
  after: FileSystem.File.Info
}): boolean =>
  before.dev === after.dev &&
  Option.getOrUndefined(before.ino) === Option.getOrUndefined(after.ino) &&
  Option.getOrUndefined(before.ino) !== undefined &&
  Option.getOrUndefined(before.uid) === Option.getOrUndefined(after.uid) &&
  before.mode === after.mode &&
  before.size === after.size &&
  Option.getOrUndefined(before.mtime)?.getTime() === Option.getOrUndefined(after.mtime)?.getTime()

/**
 * `path` is a canonical directory only root can change, and no ancestor lets
 * another user rename it away: every ancestor is root-owned and either not
 * group/world-writable or sticky (like `/tmp`, where only root may move a
 * root-owned entry).
 */
const isRootControlledDirectory = ({ fs, path }: { fs: FileSystem.FileSystem; path: string }) =>
  Effect.gen(function* () {
    if ((yield* canonicalExisting({ fs, path })) !== normalize(path)) return false
    const directory = yield* fs.stat(path)
    if (directory.type !== 'Directory' || isRootControlled(directory) === false) return false
    for (let ancestor = dirname(path); ; ancestor = dirname(ancestor)) {
      const info = yield* fs.stat(ancestor)
      if (
        Option.getOrUndefined(info.uid) !== 0 ||
        ((info.mode & 0o022) !== 0 && (info.mode & 0o1000) === 0)
      ) {
        return false
      }
      if (ancestor === dirname(ancestor)) return true
    }
  })

const readActivityManifest = Effect.fn('store.readActivityManifest')(function* ({
  fs,
  path,
  producers,
}: {
  fs: FileSystem.FileSystem
  path: string
  producers: ReadonlyArray<string>
}) {
  const info = yield* fs.stat(path)
  if (info.type !== 'File' || Number(info.size) > MANIFEST_BYTES) {
    return yield* unavailable('Activity manifest is not a bounded regular file')
  }
  const manifest = yield* Schema.decodeEffect(Schema.fromJsonString(ActivityManifest))(
    yield* fs.readFileString(path),
  )
  if (producers.includes(manifest.producer.name) === false) {
    return yield* unavailable('Activity producer is not admitted')
  }
  const epochHost =
    manifest.epoch.host.startsWith('host/') === true
      ? manifest.epoch.host.slice('host/'.length)
      : manifest.epoch.host
  if (epochHost !== hostname()) return yield* unavailable('Activity manifest is from another host')
  if (
    manifest.producer.name === PROCESS_SNAPSHOT_PRODUCER &&
    (manifest.epoch.storeIndex !== 0 || manifest.epoch.snapshotId !== (yield* readBootId(fs)))
  ) {
    return yield* unavailable('Process activity manifest is from another host boot')
  }
  const now = yield* Clock.currentTimeMillis
  const capturedAt = DateTime.toEpochMillis(manifest.capturedAt)
  const expiresAt = DateTime.toEpochMillis(manifest.expiresAt)
  if (
    capturedAt > now ||
    expiresAt <= now ||
    expiresAt <= capturedAt ||
    expiresAt - capturedAt > WORKSPACE_ACTIVITY_MAX_TTL_MS
  ) {
    return yield* unavailable('Activity manifest is not fresh')
  }
  if (manifest.complete === false || manifest.errors.length > 0) {
    return yield* unavailable('Activity manifest is incomplete')
  }
  const identityPids = new Set<number>()
  for (const identity of manifest.processIdentities ?? []) {
    if (identityPids.has(identity.pid) === true) {
      return yield* unavailable('Activity manifest has duplicate process identities')
    }
    identityPids.add(identity.pid)
  }
  let processCoverage: BudgetWorkspaceActivity['processCoverage']
  if (manifest.processCoverage === 'all-uids') {
    // Foreign-UID and unreadable own-UID coverage waive part of the owner's
    // probe, so a file anyone but root could have written or swapped must not
    // grant it: no symlink in the path, a root-controlled file and directory
    // chain, and the same inode before and after the read.
    const after = yield* fs.stat(path)
    if (
      (yield* canonicalExisting({ fs, path })) !== normalize(path) ||
      isRootControlled(info) === false ||
      sameFile({ before: info, after }) === false ||
      (yield* isRootControlledDirectory({ fs, path: dirname(path) })) === false
    ) {
      return yield* unavailable('All-uid activity manifest is not root-controlled')
    }
    const roots = manifest.processRoots ?? []
    if (roots.length === 0) return yield* unavailable('All-uid activity manifest has no roots')
    for (const root of roots) {
      if ((yield* canonicalExisting({ fs, path: root })) !== normalize(root)) {
        return yield* unavailable('All-uid activity root is not canonical')
      }
    }
    processCoverage = { roots, processIdentities: manifest.processIdentities ?? [] }
  }
  const activePaths = new Set<string>()
  const processPaths = new Set<string>()
  for (const claim of manifest.claims) {
    if (claim.sources.length === 0) return yield* unavailable('Activity claim has no source')
    if (claim.active === false) continue
    const canonical = yield* canonicalExisting({ fs, path: claim.workspace })
    if (canonical === 'noncanonical') return yield* unavailable('Activity claim is noncanonical')
    // A deleted workspace has nothing left to protect.
    if (canonical === 'missing') continue
    // A process reference only holds the worktree containing it; agent and
    // PTY workspaces also protect the composed roots above them.
    if (claim.sources.every((source) => source === 'process') === true) processPaths.add(canonical)
    else activePaths.add(canonical)
  }
  return {
    activePaths,
    processPaths,
    processCoverage,
    epoch: {
      host: epochHost,
      producer: manifest.producer.name,
      snapshotId: manifest.epoch.snapshotId,
      storeIndex: manifest.epoch.storeIndex,
    },
  }
})

const readBootId = (fs: FileSystem.FileSystem) =>
  fs.readFileString('/proc/sys/kernel/random/boot_id').pipe(
    Effect.map((content) => content.trim()),
    Effect.filterOrFail(
      (bootId) => bootId.length > 0,
      () => unavailable('Host boot identity is unavailable'),
    ),
  )

/**
 * Megarepo's own capture as the reading owner: every PTY record (running,
 * exited, vanished) owns its cwd until the record is removed, and every
 * in-scope process reference (cwd, root, fd, mapped file) protects the
 * worktree containing it. Unreadable in-scope processes are unknown unless
 * their exact lifetimes were read in the admitted root snapshot.
 */
const readOwnerActivity = Effect.fn('store.readOwnerActivity')(function* ({
  fs,
  scope,
  coveredProcesses,
}: {
  fs: FileSystem.FileSystem
  scope: ProcessScanScope
  coveredProcesses?: ReadonlyArray<ProcessIdentity> | undefined
}) {
  const ptyBinary = process.env['MEGAREPO_GC_PTY_BIN'] ?? 'pty'
  if (ptyBinary.length === 0) return yield* unavailable('PTY activity source is disabled')
  const bootId = yield* readBootId(fs)
  const commandJson = yield* makeActivityCommandJson
  const sessions = yield* commandJson({
    command: ptyBinary,
    args: ['list', '--json', '--tags'],
    schema: PtySessions,
  })
  const names = new Set<string>()
  const activePaths = new Set<string>()
  for (const session of sessions) {
    if (names.has(session.name) === true) return yield* unavailable('Duplicate PTY activity record')
    names.add(session.name)
    if (session.status === 'running' && session.pid === null) {
      return yield* unavailable('Running PTY has no process')
    }
    const canonical = yield* fs.realPath(session.cwd).pipe(
      Effect.map((path): string | undefined => path),
      Effect.catch((error: PlatformError) =>
        error.reason._tag === 'NotFound'
          ? Effect.void
          : Effect.fail(unavailable('PTY workspace cannot be canonicalized')),
      ),
    )
    if (canonical !== undefined) activePaths.add(canonical)
  }
  const scan = yield* readProcessReferences({ fs, selfPid: process.pid, scope, coveredProcesses })
  if (scan._tag === 'unknown') return yield* unavailable(`Process scan is ${scan.reason}`)
  return {
    activePaths,
    processPaths: new Set(scan.references.map((reference) => reference.path)),
    epoch: {
      host: hostname(),
      producer: BUILTIN_ACTIVITY_PRODUCER,
      snapshotId: bootId,
      storeIndex: 0,
    },
  }
})

/**
 * Read build-output budget liveness. Undefined is unknown evidence and MUST
 * keep every candidate: no admitted source, missing/expired/foreign/incomplete
 * manifest, an epoch that differs from `admittedEpoch`, or any capture failure.
 *
 * A generic admitted manifest is complete agent/PTY/process evidence; builtin
 * capture then adds PTYs and a full all-uid `/proc` scan. A trusted `all-uids`
 * manifest is process-only, so the owner's PTY records and own-uid processes
 * are always captured fresh beside it, regardless of `builtin`.
 * Independent of native st3 activity; that remains `readWorkspaceActivity`.
 */
export const readBudgetWorkspaceActivity: (options: {
  readonly fs: FileSystem.FileSystem
  readonly config: BudgetActivityConfig
  readonly admittedEpoch?: BudgetWorkspaceActivityEpoch | undefined
}) => Effect.Effect<BudgetWorkspaceActivity | undefined, never, ChildProcessSpawner> = Effect.fn(
  'store.readBudgetWorkspaceActivity',
)(function* ({ fs, config, admittedEpoch }) {
  const builtin = config.builtin ?? true
  if (config.manifestPath === undefined && builtin === false) return undefined
  const read = Effect.gen(function* () {
    const manifest =
      config.manifestPath === undefined
        ? undefined
        : yield* readActivityManifest({
            fs,
            path: config.manifestPath,
            producers: config.agentLivenessProducers ?? [],
          })
    const own =
      manifest?.processCoverage !== undefined
        ? yield* readOwnerActivity({
            fs,
            scope: 'own-uid',
            coveredProcesses: manifest.processCoverage.processIdentities,
          })
        : builtin === true
          ? yield* readOwnerActivity({ fs, scope: 'all-uids' })
          : undefined
    const activity: BudgetWorkspaceActivity | undefined =
      manifest === undefined
        ? own
        : own === undefined
          ? manifest
          : {
              activePaths: new Set([...manifest.activePaths, ...own.activePaths]),
              processPaths: new Set([...manifest.processPaths, ...own.processPaths]),
              processCoverage: manifest.processCoverage,
              epoch: manifest.epoch,
            }
    if (activity === undefined) return undefined
    if (
      admittedEpoch !== undefined &&
      (admittedEpoch.host !== activity.epoch.host ||
        admittedEpoch.producer !== activity.epoch.producer ||
        admittedEpoch.snapshotId !== activity.epoch.snapshotId ||
        admittedEpoch.storeIndex !== activity.epoch.storeIndex)
    ) {
      return undefined
    }
    return activity
  })
  return yield* read.pipe(
    Effect.timeout(CAPTURE_TIMEOUT_MS),
    Effect.orElseSucceed(() => undefined),
  )
})

/**
 * Deletion-time process probe matched to the admitted evidence: inside the
 * roots of a trusted all-UID manifest foreign processes are its claims, and
 * an unreadable own-UID process requires that snapshot's exact identity.
 * Available owner processes are always read afresh. Outside those roots
 * every process must be readable. Callers MUST keep unless the result is `free`.
 */
export const readBudgetWorktreeInUse = ({
  worktreePath,
  activity,
}: {
  worktreePath: string
  activity: BudgetWorkspaceActivity | undefined
}): Effect.Effect<InUseResult, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const coverage = activity?.processCoverage
    const covered =
      coverage !== undefined &&
      coverage.roots.some((root) =>
        isInsideWorktree({ candidate: worktreePath, worktreePath: root }),
      )
    return yield* readWorktreeReferencesInUse({
      worktreePath,
      scope: covered === true ? 'own-uid' : 'all-uids',
      coveredProcesses: covered === true ? coverage?.processIdentities : undefined,
    })
  })

/**
 * Root-run process snapshot (`mr store activity snapshot`): every process's
 * cwd/root/fd/mapped-file reference inside `storeRoots`, as `process` claims
 * with `all-uids` coverage and the identities of every scanned user process,
 * including those with no reference inside the roots. Directory references
 * claim themselves; files claim their directory so deleted-but-open files still
 * protect it. Any unreadable process or root yields `complete: false` with errors.
 */
export const captureProcessActivityManifest = Effect.fn('store.captureProcessActivityManifest')(
  function* ({ fs, storeRoots }: { fs: FileSystem.FileSystem; storeRoots: ReadonlyArray<string> }) {
    const now = yield* Clock.currentTimeMillis
    const errors: Array<string> = []
    const bootId = yield* readBootId(fs).pipe(
      Effect.catch(() => {
        errors.push('host boot identity is unavailable')
        return Effect.succeed('unknown')
      }),
    )
    const roots: Array<string> = []
    for (const root of storeRoots) {
      const canonical = yield* fs.realPath(root).pipe(Effect.option)
      if (canonical._tag === 'None') errors.push(`store root cannot be resolved: ${root}`)
      else roots.push(canonical.value)
    }
    if (roots.length === 0) errors.push('no store roots')
    const scan = yield* readProcessReferences({ fs, selfPid: process.pid, scope: 'all-uids' })
    const workspaces = new Set<string>()
    if (scan._tag === 'unknown') {
      errors.push(
        `process scan is ${scan.reason}${scan.pid === undefined ? '' : ` (pid ${scan.pid})`}`,
      )
    } else {
      for (const reference of scan.references) {
        const workspace =
          reference.kind === 'cwd' || reference.kind === 'root'
            ? reference.path
            : dirname(reference.path)
        if (
          roots.some((root) => isInsideWorktree({ candidate: workspace, worktreePath: root })) ===
          true
        ) {
          workspaces.add(workspace)
        }
      }
    }
    const manifest: WorkspaceActivityManifest = {
      schemaVersion: WORKSPACE_ACTIVITY_V2_SCHEMA,
      producer: { name: PROCESS_SNAPSHOT_PRODUCER, version: MR_VERSION },
      epoch: { host: hostname(), snapshotId: bootId, storeIndex: 0 },
      capturedAt: DateTime.makeUnsafe(now),
      expiresAt: DateTime.makeUnsafe(now + WORKSPACE_ACTIVITY_MAX_TTL_MS),
      complete: errors.length === 0,
      errors,
      processCoverage: 'all-uids',
      processRoots: roots,
      processIdentities: scan._tag === 'complete' ? scan.processIdentities : [],
      claims: [...workspaces].toSorted().map((workspace) => ({
        workspace,
        sources: ['process'] as const,
        agents: [],
        activeRuntimeIds: [],
        active: true,
      })),
    }
    return manifest
  },
)

/**
 * Atomically publish a manifest: exclusively create a fresh randomly named
 * sibling with mode 0644, then rename it over `path`, so readers never see a
 * partial manifest; the temp file is removed on any failure. An `all-uids`
 * manifest may only be published into a canonical root-controlled directory,
 * because readers grant it foreign-process coverage.
 */
export const writeWorkspaceActivityManifest = Effect.fn('store.writeWorkspaceActivityManifest')(
  function* ({
    fs,
    path,
    manifest,
  }: {
    fs: FileSystem.FileSystem
    path: string
    manifest: WorkspaceActivityManifest
  }) {
    if (isAbsolute(path) === false) return yield* unavailable('Activity manifest path is relative')
    if (
      manifest.processCoverage === 'all-uids' &&
      (yield* isRootControlledDirectory({ fs, path: dirname(path) })) === false
    ) {
      return yield* unavailable('All-uid activity manifest directory is not root-controlled')
    }
    const content = yield* Schema.encodeEffect(Schema.fromJsonString(ActivityManifest))(manifest)
    const temporary = `${dirname(path)}/.${basename(path)}.${randomUUID()}.tmp`
    yield* Effect.gen(function* () {
      yield* fs.writeFileString(temporary, content, { flag: 'wx', mode: 0o644 })
      // `mode` at creation is filtered by umask; publish exactly 0644.
      yield* fs.chmod(temporary, 0o644)
      yield* fs.rename(temporary, path)
    }).pipe(Effect.onError(() => fs.remove(temporary).pipe(Effect.ignore)))
  },
)
