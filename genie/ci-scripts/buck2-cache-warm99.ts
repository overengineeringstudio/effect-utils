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
 * Artifact files load independently in parallel while retaining manifest and reference order.
 */
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { gunzipSync } from 'node:zlib'

import {
  boolean,
  decodeActionArtifact,
  decodeActionExclusionCounts,
  field,
  integer,
  invalid,
  lane,
  list,
  text,
} from './buck2-action-evidence-codec.ts'
import {
  actionExclusionReason,
  actionExclusionReasons,
  countActionExclusions,
  actionsArtifactName,
  cacheOutcomeMapping,
  invocationWithinJobWindow,
  maxActionArtifactBytes,
  zeroActionExclusionCounts,
  type ActionExclusionCounts,
  type ActionArtifact,
  type ActionRecord,
  type CacheLane,
} from './buck2-action-evidence.ts'
import { decodeCacheAdmissionEvidence } from './buck2-cache-evidence.ts'

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
  excludedByDesign: ActionExclusionCounts
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
const reference = (item: unknown): ArtifactReference => ({
  lane: lane(field({ value: item, key: 'lane' })),
  summary: text(field({ value: item, key: 'summary' })),
  actions: text(field({ value: item, key: 'actions' })),
})
export const decodeManifest = (value: unknown): WarmManifest => {
  if (field({ value: value, key: 'schemaVersion' }) !== 1) return invalid()
  const enabledLanes = list(field({ value: value, key: 'enabledLanes' })).map(lane)
  if (enabledLanes.length === 0 || new Set(enabledLanes).size !== enabledLanes.length)
    return invalid()
  const ids = new Set<string>()
  let previous = -1
  const observations = list(field({ value: value, key: 'observations' })).map(
    (item): Observation => {
      const id = text(field({ value: item, key: 'id' }))
      const sequence = integer(field({ value: item, key: 'sequence' }))
      if (
        /^[a-zA-Z0-9_.:-]{1,96}$/.test(id) !== true ||
        ids.has(id) === true ||
        sequence <= previous
      )
        return invalid()
      ids.add(id)
      previous = sequence
      const nix = field({ value: item, key: 'nixSubstitution' })
      const writers = list(field({ value: item, key: 'writers' })).map(reference)
      const readers = list(field({ value: item, key: 'readers' })).map(reference)
      if (readers.some((reader) => enabledLanes.includes(reader.lane) !== true) === true)
        return invalid()
      const paths = [...writers, ...readers].map((ref) => ref.actions)
      if (new Set(paths).size !== paths.length) return invalid()
      return {
        id,
        sequence,
        writers,
        readers,
        nixSubstitution: {
          substituted: integer(field({ value: nix, key: 'substituted' })),
          built: integer(field({ value: nix, key: 'built' })),
        },
      }
    },
  )
  return { schemaVersion: 1, enabledLanes, observations }
}

/** Verify compressed bytes before decoding, and bind summary to full artifact rows/counts. */
export const decodeEvidence = ({
  compressed,
  summary,
  expectedLane,
}: {
  compressed: Uint8Array
  summary: unknown
  expectedLane?: CacheLane
}): ActionArtifact => {
  decodeCacheAdmissionEvidence(summary)
  const metadata = field({ value: summary, key: 'actionsArtifact' })
  if (
    field({ value: summary, key: 'schemaVersion' }) !== 1 ||
    field({ value: summary, key: 'cacheOutcomeMapping' }) !== cacheOutcomeMapping ||
    field({ value: metadata, key: 'name' }) !== actionsArtifactName
  )
    return invalid()
  const sha = text(field({ value: metadata, key: 'sha256' }))
  if (
    /^[a-f0-9]{64}$/.test(sha) !== true ||
    createHash('sha256').update(compressed).digest('hex') !== sha
  )
    return invalid()
  const uncompressed = gunzipSync(compressed, {
    maxOutputLength: maxActionArtifactBytes + 1024 * 1024,
  })
  // Fatal UTF-8 decoding avoids replacement characters turning damaged evidence into valid JSON.
  const artifact = decodeActionArtifact(
    new TextDecoder('utf-8', { fatal: true }).decode(uncompressed),
  )
  if (
    integer(field({ value: metadata, key: 'rows' })) !== artifact.header.rows ||
    integer(field({ value: summary, key: 'actionCount' })) !== artifact.header.actionCount
  )
    return invalid()
  for (const [key, actual] of [
    ['bytes', compressed.length],
    ['uncompressedBytes', uncompressed.length],
  ] as const) {
    const value = field({ value: metadata, key: key })
    if (value !== undefined && integer(value) !== actual) return invalid()
  }
  const complete = field({ value: metadata, key: 'complete' })
  if (complete !== undefined && boolean(complete) !== artifact.header.complete) return invalid()
  const dropped = field({ value: metadata, key: 'droppedActionCount' })
  if (dropped !== undefined && integer(dropped) !== 0) return invalid()
  if (
    field({ value: summary, key: 'status' }) !== artifact.header.status ||
    (expectedLane !== undefined && artifact.header.metadata.lane !== expectedLane)
  )
    return invalid()
  const counts = field({ value: summary, key: 'counts' })
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
    const n = integer(field({ value: counts, key: outcome }))
    if (n !== artifact.actions.filter((action) => action.outcome === outcome).length)
      return invalid()
    total += n
  }
  if (total !== artifact.actions.length) return invalid()
  const excludedByDesign = field({ value: summary, key: 'excludedByDesign' })
  if (excludedByDesign !== undefined) {
    const declared = decodeActionExclusionCounts(excludedByDesign)
    if (
      actionExclusionReasons.some(
        (reason) => declared[reason] !== artifact.header.excludedByDesign[reason],
      ) === true
    )
      return invalid()
  }
  const invocations = list(field({ value: summary, key: 'invocations' }))
  if (invocations.length !== artifact.header.invocations.length) return invalid()
  for (const invocation of artifact.header.invocations) {
    const matches = invocations.filter(
      (item) => field({ value: item, key: 'buildId' }) === invocation.buildId,
    )
    if (
      matches.length !== 1 ||
      integer(field({ value: matches[0], key: 'actionCount' })) !== invocation.actionCount
    )
      return invalid()
    const exclusions = field({ value: matches[0], key: 'excludedByDesign' })
    if (exclusions !== undefined) {
      const declared = decodeActionExclusionCounts(exclusions)
      if (
        actionExclusionReasons.some(
          (reason) => declared[reason] !== invocation.excludedByDesign[reason],
        ) === true
      )
        return invalid()
    }
  }
  return artifact
}
export const identity = (action: ActionRecord): string | undefined =>
  action.category !== null &&
  action.target !== null &&
  action.configuration !== null &&
  action.digest !== null
    ? JSON.stringify([action.category, action.target, action.configuration, action.digest])
    : undefined
const baseIdentity = (action: ActionRecord): string =>
  JSON.stringify([action.category, action.target, action.configuration])
const rootScope = (rootId: string | undefined): string => JSON.stringify(rootId ?? null)
const ambiguousLegacyRoots = (artifact: ActionArtifact): boolean =>
  artifact.header.invocations.filter((invocation) => invocation.freshRoot).length > 1 &&
  artifact.header.invocations.some((invocation) => invocation.rootId === undefined)

/** A configured action key proves local reuse, never an inferred RE action digest. */
const localActionRepetitions = (artifact: ActionArtifact): Set<ActionRecord> => {
  const repetitions = new Set<ActionRecord>()
  if (
    artifact.actions.some((action) => action.executionKind === 10) === false ||
    ambiguousLegacyRoots(artifact) === true
  )
    return repetitions
  const invocations = new Map(
    artifact.header.invocations.map((invocation) => [invocation.buildId, invocation]),
  )
  const freshRoots = new Set(
    artifact.header.invocations
      .filter((invocation) => invocation.freshRoot)
      .map((invocation) => rootScope(invocation.rootId)),
  )
  const configuredKey = (action: ActionRecord): string | undefined => {
    const invocation = invocations.get(action.buildId)
    return invocation !== undefined &&
      freshRoots.has(rootScope(invocation.rootId)) === true &&
      action.target !== null &&
      action.category !== null &&
      action.configuration !== null &&
      typeof action.identifier === 'string'
      ? JSON.stringify([
          rootScope(invocation.rootId),
          action.target,
          action.category,
          action.identifier,
          action.configuration,
        ])
      : undefined
  }
  const completed = new Map<string, number>()
  for (const action of artifact.actions) {
    if (
      action.commandAction !== true ||
      action.executionKind === 10 ||
      identity(action) === undefined ||
      action.completedAt === null
    )
      continue
    const key = configuredKey(action)
    if (key !== undefined)
      completed.set(key, Math.min(completed.get(key) ?? Infinity, action.completedAt))
  }
  for (const action of artifact.actions) {
    if (action.executionKind !== 10 || action.startedAt === null) continue
    const key = configuredKey(action)
    if (key !== undefined && (completed.get(key) ?? Infinity) <= action.startedAt)
      repetitions.add(action)
  }
  return repetitions
}
export const completeArtifact = ({
  artifact,
  writer,
}: {
  artifact: ActionArtifact
  writer: boolean
}): boolean => {
  const h = artifact.header
  const localRepetitions = localActionRepetitions(artifact)
  const freshRoots = new Set(
    h.invocations
      .filter((invocation) => invocation.freshRoot)
      .map((invocation) => rootScope(invocation.rootId)),
  )
  // Reader means an observed lookup, not a read-only cache credential: queue jobs also write.
  const { lane: cacheLane, posture } = h.metadata
  const lanePostureValid =
    cacheLane === 'main-writer'
      ? posture === 'writer'
      : cacheLane === 'main-reader' || cacheLane === 'pr'
        ? posture === 'read-only'
        : cacheLane === 'merge_group' && (posture === 'writer' || posture === 'read-only')
  return (
    h.complete === true &&
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
    lanePostureValid === true &&
    (writer !== true ||
      (posture === 'writer' && (cacheLane === 'main-writer' || cacheLane === 'merge_group'))) &&
    h.invocations.length > 0 &&
    h.invocations.every(
      (inv) =>
        inv.complete === true &&
        invocationWithinJobWindow({ invocation: inv, metadata: h.metadata }) === true,
    ) === true &&
    (writer === true ||
      (!ambiguousLegacyRoots(artifact) &&
        h.invocations.length > 0 &&
        h.invocations.every((invocation) => freshRoots.has(rootScope(invocation.rootId))))) &&
    artifact.actions.every(
      (a) =>
        (a.commandAction !== true && a.executionKind !== 10) ||
        ((a.executionKind === 10 ? localRepetitions.has(a) : identity(a) !== undefined) &&
          a.startedAt !== null &&
          a.completedAt !== null &&
          a.endTime !== null &&
          (a.uploadOutcome !== 'uploaded' ||
            (identity(a) !== undefined && a.uploadCompletedAt !== null))),
    ) === true
  )
}
export type LoadedObservation = {
  observation: Observation
  writers: (ActionArtifact | undefined)[]
  readers: (ActionArtifact | undefined)[]
}
export const evaluateWarm99 = ({
  manifest,
  loaded,
}: {
  manifest: WarmManifest
  loaded: LoadedObservation[]
}): WarmReport => {
  if (
    loaded.length !== manifest.observations.length ||
    loaded.some(
      (item, i) =>
        item.observation.id !== manifest.observations[i]?.id ||
        item.observation.sequence !== manifest.observations[i]?.sequence,
    ) === true
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
        excludedByDesign: zeroActionExclusionCounts(),
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
          artifact?.actions.filter(
            (action) =>
              actionExclusionReason(action.category) === null && action.uploadOutcome === 'failed',
          ).length ?? 0
        if (
          artifact === undefined ||
          artifact.header.metadata.lane !== observation.writers[index]?.lane ||
          completeArtifact({ artifact, writer: true }) !== true
        ) {
          result.complete = false
          result.evidenceGap++
          continue
        }
        for (const action of artifact.actions) {
          const key = identity(action)
          if (
            artifact.header.invocations.find((inv) => inv.buildId === action.buildId)
              ?.cacheReadPolicy === 'disabled-by-design' ||
            actionExclusionReason(action.category) !== null ||
            action.commandAction !== true ||
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
          artifact?.actions.filter(
            (action) =>
              actionExclusionReason(action.category) === null && action.uploadOutcome === 'failed',
          ).length ?? 0
        const policyCounts = countActionExclusions(artifact?.actions ?? [])
        for (const reason of actionExclusionReasons)
          result.excludedByDesign[reason] += policyCounts[reason]
        const policyExcluded = actionExclusionReasons.reduce(
          (total, reason) => total + policyCounts[reason],
          0,
        )
        result.excluded +=
          artifact?.header.metadata.posture === 'disabled-by-design'
            ? artifact.actions.length
            : policyExcluded
        if (
          artifact === undefined ||
          artifact.header.metadata.lane !== enabledLane ||
          completeArtifact({ artifact, writer: false }) !== true
        ) {
          result.complete = false
          result.evidenceGap++
          continue
        }
        const repo = artifact.header.metadata.repo
        if (
          repo === null ||
          (observedRepo !== undefined && observedRepo !== repo) ||
          [...writerRepos].some((writerRepo) => writerRepo !== repo) === true
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
        if (replayed === true) {
          result.complete = false
          result.evidenceGap++
          continue
        }
        // Root scopes keep explicit two-root proofs distinct; legacy single-root artifacts
        // use the artifact's attestation without exposing a canonical host path.
        // Native rows are serialized by identity, so establish occurrence order explicitly.
        const seenIdentities = new Set<string>()
        const chronological = artifact.actions.toSorted(
          (left, right) => (left.startedAt ?? Infinity) - (right.startedAt ?? Infinity),
        )
        for (const action of chronological) {
          if (actionExclusionReason(action.category) !== null) continue
          const invocation = artifact.header.invocations.find(
            (inv) => inv.buildId === action.buildId,
          )
          if (invocation === undefined || invocation.startedAt === null) {
            result.complete = false
            result.evidenceGap++
            continue
          }
          // Cache-off controls do not consume the first cache-enabled occurrence.
          if (invocation.cacheReadPolicy === 'disabled-by-design') {
            result.excluded++
            continue
          }
          if (action.executionKind === 10) {
            // completeArtifact already proved an earlier native configured-key occurrence.
            result.excluded++
            continue
          }
          if (action.commandAction !== true) {
            if (invocation.freshRoot === true) result.noncacheable++
            else result.excluded++
            continue
          }
          const key = identity(action)
          if (key === undefined) {
            result.complete = false
            result.evidenceGap++
            continue
          }
          const occurrence = JSON.stringify([ids[0], rootScope(invocation.rootId), key])
          if (seenIdentities.has(occurrence) === true) {
            result.excluded++
            continue
          }
          seenIdentities.add(occurrence)
          const eligible = (uploads.get(key) ?? Infinity) < invocation.startedAt
          const noncacheable =
            action.executionKind === 0 || action.executionKind === 4 || action.executionKind === 6
          if (eligible === true) {
            outcomes.set(occurrence, action.executionKind === 3)
          } else if ((uploadedBases.get(baseIdentity(action)) ?? Infinity) < invocation.startedAt) {
            changedIdentities.add(occurrence)
          } else if (noncacheable === true) {
            noncacheableIdentities.add(occurrence)
          } else {
            cold.add(occurrence)
          }
        }
      }
      for (const remote of outcomes.values()) {
        result.eligible++
        if (remote === true) result.remoteHits++
      }
      result.cold = cold.size
      result.changed = changedIdentities.size
      result.noncacheable += noncacheableIdentities.size
      result.hitRate = result.eligible === 0 ? null : result.remoteHits / result.eligible
      result.meetsThreshold =
        result.complete === true &&
        result.eligible > 0 &&
        result.remoteHits * 100 >= result.eligible * 99
      consecutive = result.meetsThreshold === true ? consecutive + 1 : 0
      return result
    })
    return { lane: enabledLane, accepted: consecutive >= 2, consecutive, observations }
  })
  return { schemaVersion: 1, accepted: lanes.every((item) => item.accepted === true), lanes }
}
export const loadAndEvaluate = async (manifestPath: string): Promise<WarmReport> => {
  const manifest = decodeManifest(await Bun.file(manifestPath).json())
  const root = dirname(resolve(manifestPath))
  const load = async (ref: ArtifactReference): Promise<ActionArtifact | undefined> => {
    try {
      const [bytes, summary] = await Promise.all([
        Bun.file(resolve(root, ref.actions)).arrayBuffer(),
        Bun.file(resolve(root, ref.summary)).json(),
      ])
      return decodeEvidence({
        compressed: new Uint8Array(bytes),
        summary,
        expectedLane: ref.lane,
      })
    } catch {
      return undefined
    }
  }
  const loaded = await Promise.all(
    manifest.observations.map(async (observation): Promise<LoadedObservation> => {
      const [writers, readers] = await Promise.all([
        Promise.all(observation.writers.map(load)),
        Promise.all(observation.readers.map(load)),
      ])
      return { observation, writers, readers }
    }),
  )
  return evaluateWarm99({ manifest, loaded })
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
    if (report.accepted !== true) process.exitCode = 1
  } catch {
    console.error('Warm cache evaluation failed: invalid manifest or evidence.')
    process.exitCode = 1
  }
}
