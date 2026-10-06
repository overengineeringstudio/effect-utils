import { hostname } from 'node:os'
import { isAbsolute, normalize, sep } from 'node:path'

import { DateTime, Effect, Schema, Stream } from 'effect'
import type * as FileSystem from 'effect/FileSystem'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

/** Host admission survives fresh captures; store indices naturally advance during work. */
export interface WorkspaceActivityEpoch {
  readonly host: string
}

export interface WorkspaceActivity {
  readonly activePaths: ReadonlySet<string>
  readonly epoch: WorkspaceActivityEpoch
}

const NonEmpty = Schema.NonEmptyString
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const AbsolutePath = NonEmpty.check(Schema.makeFilter((path) => isAbsolute(path) && !path.includes('\0')))
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
  peers: Schema.optionalKey(Schema.Array(Schema.Struct({
    host_id: NonEmpty,
    peer_only_envelopes: Count,
    local_only_envelopes: Count,
  }))),
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
    subjects: Schema.Array(Schema.Struct({
      subject: NonEmpty,
      actual: Schema.NullOr(Schema.Struct({
        status: NonEmpty,
        workspace: Schema.optionalKey(Schema.NullOr(AbsolutePath)),
        host: Schema.optionalKey(Schema.NullOr(NonEmpty)),
      })),
    })),
  }),
}).annotate({ identifier: 'StoreWorkspaceActivity.Subject' })
const PtySessions = Schema.Array(Schema.Struct({
  name: NonEmpty,
  status: Schema.Literals(['running', 'exited', 'vanished']),
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  cwd: AbsolutePath,
})).annotate({ identifier: 'StoreWorkspaceActivity.PtySessions' })

class ActivityUnavailable extends Schema.TaggedError<ActivityUnavailable>()('ActivityUnavailable', {
  message: Schema.String,
}) {}
const unavailable = (message: string) => new ActivityUnavailable({ message })

const COMMAND_BYTES = 2 * 1024 * 1024
const CAPTURE_BYTES = 16 * 1024 * 1024
const CAPTURE_TIMEOUT_MS = 30_000
const SNAPSHOT_MAX_AGE_MS = 30_000

/** Both directions matter: a composed root owns child worktrees, and a PTY can sit below one. */
export const isWorkspaceActive = (
  activity: WorkspaceActivity,
  canonicalWorktree: string,
): boolean => {
  const worktree = normalize(canonicalWorktree)
  const inside = (child: string, parent: string) =>
    child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
  for (const activePath of activity.activePaths) {
    const active = normalize(activePath)
    if (inside(worktree, active) || inside(active, worktree)) return true
  }
  return false
}

/**
 * Read native st3 actual workspaces and live local PTYs. Unknown evidence is not
 * an empty set: callers must veto reclamation when this returns undefined.
 * Each invocation is a fresh capture, with bounded pagination, bytes and time.
 */
export const readWorkspaceActivity: (options: {
  readonly fs: FileSystem.FileSystem
  readonly atMs: number
  readonly admittedEpoch?: WorkspaceActivityEpoch | undefined
}) => Effect.Effect<WorkspaceActivity | undefined, never, ChildProcessSpawner> = Effect.fn(
  'store.readWorkspaceActivity',
)(function* ({ fs, atMs, admittedEpoch }) {
  if (!Number.isFinite(atMs)) return undefined
  const host = `host/${hostname()}`
  if (admittedEpoch !== undefined && admittedEpoch.host !== host) return undefined
  const spawner = yield* ChildProcessSpawner
  let capturedBytes = 0

  const capture = Effect.fn('store.captureWorkspaceActivity')(function* (
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const handle = yield* spawner.spawn(ChildProcess.make(command, args))
    const bounded = (stream: typeof handle.stdout, limit: number, retain: boolean) => {
      let bytes = 0
      const parts: Uint8Array[] = []
      return stream.pipe(Stream.runForEach((part) => {
        bytes += part.byteLength
        capturedBytes += part.byteLength
        if (bytes > limit || capturedBytes > CAPTURE_BYTES) {
          return Effect.fail(unavailable('Activity capture exceeds byte limit'))
        }
        if (retain) parts.push(part)
        return Effect.void
      }), Effect.flatMap(() => Effect.try({
        try: () => {
          if (!retain) return ''
          const decoder = new TextDecoder('utf-8', { fatal: true })
          return parts.map((part) => decoder.decode(part, { stream: true })).join('') + decoder.decode()
        },
        catch: () => unavailable('Activity command returned invalid UTF-8'),
      })))
    }
    const [stdout, , exitCode] = yield* Effect.all([
      bounded(handle.stdout, COMMAND_BYTES, true),
      bounded(handle.stderr, 64 * 1024, false),
      handle.exitCode,
    ], { concurrency: 3 })
    if (exitCode !== 0) return yield* unavailable('Activity command failed')
    return stdout
  })
  const commandJson = <TType, TEncoded>(
    command: string,
    args: ReadonlyArray<string>,
    schema: Schema.Codec<TType, TEncoded>,
  ) =>
    capture(command, args).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
      Effect.scoped,
      Effect.timeout('5 seconds'),
    )

  const read = Effect.gen(function* () {
    const agents: Array<typeof Agent.Type> = []
    const ids = new Set<string>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    let snapshotId: string | undefined
    // Native cursors pin a single page snapshot. Never compare its store index
    // with a later capture: normal agent activity changes it continuously.
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = yield* commandJson('st3', [
        'agents', 'ls', '--all', '--json', '--limit', '100', '--daemon-wait', '0',
        ...(cursor === undefined ? [] : ['--cursor', cursor]),
      ], AgentPage)
      const createdAt = DateTime.toEpochMillis(page.snapshot.created_at)
      if (page.snapshot.host_id !== host || !Number.isFinite(createdAt) ||
        createdAt < atMs - SNAPSHOT_MAX_AGE_MS || createdAt > atMs + 5000 ||
        (snapshotId !== undefined && page.snapshot.id !== snapshotId)) {
        return yield* unavailable('Activity snapshot is stale or from another host/epoch')
      }
      snapshotId = page.snapshot.id
      // st3 omits the advisory sync decoration when there is no advisory. A
      // present incoming backlog cannot establish complete foreign activity.
      const sync = page.value.sync
      if (sync !== undefined && !(sync.state === 'catching-up' && sync.peers !== undefined &&
        sync.peers.length > 0 && sync.peers.every((peer) => peer.peer_only_envelopes === 0))) {
        return yield* unavailable('Activity replication evidence is incomplete')
      }
      for (const agent of page.value.items) {
        if (ids.has(agent.id)) return yield* unavailable('Duplicate agent in activity pagination')
        ids.add(agent.id)
        agents.push(agent)
      }
      const next = page.value.page.next_cursor
      if (!page.value.page.has_more) {
        if (next !== null) return yield* unavailable('Activity page has inconsistent cursor')
        break
      }
      if (next === null || cursors.has(next) || page.value.items.length === 0 || pageNumber === 99) {
        return yield* unavailable('Activity pagination is incomplete')
      }
      cursors.add(next)
      cursor = next
    }

    // Only the explicitly stopped historical projection is enough to avoid a
    // subject read. Unknown states still require the authoritative actual.
    const subjects = yield* Effect.forEach(agents.filter((agent) => !(agent.state === 'stopped' &&
      agent.operational?.layer === 'history' && agent.operational.actionable === false)),
    (agent) => commandJson('st3', ['subject', 'show', agent.id, '--json', '--daemon-wait', '0'], Subject).pipe(
      Effect.flatMap((result) => {
        if (result.status.subjects.length !== 1 || result.status.subjects[0]?.subject !== agent.id) {
          return Effect.fail(unavailable('Activity subject is missing or ambiguous'))
        }
        return Effect.succeed(result.status.subjects[0].actual)
      }),
    ), { concurrency: 8 })
    // true means local evidence requires the path; false is foreign-only.
    const rawPaths = new Map<string, boolean>()
    for (const actual of subjects) {
      if (actual === null) return yield* unavailable('Activity subject has no actual observation')
      // `terminal` means a terminal exists, NOT that the process has exited.
      // stopped/exited are final runtime states; waiting/idle/suspended and
      // unknown future statuses remain protected, regardless of host.
      if (actual.status === 'stopped' || actual.status === 'exited') continue
      if (actual.workspace === undefined || actual.workspace === null ||
        actual.host === undefined || actual.host === null) {
        return yield* unavailable('Active agent has incomplete workspace evidence')
      }
      const actualHost = actual.host.startsWith('host/') ? actual.host : `host/${actual.host}`
      rawPaths.set(actual.workspace, actualHost === host || rawPaths.get(actual.workspace) === true)
    }
    const sessions = yield* commandJson('pty', ['list', '--json', '--tags'], PtySessions)
    const names = new Set<string>()
    for (const session of sessions) {
      if (names.has(session.name)) return yield* unavailable('Duplicate PTY activity record')
      names.add(session.name)
      if (session.status === 'running') {
        if (session.pid === null) return yield* unavailable('Running PTY has no process')
        rawPaths.set(session.cwd, true)
      }
    }
    // A foreign host can have a workspace absent from this host's filesystem.
    // Keep foreign paths that exist here (shared/migration leftovers), but only
    // a definite absence may be ignored. Permission/canonicalization failures
    // remain unknown; local agents and local PTYs always require their path.
    const paths = yield* Effect.forEach(rawPaths, ([path, required]) => fs.realPath(path).pipe(
      Effect.catch((error) => required ? Effect.fail(error) : fs.exists(path).pipe(
        Effect.flatMap((exists) => exists ? Effect.fail(error) : Effect.succeed(undefined)),
      )),
    ), { concurrency: 8 })
    const activePaths = new Set<string>()
    for (const path of paths) {
      if (path === undefined) continue
      if (!isAbsolute(path)) return yield* unavailable('Noncanonical workspace path')
      activePaths.add(path)
    }
    return { activePaths, epoch: { host } }
  })
  return yield* read.pipe(Effect.timeout(CAPTURE_TIMEOUT_MS), Effect.orElseSucceed(() => undefined))
})
