import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'

import { boolean, field, integer, list, text } from './buck2-action-evidence-codec.ts'
import {
  actionExclusionReason,
  type ActionArtifact,
  type CacheLane,
  type CacheReadPolicy,
} from './buck2-action-evidence.ts'
import type { ExpectedHistoryJob } from './buck2-cache-proof-history.ts'
import {
  completeArtifact,
  decodeEvidence,
  decodeManifest,
  evaluateWarm99,
  identity,
  trustedPresenceObservedAt,
  type ArtifactReference,
  type LoadedObservation,
  type WarmManifest,
} from './buck2-cache-warm99.ts'

export const proofManifestName = 'buck2-cache-proof-manifest.json'
export const warm99ReportName = 'buck2-cache-warm99.json'
const maxSummaryBytes = 4 * 1024 * 1024
const maxCompressedBytes = 80 * 1024 * 1024
const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')
const safeToken = (value: string | null): string | null =>
  value !== null && /^[a-zA-Z0-9_.:-]{1,96}$/.test(value) === true ? value : null
const readBounded = async ({
  path,
  maximum,
}: {
  path: string
  maximum: number
}): Promise<Uint8Array> => {
  const file = Bun.file(path)
  if (file.size > maximum) throw new Error('Proof input exceeds size bound')
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.length > maximum) throw new Error('Proof input exceeds size bound')
  return bytes
}

type ProofReference = {
  id: string
  role: 'writer' | 'reader'
  lane: CacheLane
  observation: string
  summary: { sha256: string; bytes: number } | null
  actions: { sha256: string; bytes: number; rows: number; actionCount: number } | null
  metadata: {
    repo: string | null
    cacheOutcomeMapping: string
    runId: string | null
    runAttempt: string | null
    job: string | null
    cell: string | null
    headSha: string | null
    startedAt: number | null
    finishedAt: number | null
  } | null
  invocations: {
    buildId: string | null
    rootId: string | null
    sha256: string
    actionCount: number
    startedAt: number | null
    completedAt: number | null
    freshRoot: boolean
    cacheReadPolicy: CacheReadPolicy
    complete: boolean
  }[]
  gap: 'unavailable-or-invalid-evidence' | null
}

/** Per-job publication never discovers history implicitly or upgrades missing sources to success.
 * A supplied manifest is authoritative about chronological observations and lane/job membership.
 * Source paths and arbitrary environment values never enter the public projection.
 */
export const writeBuck2CacheProofReports = async ({
  summaryPath,
  actionsPath,
  shardIndexPath,
  manifestPath = process.env.CI_BUCK2_CACHE_WARM99_MANIFEST,
  collectionEvidenceGaps = [],
  expectedJobs = [],
  nixSubstitutionObserved,
}: {
  summaryPath: string
  actionsPath: string
  shardIndexPath?: string
  manifestPath?: string
  collectionEvidenceGaps?: readonly string[]
  expectedJobs?: readonly ExpectedHistoryJob[]
  nixSubstitutionObserved?: boolean
}): Promise<void> => {
  const root = dirname(resolve(summaryPath))
  const references: ProofReference[] = []
  const artifacts = new Map<string, ActionArtifact>()
  const gaps: string[] =
    collectionEvidenceGaps.length === 0 ? [] : ['historical-collection-incomplete']
  let inputBytes = 0
  let decodedBytes = 0
  let invocationCount = 0
  const readInput = async ({
    path,
    maximum,
  }: {
    path: string
    maximum: number
  }): Promise<Uint8Array> => {
    const size = Bun.file(path).size
    if (inputBytes + size > 256 * 1024 * 1024) throw new Error('Proof total input bound exceeded')
    inputBytes += size
    return readBounded({ path, maximum })
  }
  const decodeInput = ({
    compressed,
    summaryBytes,
    expectedLane,
  }: {
    compressed: Uint8Array
    summaryBytes: Uint8Array
    expectedLane?: CacheLane
  }): ActionArtifact => {
    const summary: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(summaryBytes),
    )
    const declared = field({
      value: field({ value: summary, key: 'actionsArtifact' }),
      key: 'uncompressedBytes',
    })
    const size = declared === undefined ? 65 * 1024 * 1024 : integer(declared)
    if (decodedBytes + size > 256 * 1024 * 1024)
      throw new Error('Proof decoded input bound exceeded')
    decodedBytes += size
    return decodeEvidence({ compressed, summary, expectedLane })
  }
  let current: ActionArtifact | undefined
  try {
    current = decodeInput({
      compressed: await readInput({ path: actionsPath, maximum: maxCompressedBytes }),
      summaryBytes: await readInput({ path: summaryPath, maximum: maxSummaryBytes }),
    })
  } catch {
    gaps.push('current-evidence-unavailable-or-invalid')
  }
  const disabled = current?.header.metadata.posture === 'disabled-by-design'
  const currentLane = current?.header.metadata.lane
  let manifest: WarmManifest
  let manifestDigest: string | null = null
  try {
    if (manifestPath === undefined) throw new Error('No historical manifest supplied')
    const bytes = await readInput({ path: manifestPath, maximum: maxSummaryBytes })
    manifest = decodeManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
    if (
      manifest.observations.length > 64 ||
      manifest.observations.reduce(
        (total, item) => total + item.readers.length + item.writers.length,
        0,
      ) > 128
    )
      throw new Error('Proof manifest exceeds observation/reference bound')
    manifestDigest = sha256(bytes)
  } catch {
    if (manifestPath !== undefined) gaps.push('historical-manifest-unavailable-or-invalid')
    const lane = currentLane ?? 'main-reader'
    const ref = { lane, summary: resolve(summaryPath), actions: resolve(actionsPath) }
    manifest = {
      schemaVersion: 1,
      enabledLanes: [lane],
      observations: [
        {
          id: 'previous',
          sequence: 1,
          writers: [],
          readers: [],
          nixSubstitution: { substituted: 0, built: 0 },
        },
        {
          id: 'current',
          sequence: 2,
          writers: lane === 'main-writer' ? [ref] : [],
          readers: lane === 'main-writer' ? [] : [ref],
          nixSubstitution: { substituted: 0, built: 0 },
        },
      ],
    }
    if (disabled !== true)
      gaps.push(
        'prior-observation-unavailable',
        'prior-writer-evidence-unavailable',
        'nix-substitution-not-observed',
      )
  }
  const sourceRoot = manifestDigest === null ? root : dirname(resolve(manifestPath!))
  const load = async ({
    ref,
    role,
    observation,
  }: {
    ref: ArtifactReference
    role: 'writer' | 'reader'
    observation: string
  }): Promise<ActionArtifact | undefined> => {
    const id = `reference-${references.length + 1}`
    const record: ProofReference = {
      id,
      role,
      lane: ref.lane,
      observation,
      summary: null,
      actions: null,
      metadata: null,
      invocations: [],
      gap: 'unavailable-or-invalid-evidence',
    }
    references.push(record)
    try {
      const summary = await readInput({
        path: resolve(sourceRoot, ref.summary),
        maximum: maxSummaryBytes,
      })
      const compressed = await readInput({
        path: resolve(sourceRoot, ref.actions),
        maximum: maxCompressedBytes,
      })
      record.summary = { sha256: sha256(summary), bytes: summary.length }
      const artifact = decodeInput({ compressed, summaryBytes: summary, expectedLane: ref.lane })
      invocationCount += artifact.header.invocations.length
      if (invocationCount > 4096) throw new Error('Proof total invocation bound exceeded')
      record.actions = {
        sha256: sha256(compressed),
        bytes: compressed.length,
        rows: artifact.header.rows,
        actionCount: artifact.header.actionCount,
      }
      const metadata = artifact.header.metadata
      record.metadata = {
        repo:
          metadata.repo !== null &&
          /^[a-zA-Z0-9_.-]{1,96}\/[a-zA-Z0-9_.-]{1,96}$/.test(metadata.repo) === true
            ? metadata.repo
            : null,
        cacheOutcomeMapping: artifact.header.cacheOutcomeMapping,
        runId: safeToken(metadata.runId),
        runAttempt: safeToken(metadata.runAttempt),
        job: safeToken(metadata.job),
        cell: safeToken(metadata.cell),
        headSha:
          metadata.headSha !== null && /^[a-f0-9]{40,64}$/.test(metadata.headSha) === true
            ? metadata.headSha
            : null,
        startedAt: metadata.startedAt,
        finishedAt: metadata.finishedAt,
      }
      record.invocations = artifact.header.invocations.map((item) => ({
        buildId: safeToken(item.buildId),
        rootId:
          typeof field({ value: item, key: 'rootId' }) === 'string'
            ? safeToken(text(field({ value: item, key: 'rootId' })))
            : null,
        sha256: sha256(JSON.stringify(item)),
        actionCount: item.actionCount,
        startedAt: item.startedAt,
        completedAt: item.completedAt,
        freshRoot: item.freshRoot,
        cacheReadPolicy: item.cacheReadPolicy,
        complete: item.complete,
      }))
      record.gap = null
      artifacts.set(id, artifact)
      return artifact
    } catch {
      return undefined
    }
  }
  const loaded: LoadedObservation[] = []
  for (const observation of manifest.observations) {
    const writers = []
    const readers = []
    for (const ref of observation.writers) {
      // Sequential decoding enforces the aggregate byte budget and bounds retained decompression.
      // eslint-disable-next-line no-await-in-loop
      writers.push(await load({ ref, role: 'writer', observation: observation.id }))
    }
    for (const ref of observation.readers) {
      // Sequential decoding shares the same budget and stable reference numbering.
      // eslint-disable-next-line no-await-in-loop
      readers.push(await load({ ref, role: 'reader', observation: observation.id }))
    }
    loaded.push({ observation, writers, readers })
  }
  const report = evaluateWarm99({ manifest, loaded })
  // Bind exact identities observed by trusted main writers before each reader invocation.
  const bindings = references
    .filter((ref) => ref.role === 'reader')
    .map((reader) => {
      const artifact = artifacts.get(reader.id)
      const firstByInvocation = new Map<string, Set<string>>()
      if (artifact !== undefined && completeArtifact({ artifact, writer: false }) === true) {
        const seen = new Set<string>()
        for (const action of artifact.actions.toSorted(
          (left, right) => (left.startedAt ?? Infinity) - (right.startedAt ?? Infinity),
        )) {
          if (
            actionExclusionReason(action.category) !== null ||
            action.commandAction !== true ||
            action.executionKind === 10
          )
            continue
          const key = identity(action)
          const invocation = artifact.header.invocations.find(
            (item) => item.buildId === action.buildId,
          )
          if (key === undefined || invocation === undefined) continue
          if (invocation.cacheReadPolicy === 'disabled-by-design') continue
          const nativeRootId = field({ value: invocation, key: 'rootId' })
          const rootId =
            typeof nativeRootId === 'string'
              ? safeToken(nativeRootId)
              : artifact.header.invocations.filter((item) => item.freshRoot).length === 1
                ? 'legacy-root'
                : null
          if (rootId === null) continue
          const scopedKey = JSON.stringify([rootId, key])
          if (seen.has(scopedKey) === true) continue
          seen.add(scopedKey)
          if (action.buildId === null) continue
          const cohort = firstByInvocation.get(action.buildId) ?? new Set<string>()
          cohort.add(key)
          firstByInvocation.set(action.buildId, cohort)
        }
      }
      return {
        reader: reader.id,
        invocations: (artifact?.header.invocations ?? []).map((invocation) => {
          const eligible = firstByInvocation.get(invocation.buildId) ?? new Set<string>()
          const writers = references
            .filter((ref) => ref.role === 'writer' && ref.observation === reader.observation)
            .flatMap((writer) => {
              const prior = artifacts.get(writer.id)
              if (
                prior === undefined ||
                completeArtifact({ artifact: prior, writer: true }) !== true
              )
                return []
              const observations = prior.actions.filter((action) => {
                const key = identity(action)
                const observedAt = trustedPresenceObservedAt({
                  action,
                  invocation: prior.header.invocations.find(
                    (item) => item.buildId === action.buildId,
                  ),
                })
                return (
                  prior.header.metadata.repo === artifact?.header.metadata.repo &&
                  key !== undefined &&
                  eligible.has(key) === true &&
                  observedAt !== undefined &&
                  invocation.startedAt !== null &&
                  observedAt < invocation.startedAt
                )
              })
              return observations.length === 0
                ? []
                : [
                    {
                      reference: writer.id,
                      priorObservationCount: observations.length,
                      identitiesSha256: sha256(
                        JSON.stringify(observations.map(identity).toSorted()),
                      ),
                    },
                  ]
            })
          return { invocationSha256: sha256(JSON.stringify(invocation)), writers }
        }),
      }
    })
  let shards: {
    sha256: string
    bytes: number
    complete: boolean
    shardCount: number
    invocationCount: number
    shards: { sha256: string; bytes: number; rows: number; complete: boolean }[]
  } | null = null
  if (shardIndexPath !== undefined) {
    try {
      const bytes = await readInput({ path: shardIndexPath, maximum: maxSummaryBytes })
      const index: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (field({ value: index, key: 'schemaVersion' }) !== 1)
        throw new Error('Invalid shard index')
      const entries = list(field({ value: index, key: 'shards' }))
      if (entries.length > 4096) throw new Error('Shard count exceeds bound')
      const projected = entries.map((entry) => {
        const hash = text(field({ value: entry, key: 'sha256' }))
        if (/^[a-f0-9]{64}$/.test(hash) !== true) throw new Error('Invalid shard hash')
        return {
          sha256: hash,
          bytes: integer(field({ value: entry, key: 'bytes' })),
          rows: integer(field({ value: entry, key: 'rows' })),
          complete: boolean(field({ value: entry, key: 'complete' })),
        }
      })
      shards = {
        sha256: sha256(bytes),
        bytes: bytes.length,
        complete: boolean(field({ value: index, key: 'complete' })),
        shardCount: entries.length,
        invocationCount: list(field({ value: index, key: 'expectedBuildIds' })).length,
        shards: projected,
      }
      if (
        shards.complete !== true ||
        list(field({ value: index, key: 'evidenceGaps' })).length !== 0
      )
        gaps.push('shard-index-incomplete')
    } catch {
      gaps.push('shard-index-unavailable')
    }
  }
  const nixObserved = manifestDigest !== null && nixSubstitutionObserved !== false
  const warm = {
    ...report,
    lanes: report.lanes.map((lane) => ({
      ...lane,
      observations: lane.observations.map((observation) => ({
        ...observation,
        nixSubstitution: nixObserved === true ? observation.nixSubstitution : null,
      })),
    })),
    accepted: disabled !== true && gaps.length === 0 && report.accepted,
    proofRequired: disabled !== true,
    nixSubstitutionEvidence: nixObserved === true ? 'observed' : 'unavailable',
    evidenceGaps: disabled === true ? [] : gaps,
  }
  const warmBytes = `${JSON.stringify(warm, null, 2)}\n`
  const proof = {
    schemaVersion: 1,
    kind: 'buck2-cache-proof-manifest',
    proofRequired: disabled !== true,
    accepted: warm.accepted,
    historicalManifestSha256: manifestDigest,
    nixSubstitutionEvidence: nixObserved === true ? 'observed' : 'unavailable',
    expectedObservations: manifest.observations.map((observation) => ({
      id: safeToken(observation.id),
      sequence: observation.sequence,
      writers: observation.writers.map((ref) => ref.lane),
      readers: observation.readers.map((ref) => ref.lane),
    })),
    enabledLanes: manifest.enabledLanes,
    expectedLaneJobs: references.map((ref) => ({
      lane: ref.lane,
      job: ref.metadata?.job ?? null,
      reference: ref.id,
    })),
    references,
    writerPriorObservationBindings: bindings,
    shardIndex: shards,
    warm99: {
      name: warm99ReportName,
      sha256: sha256(warmBytes),
      bytes: Buffer.byteLength(warmBytes),
    },
    // Keep discovery's required identity even when the corresponding evidence cannot be loaded.
    discoveredExpectedJobs: expectedJobs.slice(0, 128).map((job) => ({
      runId: Number.isSafeInteger(job.runId) === true && job.runId > 0 ? job.runId : null,
      job: safeToken(job.job),
      runAttempt:
        Number.isSafeInteger(job.runAttempt) === true && job.runAttempt > 0 ? job.runAttempt : null,
      cell: safeToken(job.cell),
    })),
    evidenceGaps:
      disabled === true
        ? []
        : [
            ...gaps,
            ...references
              .filter((ref) => ref.gap !== null)
              .map((ref) => `${ref.id}:unavailable-or-invalid-evidence`),
          ],
  }
  const proofBytes = `${JSON.stringify(proof, null, 2)}\n`
  if (Buffer.byteLength(warmBytes) + Buffer.byteLength(proofBytes) > 8 * 1024 * 1024) {
    const failedWarm = `${JSON.stringify({ schemaVersion: 1, accepted: false, proofRequired: disabled !== true, lanes: [], evidenceGaps: ['proof-output-limit-exceeded'] })}\n`
    await Bun.write(resolve(root, warm99ReportName), failedWarm)
    await Bun.write(
      resolve(root, proofManifestName),
      `${JSON.stringify({ schemaVersion: 1, kind: 'buck2-cache-proof-manifest', accepted: false, proofRequired: disabled !== true, enabledLanes: manifest.enabledLanes, warm99: { name: warm99ReportName, sha256: sha256(failedWarm), bytes: Buffer.byteLength(failedWarm) }, evidenceGaps: ['proof-output-limit-exceeded'] })}\n`,
    )
    return
  }
  await Bun.write(resolve(root, warm99ReportName), warmBytes)
  await Bun.write(resolve(root, proofManifestName), proofBytes)
}
