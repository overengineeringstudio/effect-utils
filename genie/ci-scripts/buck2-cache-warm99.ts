#!/usr/bin/env bun
/**
 * Bun glue intentionally shares the producer's TypeScript wire contract; no new dependency.
 * Usage: bun genie/ci-scripts/buck2-cache-warm99.ts --manifest manifest.json
 * Manifest v1 explicitly enumerates enabledLanes and chronological observations:
 * {schemaVersion:1,enabledLanes:['main-reader'],observations:[{id:'run-1',sequence:1,
 * writers:[{lane:'main-writer',summary:'writer.json',actions:'buck2-cache-actions.jsonl.gz'}],
 * readers:[{lane:'main-reader',summary:'reader.json',actions:'reader-actions.jsonl.gz'}],
 * nixSubstitution:{substituted:0,built:0}}]}.
 * Paths resolve relative to the manifest. Sequence strictly increases; IDs are unique.
 * Output v1 contains accepted, lanes[{lane,accepted,consecutive,observations:[...]}].
 * Acceptance is the final two consecutive complete observations >=99%, not historic success.
 * Eligible/hit/cold/changed buckets deduplicate identities; buckets can overlap across reader starts.
 * Noncacheable counts noncommand rows plus deduplicated noncacheable command identities.
 * Exclusions/uploads/gaps count rows or missing artifacts. Replayed native readers never pass.
 * Nix substitution is reported separately and never contributes to native acceptance.
 */
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { gunzipSync } from 'node:zlib'

import {
  boolean,
  decodeActionArtifact,
  field,
  integer,
  invalid,
  lane,
  list,
  text,
} from './buck2-action-evidence-codec.ts'
import { decodeCacheAdmissionEvidence } from './buck2-cache-evidence.ts'
import {
  actionsArtifactName,
  cacheOutcomeMapping,
  invocationWithinJobWindow,
  maxActionArtifactBytes,
  type ActionArtifact,
  type ActionRecord,
  type CacheLane,
} from './buck2-action-evidence.ts'

export type ArtifactReference = { lane: CacheLane; summary: string; actions: string }
export type Observation = {
  id: string
  sequence: number
  writers: ArtifactReference[]
  readers: ArtifactReference[]
  nixSubstitution: { substituted: number; built: number }
}
export type WarmManifest = {
  schemaVersion: 1
  enabledLanes: CacheLane[]
  observations: Observation[]
}
export type LaneObservation = {
  id: string
  sequence: number
  complete: boolean
  eligible: number
  remoteHits: number
  hitRate: number | null
  cold: number
  changed: number
  excluded: number
  noncacheable: number
  uploadFailure: number
  evidenceGap: number
  nixSubstitution: { substituted: number; built: number }
  meetsThreshold: boolean
}
export type WarmReport = {
  schemaVersion: 1
  accepted: boolean
  lanes: {
    lane: CacheLane
    accepted: boolean
    consecutive: number
    observations: LaneObservation[]
  }[]
}
export const decodeManifest = (value: unknown): WarmManifest => {
  if (field(value, 'schemaVersion') !== 1) return invalid()
  const enabledLanes = list(field(value, 'enabledLanes')).map(lane)
  if (enabledLanes.length === 0 || new Set(enabledLanes).size !== enabledLanes.length)
    return invalid()
  const reference = (item: unknown): ArtifactReference => ({
    lane: lane(field(item, 'lane')),
    summary: text(field(item, 'summary')),
    actions: text(field(item, 'actions')),
  })
  const ids = new Set<string>()
  let previous = -1
  const observations = list(field(value, 'observations')).map((item): Observation => {
    const id = text(field(item, 'id'))
    const sequence = integer(field(item, 'sequence'))
    if (!/^[a-zA-Z0-9_.:-]{1,96}$/.test(id) || ids.has(id) || sequence <= previous) return invalid()
    ids.add(id)
    previous = sequence
    const nix = field(item, 'nixSubstitution')
    const writers = list(field(item, 'writers')).map(reference)
    const readers = list(field(item, 'readers')).map(reference)
    if (readers.some((reader) => !enabledLanes.includes(reader.lane))) return invalid()
    const paths = [...writers, ...readers].map((ref) => ref.actions)
    if (new Set(paths).size !== paths.length) return invalid()
    return {
      id,
      sequence,
      writers,
      readers,
      nixSubstitution: {
        substituted: integer(field(nix, 'substituted')),
        built: integer(field(nix, 'built')),
      },
    }
  })
  return { schemaVersion: 1, enabledLanes, observations }
}

/** Verify compressed bytes before decoding, and bind summary to full artifact rows/counts. */
export const decodeEvidence = (
  compressed: Uint8Array,
  summary: unknown,
  expectedLane: CacheLane,
): ActionArtifact => {
  decodeCacheAdmissionEvidence(summary)
  const metadata = field(summary, 'actionsArtifact')
  if (
    field(summary, 'schemaVersion') !== 1 ||
    field(summary, 'cacheOutcomeMapping') !== cacheOutcomeMapping ||
    field(metadata, 'name') !== actionsArtifactName
  )
    return invalid()
  const sha = text(field(metadata, 'sha256'))
  if (!/^[a-f0-9]{64}$/.test(sha) || createHash('sha256').update(compressed).digest('hex') !== sha)
    return invalid()
  const uncompressed = gunzipSync(compressed, {
    maxOutputLength: maxActionArtifactBytes + 1024 * 1024,
  })
  // Fatal UTF-8 decoding avoids replacement characters turning damaged evidence into valid JSON.
  const artifact = decodeActionArtifact(
    new TextDecoder('utf-8', { fatal: true }).decode(uncompressed),
  )
  if (
    integer(field(metadata, 'rows')) !== artifact.header.rows ||
    integer(field(summary, 'actionCount')) !== artifact.header.actionCount
  )
    return invalid()
  for (const [key, actual] of [
    ['bytes', compressed.length],
    ['uncompressedBytes', uncompressed.length],
  ] as const) {
    const value = field(metadata, key)
    if (value !== undefined && integer(value) !== actual) return invalid()
  }
  const complete = field(metadata, 'complete')
  if (complete !== undefined && boolean(complete) !== artifact.header.complete) return invalid()
  const dropped = field(metadata, 'droppedActionCount')
  if (dropped !== undefined && integer(dropped) !== 0) return invalid()
  if (
    field(summary, 'status') !== artifact.header.status ||
    artifact.header.metadata.lane !== expectedLane
  )
    return invalid()
  const counts = field(summary, 'counts')
  let total = 0
  for (const outcome of [
    'remote-hit',
    'local',
    'uploaded',
    'local-cache',
    'remote-execution',
    'remote-dep-file-hit',
    'other',
  ]) {
    const n = integer(field(counts, outcome))
    if (n !== artifact.actions.filter((action) => action.outcome === outcome).length)
      return invalid()
    total += n
  }
  if (total !== artifact.actions.length) return invalid()
  const invocations = list(field(summary, 'invocations'))
  if (invocations.length !== artifact.header.invocations.length) return invalid()
  for (const invocation of artifact.header.invocations) {
    const matches = invocations.filter((item) => field(item, 'buildId') === invocation.buildId)
    if (
      matches.length !== 1 ||
      integer(field(matches[0], 'actionCount')) !== invocation.actionCount
    )
      return invalid()
  }
  return artifact
}
const identity = (action: ActionRecord): string | undefined =>
  action.category !== null &&
  action.target !== null &&
  action.configuration !== null &&
  action.digest !== null
    ? JSON.stringify([action.category, action.target, action.configuration, action.digest])
    : undefined
const baseIdentity = (action: ActionRecord): string =>
  JSON.stringify([action.category, action.target, action.configuration])
const completeArtifact = (artifact: ActionArtifact, writer: boolean): boolean => {
  const h = artifact.header
  // Reader means an observed lookup, not a read-only cache credential: queue jobs also write.
  const { lane: cacheLane, posture } = h.metadata
  const lanePostureValid =
    cacheLane === 'main-writer'
      ? posture === 'writer'
      : cacheLane === 'main-reader' || cacheLane === 'pr'
        ? posture === 'read-only'
        : cacheLane === 'merge_group' && (posture === 'writer' || posture === 'read-only')
  return (
    h.complete &&
    h.status === 'collected' &&
    h.evidenceGaps.length === 0 &&
    h.droppedActionCount === 0 &&
    h.metadata.repo !== null &&
    h.metadata.runId !== null &&
    h.metadata.runAttempt !== null &&
    h.metadata.job !== null &&
    h.metadata.headSha !== null &&
    h.metadata.startedAt !== null &&
    h.metadata.finishedAt !== null &&
    h.metadata.finishedAt >= h.metadata.startedAt &&
    lanePostureValid &&
    (!writer ||
      (posture === 'writer' && (cacheLane === 'main-writer' || cacheLane === 'merge_group'))) &&
    h.invocations.length > 0 &&
    h.invocations.every((inv) => inv.complete && invocationWithinJobWindow(inv, h.metadata)) &&
    (writer || h.invocations.some((inv) => inv.freshRoot)) &&
    artifact.actions.every(
      (a) =>
        !a.commandAction ||
        ((identity(a) !== undefined ||
          (a.executionKind === 10 &&
            a.digest === null &&
            a.category !== null &&
            a.target !== null &&
            a.configuration !== null &&
            a.uploadOutcome !== 'uploaded' &&
            h.invocations.some((inv) => inv.buildId === a.buildId && !inv.freshRoot))) &&
          a.startedAt !== null &&
          a.completedAt !== null &&
          a.endTime !== null &&
          (a.uploadOutcome !== 'uploaded' || a.uploadCompletedAt !== null)),
    )
  )
}
export type LoadedObservation = {
  observation: Observation
  writers: (ActionArtifact | undefined)[]
  readers: (ActionArtifact | undefined)[]
}
export const evaluateWarm99 = (manifest: WarmManifest, loaded: LoadedObservation[]): WarmReport => {
  if (
    loaded.length !== manifest.observations.length ||
    loaded.some(
      (item, i) =>
        item.observation.id !== manifest.observations[i]?.id ||
        item.observation.sequence !== manifest.observations[i]?.sequence,
    )
  )
    return invalid()
  const lanes = manifest.enabledLanes.map((enabledLane) => {
    let consecutive = 0
    const seenReaderIds = new Set<string>()
    let observedRepo: string | undefined
    const observations = loaded.map(({ observation, writers, readers }): LaneObservation => {
      const result: LaneObservation = {
        id: observation.id,
        sequence: observation.sequence,
        complete: true,
        eligible: 0,
        remoteHits: 0,
        hitRate: null,
        cold: 0,
        changed: 0,
        excluded: 0,
        noncacheable: 0,
        uploadFailure: 0,
        evidenceGap: 0,
        nixSubstitution: observation.nixSubstitution,
        meetsThreshold: false,
      }
      if (
        writers.length !== observation.writers.length ||
        readers.length !== observation.readers.length
      )
        return invalid()
      const uploads = new Map<string, number>()
      const uploadedBases = new Map<string, number>()
      for (const [index, artifact] of writers.entries()) {
        result.uploadFailure +=
          artifact?.actions.filter((action) => action.uploadOutcome === 'failed').length ?? 0
        if (
          artifact === undefined ||
          artifact.header.metadata.lane !== observation.writers[index]?.lane ||
          !completeArtifact(artifact, true)
        ) {
          result.complete = false
          result.evidenceGap++
          continue
        }
        for (const action of artifact.actions) {
          const key = identity(action)
          if (
            !action.commandAction ||
            key === undefined ||
            action.uploadOutcome !== 'uploaded' ||
            action.uploadCompletedAt === null
          )
            continue
          uploads.set(key, Math.min(uploads.get(key) ?? Infinity, action.uploadCompletedAt))
          const base = baseIdentity(action)
          uploadedBases.set(
            base,
            Math.min(uploadedBases.get(base) ?? Infinity, action.uploadCompletedAt),
          )
        }
      }
      const writerRepos = new Set(
        writers.flatMap((artifact) =>
          artifact?.header.metadata.repo === null || artifact === undefined
            ? []
            : [artifact.header.metadata.repo],
        ),
      )
      if (writerRepos.size > 1) {
        result.complete = false
        result.evidenceGap++
      }
      const outcomes = new Map<string, boolean>()
      const cold = new Set<string>()
      const changedIdentities = new Set<string>()
      const noncacheableIdentities = new Set<string>()
      const expected = observation.readers
        .map((ref, index) => ({ ref, artifact: readers[index] }))
        .filter(({ ref }) => ref.lane === enabledLane)
      if (expected.length === 0) {
        result.complete = false
        result.evidenceGap++
      }
      for (const { artifact } of expected) {
        result.uploadFailure +=
          artifact?.actions.filter((action) => action.uploadOutcome === 'failed').length ?? 0
        if (artifact?.header.metadata.posture === 'disabled-by-design')
          result.excluded += artifact.actions.length
        if (
          artifact === undefined ||
          artifact.header.metadata.lane !== enabledLane ||
          !completeArtifact(artifact, false)
        ) {
          result.complete = false
          result.evidenceGap++
          continue
        }
        const repo = artifact.header.metadata.repo
        if (
          repo === null ||
          (observedRepo !== undefined && observedRepo !== repo) ||
          [...writerRepos].some((writerRepo) => writerRepo !== repo)
        ) {
          result.complete = false
          result.evidenceGap++
          continue
        }
        observedRepo = repo
        const ids = artifact.header.invocations.map((invocation) =>
          JSON.stringify([repo, invocation.buildId]),
        )
        const replayed = ids.some((id) => seenReaderIds.has(id))
        for (const id of ids) seenReaderIds.add(id)
        if (replayed) {
          result.complete = false
          result.evidenceGap++
          continue
        }
        for (const action of artifact.actions) {
          const invocation = artifact.header.invocations.find(
            (inv) => inv.buildId === action.buildId,
          )
          if (invocation === undefined || invocation.startedAt === null) {
            result.complete = false
            result.evidenceGap++
            continue
          }
          if (!invocation.freshRoot) {
            result.excluded++
            continue
          }
          if (!action.commandAction) {
            result.noncacheable++
            continue
          }
          const key = identity(action)
          if (key === undefined) {
            result.complete = false
            result.evidenceGap++
            continue
          }
          const eligible = (uploads.get(key) ?? Infinity) < invocation.startedAt
          const noncacheable =
            action.executionKind === 0 || action.executionKind === 4 || action.executionKind === 6
          if (eligible) {
            outcomes.set(key, action.executionKind === 3 && (outcomes.get(key) ?? true))
          } else if ((uploadedBases.get(baseIdentity(action)) ?? Infinity) < invocation.startedAt) {
            changedIdentities.add(key)
          } else if (noncacheable) {
            noncacheableIdentities.add(key)
          } else {
            cold.add(key)
          }
        }
      }
      for (const remote of outcomes.values()) {
        result.eligible++
        if (remote) result.remoteHits++
      }
      result.cold = cold.size
      result.changed = changedIdentities.size
      result.noncacheable += noncacheableIdentities.size
      result.hitRate = result.eligible === 0 ? null : result.remoteHits / result.eligible
      result.meetsThreshold =
        result.complete && result.eligible > 0 && result.remoteHits * 100 >= result.eligible * 99
      consecutive = result.meetsThreshold ? consecutive + 1 : 0
      return result
    })
    return { lane: enabledLane, accepted: consecutive >= 2, consecutive, observations }
  })
  return { schemaVersion: 1, accepted: lanes.every((item) => item.accepted), lanes }
}
export const loadAndEvaluate = async (manifestPath: string): Promise<WarmReport> => {
  const manifest = decodeManifest(await Bun.file(manifestPath).json())
  const root = dirname(resolve(manifestPath))
  const load = async (ref: ArtifactReference): Promise<ActionArtifact | undefined> => {
    try {
      return decodeEvidence(
        new Uint8Array(await Bun.file(resolve(root, ref.actions)).arrayBuffer()),
        await Bun.file(resolve(root, ref.summary)).json(),
        ref.lane,
      )
    } catch {
      return undefined
    }
  }
  const loaded: LoadedObservation[] = []
  for (const observation of manifest.observations) {
    const writers: (ActionArtifact | undefined)[] = []
    const readers: (ActionArtifact | undefined)[] = []
    for (const ref of observation.writers) writers.push(await load(ref))
    for (const ref of observation.readers) readers.push(await load(ref))
    loaded.push({ observation, writers, readers })
  }
  return evaluateWarm99(manifest, loaded)
}
if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: Bun.argv.slice(2),
      strict: true,
      options: { manifest: { type: 'string' } },
    })
    if (values.manifest === undefined) invalid()
    const report = await loadAndEvaluate(values.manifest)
    console.log(JSON.stringify(report))
    if (!report.accepted) process.exitCode = 1
  } catch {
    console.error('Warm cache evaluation failed: invalid manifest or evidence.')
    process.exitCode = 1
  }
}
