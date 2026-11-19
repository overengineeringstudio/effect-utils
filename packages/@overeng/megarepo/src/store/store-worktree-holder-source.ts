import { join } from 'node:path'

import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import {
  parseProcStat,
  type InUseResult,
  type ProcessIdentity,
  type ProcessReference,
} from './store-inuse.ts'
import { readDirectoryEvidence, type OwnedDeletionPins } from './store-pinned-deletion.ts'
import {
  captureWorktreeHolderEvidence,
  isWorktreeHolderEvidenceFresh,
} from './store-worktree-holder-client.ts'
import type {
  WorktreeHolderEvidence,
  WorktreeHolderEvidenceClientConfig,
} from './store-worktree-holder-codec.ts'

/** Coverage is deliberately path-scoped, never a globally complete process scan. */
export interface WorktreeHolderObservation {
  readonly complete: boolean
  readonly references: ReadonlyArray<ProcessReference>
  readonly processIdentities: ReadonlyArray<ProcessIdentity>
  readonly excludedProcesses: ReadonlyArray<ProcessIdentity>
  readonly inUse: InUseResult
}

export interface WorktreeHolderSource {
  readonly read: (options: {
    readonly worktreePath: string
    /** Exact discovered daemon leader lifetimes selected for shutdown and final probing. */
    readonly ignoredProcesses?: ReadonlyArray<ProcessIdentity> | undefined
    /** Only the actual enclosing native beforeRemove callback can mint this view. */
    readonly ownedPins?: OwnedDeletionPins | undefined
  }) => Effect.Effect<WorktreeHolderObservation, never, FileSystem.FileSystem>
}

const unknown = (): WorktreeHolderObservation => ({
  complete: false,
  references: [],
  processIdentities: [],
  excludedProcesses: [],
  inUse: { _tag: 'unknown', reason: 'scan-failed' },
})

/** Reuse no-follow fstat/fdinfo evidence; no second mount parser or per-root mount census. */
const rootIdentityMatches = Effect.fn('store.holderRootIdentityMatches')(function* (
  root: WorktreeHolderEvidence['roots'][number],
) {
  const fs = yield* FileSystem.FileSystem
  if (process.platform !== 'linux' || root.identity === null) return false
  if ((yield* fs.realPath(root.path)) !== root.path) return false
  const before = yield* Effect.try(() => readDirectoryEvidence(root.path))
  const after = yield* Effect.try(() => readDirectoryEvidence(root.path))
  if ((yield* fs.realPath(root.path)) !== root.path) return false
  return (
    before.mountId === root.identity.mountId &&
    before.stat.dev.toString() === root.identity.dev &&
    before.stat.ino.toString() === root.identity.ino &&
    after.mountId === before.mountId &&
    after.stat.dev === before.stat.dev &&
    after.stat.ino === before.stat.ino
  )
})

/** Pure policy after current-host/root admission; never an authentication or deletion capability. */
export const classifyWorktreeHolderEvidence = ({
  evidence,
  worktreePath,
  ignoredProcesses,
  ownUid,
  admitted,
  ownedPins,
  ownStartTime,
}: {
  readonly evidence: WorktreeHolderEvidence
  readonly worktreePath: string
  readonly ignoredProcesses?: ReadonlyArray<ProcessIdentity> | undefined
  readonly ownUid: number | undefined
  readonly admitted: boolean
  readonly ownedPins?: OwnedDeletionPins | undefined
  readonly ownStartTime?: string | undefined
}): WorktreeHolderObservation => {
  const root = evidence.roots.find((entry) => entry.path === worktreePath)
  if (root === undefined) return unknown()
  const complete =
    admitted &&
    evidence.scope.complete &&
    root.complete &&
    root.identity !== null &&
    root.referencesComplete &&
    root.status !== 'unknown' &&
    root.unknownReasons.length === 0
  const excluded = complete
    ? root.references.filter((reference) => {
        const leader =
          reference.tid === reference.tgid && reference.taskStart === reference.leaderStart
        const ownIdentity = ownUid !== undefined && reference.uid.every((uid) => uid === ownUid)
        const ownedFd =
          leader &&
          ownIdentity &&
          ownStartTime !== undefined &&
          reference.leaderStart === ownStartTime &&
          ownedPins?.has({
            kind: reference.reference,
            pid: reference.tgid,
            fd: reference.fd,
            dev: reference.identity.dev,
            ino: reference.identity.ino,
          }) === true
        const selectedDaemon =
          leader &&
          ownIdentity &&
          (reference.reference === 'cwd' || reference.reference === 'root') &&
          ignoredProcesses?.some(
            (identity) =>
              identity.pid === reference.tgid && identity.startTime === reference.leaderStart,
          ) === true
        return ownedFd || selectedDaemon
      })
    : []
  const excludedSet = new Set(excluded)
  const references = root.references
    .filter((reference) => !excludedSet.has(reference))
    .map((reference) => ({
      pid: reference.tgid,
      kind: reference.reference === 'exe' ? ('map' as const) : reference.reference,
      path: reference.relativePath === '.' ? root.path : join(root.path, reference.relativePath),
    }))
  const holder = references[0]
  return {
    complete,
    references,
    processIdentities: root.references.map((reference) => ({
      pid: reference.tgid,
      startTime: reference.leaderStart,
    })),
    // Exact fd ownership is not a process-lifetime exemption in receipt metadata.
    excludedProcesses: excluded
      .filter((reference) => reference.reference === 'cwd' || reference.reference === 'root')
      .map((reference) => ({ pid: reference.tgid, startTime: reference.leaderStart })),
    inUse:
      holder !== undefined
        ? { _tag: 'in-use', holder: { pid: holder.pid, path: holder.path } }
        : complete && (root.status === 'no-current-reference' || excluded.length > 0)
          ? { _tag: 'free' }
          : { _tag: 'unknown', reason: 'scan-failed' },
  }
}

/** Capture selected roots once. Action callers create a new source under their deletion lease. */
export const makeWorktreeHolderSource = Effect.fn('store.makeWorktreeHolderSource')(function* ({
  client,
  paths,
}: {
  readonly client: WorktreeHolderEvidenceClientConfig
  readonly paths: ReadonlyArray<string>
}): Effect.fn.Return<WorktreeHolderSource, never, FileSystem.FileSystem | ChildProcessSpawner> {
  const evidence = yield* captureWorktreeHolderEvidence({ client, paths })
  const read: WorktreeHolderSource['read'] = ({ worktreePath, ignoredProcesses, ownedPins }) =>
    Effect.gen(function* () {
      if (evidence === undefined || !(yield* isWorktreeHolderEvidenceFresh(evidence)))
        return unknown()
      const fs = yield* FileSystem.FileSystem
      const ownStartTime =
        ownedPins === undefined
          ? undefined
          : yield* fs.readFileString(`/proc/${process.pid}/stat`).pipe(
              Effect.map((stat) => parseProcStat(stat)?.startTime),
              Effect.orElseSucceed(() => undefined),
            )
      const root = evidence.roots.find((entry) => entry.path === worktreePath)
      if (root === undefined) return unknown()
      const identityMatches =
        (yield* rootIdentityMatches(root).pipe(Effect.orElseSucceed(() => false))) &&
        (yield* isWorktreeHolderEvidenceFresh(evidence))
      return classifyWorktreeHolderEvidence({
        evidence,
        worktreePath,
        ignoredProcesses,
        ownedPins,
        ownStartTime,
        ownUid: process.getuid?.(),
        admitted: identityMatches,
      })
    })
  return { read }
})
