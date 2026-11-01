#!/usr/bin/env bun
import { createHash } from 'node:crypto'
/**
 * Project pinned Buck2 `log show` JSONL, never command/environment/log payloads.
 *
 * bun genie/ci-scripts/buck2-cache-evidence.ts --events show.jsonl --output evidence.json --context proof-a-build
 * Reusing --output appends new build ids; duplicate logs preserve the first context.
 * --remote-cache-disabled-by-design --output evidence.json records the in-Nix exclusion.
 * --output evidence.json alone initializes honest no-native-logs evidence.
 * Every collection reads evidence.json.admission.jsonl and deduplicates entrypoint
 * UUIDs independently of native logs, retaining denied-writer admissions too.
 * Admission totals are recomputed from retained invocation rows, never incremented
 * from a previous summary. Missing sidecars produce explicit zeros on new evidence.
 * Finalization confirms native --write-build-id outputs from the separate path
 * registry before detecting rotation; admission rows never prove native launch.
 * A written incomplete finalization exits 2; operational failures exit 1.
 *
 * Outcomes use data.proto's numeric enums, not command cache_hit booleans.
 * Digests are the exact native RE ActionCache `hash:size`, NOT output tiny_digest.
 * End spans repeat identity; active starts supply only a fallback. The compact
 * view stays bounded; an optional sink receives every normalized action row.
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { gzipSync, gunzipSync } from 'node:zlib'

import {
  canonicalCacheAdmissionInvocationId,
  decodeReapiAdmissionFailure,
  type ReapiAdmissionFailure,
} from '../../scripts/buck2-cache-posture.ts'
import {
  classifyCacheUploadError,
  decodeActionArtifact,
  decodeActionExclusionCounts,
  decodeCacheUploadErrors,
  decodeCacheReadPolicy,
  decodeOutputTinyDigests,
} from './buck2-action-evidence-codec.ts'
import {
  actionExclusionReason,
  actionExclusionReasons,
  countActionExclusions,
  actionsArtifactName,
  cacheOutcomeMapping,
  invocationWithinJobWindow,
  maxActionArtifactBytes,
  outcomeFor,
  proofJobCell,
  zeroActionExclusionCounts,
  type ActionExclusionCounts,
  type ActionExclusionReason,
  type ActionArtifact,
  type ActionInvocation,
  type ActionRecord,
  type CacheReadPolicy,
  type CacheUploadError,
} from './buck2-action-evidence.ts'
import type { OutputTinyDigests } from './buck2-action-evidence.ts'

export const maxCacheEvidenceActions = 64
export const cacheEvidenceOutcomes = [
  'remote-hit',
  'local',
  'uploaded',
  'local-cache',
  'remote-execution',
  'remote-dep-file-hit',
  'other',
] as const
export type CacheOutcome = (typeof cacheEvidenceOutcomes)[number]
export type OutcomeCounts = Record<CacheOutcome, number>
export type ReaderReapiUnavailableShadow = {
  cause: {
    capabilitiesUnavailable: boolean
    connectRetry: boolean
    clientInitialization: boolean
    connectUnavailable: boolean
    transportMessage: 'tls-handshake-eof' | 'transport-error' | 'none'
  }
  command: { subcommand: string; argumentCount: number }
  nativeExitCode: number
  durationMs: number
  failedActionCount: number
  wouldDisableRemoteCache: true
}
export type CacheAdmissionInvocation = {
  invocationId: string
  admissionFallbacks: { reapi: number; archiveOrigin: number }
  admissionRetrySuccesses: { reapi: number; archiveOrigin: number }
  reapiFailure?: ReapiAdmissionFailure
  reapiDecision?:
    | 'first-probe-for-ci-job'
    | 'pinned-from-first-probe'
    | 'unpinned-missing-job-instance'
  event?: 'reader-reapi-unavailable-shadow' | 'reader-reapi-unavailable-rerun'
  shadow?: ReaderReapiUnavailableShadow
  /** Read-only provenance for measured historical reruns; never emitted by the launcher. */
  legacyRerun?: true
}
// Historical command diagnostics remain readable; native downloads emit none.
const archiveOriginFallbackReasons = [
  'not-found',
  'headers-timeout',
  'connection-error',
  'server-error',
] as const
type ArchiveOriginFallbackReason = (typeof archiveOriginFallbackReasons)[number]
type ArchiveOriginFallbackCounts = Record<ArchiveOriginFallbackReason, number>
type ReapiFailureCounts = (Pick<ReapiAdmissionFailure, 'class' | 'phase'> & {
  count: number
  maxElapsedMs: number
})[]
type CacheAdmissionEvidence = {
  admissionFallbacks: CacheAdmissionInvocation['admissionFallbacks']
  admissionRetrySuccesses: CacheAdmissionInvocation['admissionRetrySuccesses']
  admissionInvocations: CacheAdmissionInvocation[]
  reapiFailures: ReapiFailureCounts
  archiveOriginFallbacks?: ArchiveOriginFallbackCounts
}
export type CacheAction = {
  buildId: string
  context?: string
  category: string
  exclusionReason: ActionExclusionReason | null
  target: string
  configuration?: string
  digest: string
  outcome: CacheOutcome
  executionKind: number
  cacheUploadResult: number
  uploadErrors?: CacheUploadError[]
  outputTinyDigests?: OutputTinyDigests
}
export type CacheInvocation = {
  buildId: string
  context?: string
  counts: OutcomeCounts
  /** Absent on retained bounded summaries that cannot reconstruct omitted categories. */
  excludedByDesign?: ActionExclusionCounts
  actionCount: number
  missingDigestCount: number
  missingCommandDigestCount: number
  /** Missing native digests grouped by outcome; absent on older retained artifacts. */
  noDigestReasons?: OutcomeCounts
  missingIdentityCount: number
  unpairedStartCount: number
  /** Actual acquisition fallbacks, separate from endpoint admission probes. */
  archiveOriginFallbacks?: ArchiveOriginFallbackCounts
}
export type CacheEvidence = {
  schemaVersion: 1
  status: 'collected' | 'remote-cache-disabled-by-design' | 'no-native-logs'
  /** Absent only on retained summaries written before admission collection. */
  admissionFallbacks?: CacheAdmissionInvocation['admissionFallbacks']
  admissionRetrySuccesses?: CacheAdmissionInvocation['admissionRetrySuccesses']
  admissionInvocations?: CacheAdmissionInvocation[]
  reapiFailures?: ReapiFailureCounts
  archiveOriginFallbacks?: ArchiveOriginFallbackCounts
  reason?: string
  metadata: Record<string, string>
  counts: OutcomeCounts
  excludedByDesign?: ActionExclusionCounts
  actionCount: number
  droppedActionCount: number
  invocations: CacheInvocation[]
  actions: CacheAction[]
  cacheOutcomeMapping?: typeof cacheOutcomeMapping
  actionsArtifact?: {
    name: string
    rows: number
    sha256: string
    bytes: number
    uncompressedBytes: number
    complete: boolean
    droppedActionCount: number
  }
}

const field = ({ value, key }: { value: unknown; key: string }): unknown =>
  typeof value === 'object' && value !== null && Array.isArray(value) === false && key in value
    ? Reflect.get(value, key)
    : undefined
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined
const count = (value: unknown): number => {
  if (typeof value !== 'number' || Number.isSafeInteger(value) === false || value < 0) {
    throw new Error('Invalid cache evidence count')
  }
  return value
}

const admissionEndpoints = ['reapi', 'archiveOrigin'] as const
const zeroAdmissionEvidence = (): CacheAdmissionEvidence => ({
  admissionFallbacks: { reapi: 0, archiveOrigin: 0 },
  admissionRetrySuccesses: { reapi: 0, archiveOrigin: 0 },
  admissionInvocations: [],
  reapiFailures: [],
})
const decodeAdmissionCounters = (
  value: unknown,
): CacheAdmissionInvocation['admissionFallbacks'] => ({
  reapi: count(field({ value, key: 'reapi' })),
  archiveOrigin: count(field({ value, key: 'archiveOrigin' })),
})
export const decodeReaderReapiUnavailableShadow = (
  value: unknown,
): ReaderReapiUnavailableShadow => {
  const cause = field({ value, key: 'cause' })
  const command = field({ value, key: 'command' })
  const subcommand = field({ value: command, key: 'subcommand' })
  const transportMessage = field({ value: cause, key: 'transportMessage' })
  const capabilitiesUnavailable = field({ value: cause, key: 'capabilitiesUnavailable' })
  const connectRetry = field({ value: cause, key: 'connectRetry' })
  const clientInitialization = field({ value: cause, key: 'clientInitialization' })
  const connectUnavailable = field({ value: cause, key: 'connectUnavailable' })
  if (
    typeof subcommand !== 'string' ||
    ['build', 'test', 'audit', 'cquery', 'uquery', 'aquery', 'targets'].includes(subcommand) ===
      false ||
    typeof capabilitiesUnavailable !== 'boolean' ||
    typeof connectRetry !== 'boolean' ||
    typeof clientInitialization !== 'boolean' ||
    typeof connectUnavailable !== 'boolean' ||
    (capabilitiesUnavailable === false &&
      clientInitialization === false &&
      connectUnavailable === false) ||
    (transportMessage !== 'tls-handshake-eof' &&
      transportMessage !== 'transport-error' &&
      transportMessage !== 'none') ||
    field({ value, key: 'wouldDisableRemoteCache' }) !== true
  )
    throw new Error('Invalid reader REAPI shadow classification')
  const nativeExitCode = count(field({ value, key: 'nativeExitCode' }))
  if (nativeExitCode === 0 || nativeExitCode > 255)
    throw new Error('Invalid reader REAPI shadow exit code')
  return {
    cause: {
      capabilitiesUnavailable,
      connectRetry,
      clientInitialization,
      connectUnavailable,
      transportMessage,
    },
    command: { subcommand, argumentCount: count(field({ value: command, key: 'argumentCount' })) },
    nativeExitCode,
    durationMs: count(field({ value, key: 'durationMs' })),
    failedActionCount: count(field({ value, key: 'failedActionCount' })),
    wouldDisableRemoteCache: true,
  }
}
export const decodeCacheAdmissionInvocation = (value: unknown): CacheAdmissionInvocation => {
  const invocationId = canonicalCacheAdmissionInvocationId(field({ value, key: 'invocationId' }))
  const admissionFallbacks = decodeAdmissionCounters(field({ value, key: 'admissionFallbacks' }))
  const admissionRetrySuccesses = decodeAdmissionCounters(
    field({ value, key: 'admissionRetrySuccesses' }),
  )
  for (const endpoint of admissionEndpoints) {
    if (admissionFallbacks[endpoint] + admissionRetrySuccesses[endpoint] > 1)
      throw new Error('Invalid cache admission invocation counters')
  }
  const failure = field({ value, key: 'reapiFailure' })
  if (failure !== undefined && admissionFallbacks.reapi !== 1)
    throw new Error('REAPI failure requires an admission fallback')
  const decision = field({ value, key: 'reapiDecision' })
  if (
    decision !== undefined &&
    decision !== 'first-probe-for-ci-job' &&
    decision !== 'pinned-from-first-probe' &&
    decision !== 'unpinned-missing-job-instance'
  )
    throw new Error('Invalid REAPI job decision source')
  const event = field({ value, key: 'event' })
  const shadow = field({ value, key: 'shadow' })
  // Retained outage measurements cannot be reconstructed from shadow observations.
  const legacyRerun = event === 'reader-reapi-unavailable-rerun'
  const legacyTag = field({ value, key: 'legacyRerun' })
  if (legacyRerun === true) {
    if (
      admissionFallbacks.reapi !== 1 ||
      shadow !== undefined ||
      (legacyTag !== undefined && legacyTag !== true)
    )
      throw new Error('Invalid legacy reader REAPI rerun event')
  } else if (
    (event !== undefined && event !== 'reader-reapi-unavailable-shadow') ||
    (event === undefined) !== (shadow === undefined) ||
    legacyTag !== undefined ||
    (event !== undefined && admissionFallbacks.reapi !== 0)
  )
    throw new Error('Invalid cache admission shadow event')
  return {
    invocationId,
    admissionFallbacks,
    admissionRetrySuccesses,
    ...(failure === undefined ? {} : { reapiFailure: decodeReapiAdmissionFailure(failure) }),
    ...(decision === undefined ? {} : { reapiDecision: decision }),
    ...(event === undefined ? {} : { event }),
    ...(shadow === undefined ? {} : { shadow: decodeReaderReapiUnavailableShadow(shadow) }),
    ...(legacyRerun === true ? { legacyRerun } : {}),
  }
}
const collectAdmissionInvocations = (
  invocations: CacheAdmissionInvocation[],
): CacheAdmissionEvidence => {
  const result = zeroAdmissionEvidence()
  const seen = new Map<string, CacheAdmissionInvocation>()
  for (const invocation of invocations) {
    const previous = seen.get(invocation.invocationId)
    if (previous !== undefined) {
      const { event: previousEvent, shadow: previousShadow, ...previousAdmission } = previous
      const { event, shadow, ...admission } = invocation
      if (
        JSON.stringify(previousAdmission) !== JSON.stringify(admission) ||
        (previousEvent !== undefined &&
          event !== undefined &&
          JSON.stringify(previousShadow) !== JSON.stringify(shadow))
      )
        throw new Error('Conflicting cache admission invocation')
      // A post-command shadow row enriches its original admission without
      // inventing another invocation or incrementing admission fallback totals.
      if (previousEvent === undefined && event !== undefined)
        Object.assign(previous, { event, shadow })
      continue
    }
    seen.set(invocation.invocationId, invocation)
    result.admissionInvocations.push(invocation)
    for (const endpoint of admissionEndpoints) {
      result.admissionFallbacks[endpoint] += invocation.admissionFallbacks[endpoint]
      result.admissionRetrySuccesses[endpoint] += invocation.admissionRetrySuccesses[endpoint]
    }
    if (invocation.reapiFailure !== undefined) {
      const failure = invocation.reapiFailure
      const group = result.reapiFailures.find(
        (item) => item.class === failure.class && item.phase === failure.phase,
      )
      if (group === undefined)
        result.reapiFailures.push({
          class: failure.class,
          phase: failure.phase,
          count: 1,
          maxElapsedMs: failure.elapsedMs,
        })
      else {
        group.count++
        group.maxElapsedMs = Math.max(group.maxElapsedMs, failure.elapsedMs)
      }
    }
  }
  return result
}
const zeroArchiveOriginFallbacks = (): ArchiveOriginFallbackCounts => ({
  'not-found': 0,
  'headers-timeout': 0,
  'connection-error': 0,
  'server-error': 0,
})
const decodeArchiveOriginFallbacks = (value: unknown): ArchiveOriginFallbackCounts => {
  const result = zeroArchiveOriginFallbacks()
  for (const reason of archiveOriginFallbackReasons)
    result[reason] = count(field({ value, key: reason }))
  return result
}
/** Preserve endpoint admission rows; add actual acquisitions only in the aggregate. */
const withArchiveOriginFallbacks = ({
  admission,
  invocations,
}: {
  admission: CacheAdmissionEvidence
  invocations: readonly Pick<CacheInvocation, 'archiveOriginFallbacks'>[]
}): CacheAdmissionEvidence => {
  const counts = zeroArchiveOriginFallbacks()
  let observed = false
  for (const invocation of invocations) {
    if (invocation.archiveOriginFallbacks === undefined) continue
    observed = true
    for (const reason of archiveOriginFallbackReasons)
      counts[reason] += invocation.archiveOriginFallbacks[reason]
  }
  if (observed === false) return admission
  return {
    ...admission,
    admissionFallbacks: {
      ...admission.admissionFallbacks,
      archiveOrigin:
        admission.admissionFallbacks.archiveOrigin +
        archiveOriginFallbackReasons.reduce((sum, reason) => sum + counts[reason], 0),
    },
    archiveOriginFallbacks: counts,
  }
}
/** Read only allowlisted JSON diagnostics from archive actions, never retain raw stderr. */
const archiveFallbacksFor = (action: unknown): ArchiveOriginFallbackCounts => {
  const counts = zeroArchiveOriginFallbacks()
  const commands = field({ value: action, key: 'commands' })
  if (Array.isArray(commands) === false) return counts
  for (const command of commands) {
    const stderr = text(
      field({ value: field({ value: command, key: 'details' }), key: 'cmd_stderr' }),
    )
    if (stderr === undefined) continue
    for (const line of stderr.split('\n')) {
      if (line.startsWith('{"type":"archive-origin-fallback",') === false) continue
      let diagnostic: unknown
      try {
        diagnostic = JSON.parse(line)
      } catch {
        continue
      }
      const reason = archiveOriginFallbackReasons.find(
        (candidateReason) => candidateReason === field({ value: diagnostic, key: 'reason' }),
      )
      const sha256 = text(field({ value: diagnostic, key: 'sha256' }))
      if (reason !== undefined && sha256 !== undefined && /^[a-f0-9]{64}$/.test(sha256) === true)
        counts[reason]++
    }
  }
  return counts
}

/** Legacy v1 summaries omit all admission fields; present fields remain strictly validated. */
export const decodeCacheAdmissionEvidence = (value: unknown): CacheAdmissionEvidence => {
  const rows = field({ value, key: 'admissionInvocations' })
  if (rows !== undefined && Array.isArray(rows) === false)
    throw new Error('Invalid cache admission invocations')
  const invocationValues = field({ value, key: 'invocations' })
  const invocations: Pick<CacheInvocation, 'archiveOriginFallbacks'>[] = []
  if (Array.isArray(invocationValues) === true) {
    for (const invocationValue of invocationValues) {
      const counts = field({ value: invocationValue, key: 'archiveOriginFallbacks' })
      if (counts !== undefined)
        invocations.push({
          archiveOriginFallbacks: decodeArchiveOriginFallbacks(counts),
        })
    }
  }
  const result = withArchiveOriginFallbacks({
    admission: collectAdmissionInvocations(
      rows === undefined ? [] : rows.map(decodeCacheAdmissionInvocation),
    ),
    invocations: invocations,
  })
  if (rows !== undefined && result.admissionInvocations.length !== rows.length)
    throw new Error('Duplicate cache admission invocation ID')
  for (const key of ['admissionFallbacks', 'admissionRetrySuccesses'] as const) {
    const counters = field({ value, key })
    if (counters === undefined) continue
    const decoded = decodeAdmissionCounters(counters)
    for (const endpoint of admissionEndpoints) {
      if (rows !== undefined && decoded[endpoint] !== result[key][endpoint])
        throw new Error('Cache admission aggregate mismatch')
    }
    result[key] = decoded
  }
  const failures = field({ value, key: 'reapiFailures' })
  if (failures !== undefined && JSON.stringify(failures) !== JSON.stringify(result.reapiFailures))
    throw new Error('REAPI failure aggregate mismatch')
  const archiveCounts = field({ value, key: 'archiveOriginFallbacks' })
  if (archiveCounts !== undefined) {
    const decoded = decodeArchiveOriginFallbacks(archiveCounts)
    for (const reason of archiveOriginFallbackReasons)
      if (decoded[reason] !== (result.archiveOriginFallbacks?.[reason] ?? 0))
        throw new Error('Archive origin fallback aggregate mismatch')
  }
  return result
}
const zeroCounts = (): OutcomeCounts => ({
  'remote-hit': 0,
  local: 0,
  uploaded: 0,
  'local-cache': 0,
  'remote-execution': 0,
  'remote-dep-file-hit': 0,
  other: 0,
})
const nativeEnum = (value: unknown): number => (typeof value === 'number' ? value : 0)

type Identity = { category?: string; target?: string; configuration?: string }
const identityFor = (action: unknown): Identity => {
  const owner = field({ value: field({ value: action, key: 'key' }), key: 'owner' })
  const category = text(field({ value: field({ value: action, key: 'name' }), key: 'category' }))
  for (const variant of [
    'TargetLabel',
    'TestTargetLabel',
    'LocalResourceSetup',
    'AnonTarget',
    'BxlFunctionKey',
  ]) {
    const value = field({ value: owner, key: variant })
    const label = field({ value: value, key: variant === 'AnonTarget' ? 'name' : 'label' })
    const pkg = text(
      field({ value: label, key: variant === 'BxlFunctionKey' ? 'bxl_path' : 'package' }),
    )
    const name = text(field({ value: label, key: 'name' }))
    if (pkg !== undefined && name !== undefined) {
      return {
        category,
        target: `${pkg}:${name}`,
        configuration: text(
          field({ value: field({ value: value, key: 'configuration' }), key: 'full_name' }),
        ),
      }
    }
  }
  return { category }
}
const digestFor = (action: unknown): string | undefined => {
  const commands = field({ value: action, key: 'commands' })
  if (Array.isArray(commands) === false) return undefined
  // Buck orders attempts; the last command is the result shown to the user.
  for (let index = commands.length - 1; index >= 0; index--) {
    const command = field({
      value: field({
        value: field({ value: commands[index], key: 'details' }),
        key: 'command_kind',
      }),
      key: 'command',
    })
    for (const variant of [
      'OmittedLocalCommand',
      'LocalCommand',
      'RemoteCommand',
      'WorkerCommand',
    ]) {
      const digest = text(
        field({ value: field({ value: command, key: variant }), key: 'action_digest' }),
      )
      if (digest !== undefined) return digest
    }
  }
  return undefined
}
const groupKey = (action: CacheAction): string =>
  JSON.stringify([action.category, action.target, action.configuration, action.outcome])
const rowKey = (action: CacheAction): string => JSON.stringify([groupKey(action), action.digest])
const invocationKey = (invocation: { buildId: string; context?: string }): string =>
  JSON.stringify([invocation.buildId, invocation.context])
const compareRows = ({ a, b }: { a: CacheAction; b: CacheAction }): number => {
  const left = rowKey(a)
  const right = rowKey(b)
  return left < right ? -1 : left > right ? 1 : 0
}

/** Stable smallest digest per category/target/configuration/outcome, hard bounded. */
const retainRepresentative = ({
  rows,
  action,
}: {
  rows: CacheAction[]
  action: CacheAction
}): void => {
  const index = rows.findIndex((row) => groupKey(row) === groupKey(action))
  if (index >= 0) {
    if (compareRows({ a: action, b: rows[index]! }) < 0) rows[index] = action
  } else rows.push(action)
  rows.sort((a, b) => compareRows({ a, b }))
  if (rows.length > maxCacheEvidenceActions) rows.pop()
}

/** Pinned log-show serializes protobuf timestamps as [seconds, nanoseconds]. */
const eventTime = (event: unknown): number | null => {
  const value = field({ value: event, key: 'timestamp' })
  if (Array.isArray(value) === false || value.length !== 2) return null
  const [seconds, nanos] = value
  if (
    typeof seconds !== 'number' ||
    Number.isSafeInteger(seconds) === false ||
    seconds < 0 ||
    typeof nanos !== 'number' ||
    Number.isInteger(nanos) === false ||
    nanos < 0 ||
    nanos >= 1e9
  )
    return null
  const result = seconds * 1000 + Math.floor(nanos / 1e6)
  return Number.isSafeInteger(result) === true ? result : null
}
const safeIdentity = ({
  value,
  grammar,
}: {
  value: string | undefined
  grammar: RegExp
}): string | null =>
  value !== undefined && value.length <= 4096 && grammar.test(value) === true ? value : null
const labelGrammar = /^[a-zA-Z0-9_.-]+\/\/[a-zA-Z0-9_./@+-]*:[a-zA-Z0-9_.@+/-]+$/
const configurationGrammar =
  /^[a-zA-Z0-9_.-]+(?:\/\/[a-zA-Z0-9_./@+-]*:[a-zA-Z0-9_.@+/-]+)?#[a-fA-F0-9]+$/
const knownActionKinds: Record<string, true> = {
  NotSet: true,
  Copy: true,
  DownloadFile: true,
  Run: true,
  SymlinkedDir: true,
  Write: true,
  WriteMacrosToFile: true,
  CasArtifact: true,
}

const nativeSpanKey = (value: unknown): string | undefined =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value) === true
      ? String(value)
      : undefined

/** Pure incremental projector: add one decoded JSONL value, finish once. */
export const createCacheEvidenceProjector = ({
  context,
  onAction,
  onInvocation,
  freshRoot = false,
  rootId,
  cacheReadPolicy = 'unknown',
}: {
  context?: string
  onAction?: (action: ActionRecord) => void
  onInvocation?: (invocation: ActionInvocation) => void
  freshRoot?: boolean
  rootId?: string
  cacheReadPolicy?: CacheReadPolicy
} = {}): {
  add: (value: unknown) => void
  finish: () => CacheEvidence
} => {
  let buildId: string | undefined
  const starts = new Map<string, { identity: Identity; startedAt: number | null }>()
  const ended = new Set<string>()
  const parents = new Map<string, string>()
  const uploadErrorsByAction = new Map<string, CacheUploadError[]>()
  const endedUploads = new Set<string>()
  let invocationStartedAt: number | null = null
  let invocationCompletedAt: number | null = null
  let invalidActionCount = 0
  const actions: CacheAction[] = []
  const counts = zeroCounts()
  const excludedByDesign = zeroActionExclusionCounts()
  let actionCount = 0
  let missingDigestCount = 0
  let missingCommandDigestCount = 0
  let missingIdentityCount = 0
  const noDigestReasons = zeroCounts()
  const archiveOriginFallbacks = zeroArchiveOriginFallbacks()
  const add = (value: unknown): void => {
    const event = field({ value: value, key: 'Event' })
    const traceId = text(field({ value: event ?? value, key: 'trace_id' }))
    if (traceId !== undefined) {
      if (buildId !== undefined && buildId !== traceId) {
        throw new Error('Expected one Buck invocation per event file')
      }
      buildId = traceId
    }
    if (event === undefined) return
    // Large u64 ids must not be rounded into a false start/end pairing.
    const spanKey = nativeSpanKey(field({ value: event, key: 'span_id' }))
    const parentKey = nativeSpanKey(field({ value: event, key: 'parent_id' }))
    const data = field({ value: event, key: 'data' })
    const time = eventTime(event)
    const startData = field({ value: field({ value: data, key: 'SpanStart' }), key: 'data' })
    const endData = field({ value: field({ value: data, key: 'SpanEnd' }), key: 'data' })
    if (startData !== undefined && spanKey !== undefined && parentKey !== undefined)
      parents.set(spanKey, parentKey)
    const uploadEnd = field({ value: endData, key: 'CacheUpload' })
    if (uploadEnd !== undefined) {
      if (spanKey !== undefined && endedUploads.has(spanKey) === true) return
      if (spanKey !== undefined) endedUploads.add(spanKey)
      if (field({ value: uploadEnd, key: 'success' }) === false) {
        let owner = parentKey ?? (spanKey === undefined ? undefined : parents.get(spanKey))
        const visited = new Set<string>()
        while (owner !== undefined && starts.has(owner) === false && visited.has(owner) === false) {
          visited.add(owner)
          owner = parents.get(owner)
        }
        if (owner !== undefined && starts.has(owner) === true) {
          const errors = uploadErrorsByAction.get(owner) ?? []
          errors.push(
            classifyCacheUploadError(
              field({ value: uploadEnd, key: 'error' }),
              field({ value: uploadEnd, key: 're_error_code' }),
            ),
          )
          uploadErrorsByAction.set(owner, errors)
        } else invalidActionCount++
      }
      if (spanKey !== undefined) parents.delete(spanKey)
      return
    }
    if (field({ value: startData, key: 'Command' }) !== undefined) invocationStartedAt = time
    if (field({ value: endData, key: 'Command' }) !== undefined) invocationCompletedAt = time
    const start = field({
      value: field({ value: field({ value: data, key: 'SpanStart' }), key: 'data' }),
      key: 'ActionExecution',
    })
    if (start !== undefined && spanKey !== undefined && ended.has(spanKey) === false)
      starts.set(spanKey, { identity: identityFor(start), startedAt: time })
    const end = field({
      value: field({ value: field({ value: data, key: 'SpanEnd' }), key: 'data' }),
      key: 'ActionExecution',
    })
    if (end === undefined) {
      if (endData !== undefined && spanKey !== undefined) parents.delete(spanKey)
      return
    }
    if (spanKey !== undefined) {
      if (ended.has(spanKey) === true) return
      ended.add(spanKey)
    }
    const fallback = spanKey === undefined ? undefined : starts.get(spanKey)
    if (spanKey !== undefined) starts.delete(spanKey)
    const uploadErrors = spanKey === undefined ? undefined : uploadErrorsByAction.get(spanKey)
    if (spanKey !== undefined) {
      uploadErrorsByAction.delete(spanKey)
      parents.delete(spanKey)
    }
    const identity = identityFor(end)
    const category = identity.category ?? fallback?.identity.category
    const target = identity.target ?? fallback?.identity.target
    const configuration = identity.configuration ?? fallback?.identity.configuration
    if (category === 'pnpm_archive') {
      const fallbackCounts = archiveFallbacksFor(end)
      for (const reason of archiveOriginFallbackReasons)
        archiveOriginFallbacks[reason] += fallbackCounts[reason]
    }
    const executionKind = nativeEnum(field({ value: end, key: 'execution_kind' }))
    const cacheUploadResult = nativeEnum(field({ value: end, key: 'cache_upload_result' }))
    const outcome = outcomeFor({ executionKind: executionKind, uploadResult: cacheUploadResult })
    const exclusionReason = actionExclusionReason(category)
    if (exclusionReason !== null) excludedByDesign[exclusionReason]++
    counts[outcome]++
    actionCount++
    const digest = digestFor(end)
    if (digest === undefined) {
      missingDigestCount++
      noDigestReasons[outcome]++
      if (
        field({ value: end, key: 'kind' }) === 'Run' ||
        cacheUploadResult === 1 ||
        executionKind === 3
      )
        missingCommandDigestCount++
    }
    if (category === undefined || target === undefined) missingIdentityCount++
    const actionKind = field({ value: end, key: 'kind' })
    const commandAction = actionKind === 'Run'
    // Keep native emitted order: sorting/deduplication would destroy per-action output indices.
    // The emitter omits values without a digest; these are not declared-output/path indices.
    const nativeOutputs = field({ value: end, key: 'outputs' })
    const outputTinyDigests =
      commandAction === true &&
      cacheUploadResult !== 1 &&
      field({ value: end, key: 'failed' }) !== true &&
      nativeOutputs !== undefined
        ? decodeOutputTinyDigests({
            algorithm: 'buck2-tiny-digest-v1',
            outputs:
              Array.isArray(nativeOutputs) === true
                ? nativeOutputs.map((output, index) => ({
                    index,
                    tinyDigest: field({ value: output, key: 'tiny_digest' }),
                  }))
                : nativeOutputs,
          })
        : undefined
    const nativeName = field({ value: end, key: 'name' })
    const nativeIdentifier = field({ value: nativeName, key: 'identifier' })
    const row: ActionRecord = {
      type: 'action',
      buildId: safeIdentity({ value: buildId, grammar: /^[a-zA-Z0-9_.-]+$/ }),
      context: safeIdentity({ value: context, grammar: /^[a-zA-Z0-9_.:-]+$/ }),
      category: safeIdentity({ value: category, grammar: /^[a-zA-Z0-9_.-]+$/ }),
      identifier:
        typeof nativeName !== 'object' || nativeName === null || Array.isArray(nativeName) === true
          ? null
          : nativeIdentifier === undefined || nativeIdentifier === ''
            ? ''
            : typeof nativeIdentifier === 'string'
              ? `identifier-sha256-v1:${createHash('sha256')
                  .update('effect-utils/buck2-action-identifier/v1\0')
                  .update(nativeIdentifier)
                  .digest('hex')}`
              : null,
      exclusionReason,
      target: safeIdentity({ value: target, grammar: labelGrammar }),
      configuration: safeIdentity({ value: configuration, grammar: configurationGrammar }),
      digest: safeIdentity({ value: digest, grammar: /^[a-fA-F0-9]+:[0-9]+$/ }),
      executionKind,
      cacheUploadResult,
      outcome,
      cacheOutcome: outcome,
      uploadOutcome:
        cacheUploadResult === 1
          ? 'uploaded'
          : cacheUploadResult >= 9 && cacheUploadResult <= 15
            ? 'failed'
            : 'not-uploaded',
      startedAt: fallback?.startedAt ?? null,
      completedAt: time,
      endTime: time,
      uploadCompletedAt: cacheUploadResult === 1 ? time : null,
      commandAction,
      ...(uploadErrors === undefined ? {} : { uploadErrors }),
    }
    if (outputTinyDigests !== undefined) row.outputTinyDigests = outputTinyDigests
    if (
      row.buildId === null ||
      row.completedAt === null ||
      spanKey === undefined ||
      typeof actionKind !== 'string' ||
      knownActionKinds[actionKind] !== true ||
      typeof field({ value: end, key: 'execution_kind' }) !== 'number' ||
      typeof field({ value: end, key: 'cache_upload_result' }) !== 'number' ||
      executionKind === 5 ||
      executionKind > 11 ||
      executionKind < 0 ||
      Number.isSafeInteger(executionKind) === false ||
      cacheUploadResult > 16 ||
      cacheUploadResult < 0 ||
      Number.isSafeInteger(cacheUploadResult) === false ||
      (row.startedAt !== null && row.completedAt !== null && row.startedAt > row.completedAt) ||
      ((commandAction === true || executionKind === 3 || cacheUploadResult === 1) &&
        (row.category === null ||
          row.target === null ||
          row.configuration === null ||
          (row.digest === null && executionKind !== 10) ||
          row.startedAt === null))
    )
      invalidActionCount++
    onAction?.(row)
    if (row.digest === null || row.category === null || row.target === null || row.buildId === null)
      return
    retainRepresentative({
      rows: actions,
      action: {
        buildId: row.buildId,
        ...(row.context === null ? {} : { context: row.context }),
        category: row.category,
        exclusionReason,
        target: row.target,
        ...(row.configuration === null ? {} : { configuration: row.configuration }),
        digest: row.digest,
        outcome,
        executionKind,
        cacheUploadResult,
        ...(uploadErrors === undefined ? {} : { uploadErrors }),
        ...(outputTinyDigests === undefined ? {} : { outputTinyDigests }),
      },
    })
  }
  const finish = (): CacheEvidence => {
    if (buildId === undefined) throw new Error('Event file is missing its native trace id')
    onInvocation?.({
      buildId,
      ...(rootId === undefined ? {} : { rootId }),
      context: context ?? null,
      cacheReadPolicy,
      startedAt: invocationStartedAt,
      completedAt: invocationCompletedAt,
      freshRoot,
      actionCount,
      excludedByDesign: { ...excludedByDesign },
      complete:
        invalidActionCount === 0 &&
        starts.size === 0 &&
        invocationStartedAt !== null &&
        invocationCompletedAt !== null &&
        invocationCompletedAt >= invocationStartedAt,
    })
    const fallbackEvidence =
      archiveOriginFallbackReasons.some((reason) => archiveOriginFallbacks[reason] > 0) === true
        ? { archiveOriginFallbacks: { ...archiveOriginFallbacks } }
        : {}
    return {
      schemaVersion: 1,
      status: 'collected',
      ...withArchiveOriginFallbacks({
        admission: zeroAdmissionEvidence(),
        invocations: [fallbackEvidence],
      }),
      metadata: {},
      counts: { ...counts },
      excludedByDesign: { ...excludedByDesign },
      actionCount,
      // Includes nondigest/nonidentity actions; omission counters explain why.
      droppedActionCount: actionCount - actions.length,
      invocations: [
        {
          buildId,
          ...(context === undefined ? {} : { context }),
          counts: { ...counts },
          excludedByDesign: { ...excludedByDesign },
          actionCount,
          missingDigestCount,
          missingCommandDigestCount,
          noDigestReasons: { ...noDigestReasons },
          missingIdentityCount,
          unpairedStartCount: starts.size,
          ...fallbackEvidence,
        },
      ],
      actions: [...actions],
    }
  }
  return { add, finish }
}

/** Merge contexts fairly; duplicate native build ids preserve the first context. */
export const mergeCacheEvidence = ({
  previous,
  next,
}: {
  previous: CacheEvidence
  next: CacheEvidence
}): CacheEvidence => {
  if (
    previous.status === 'remote-cache-disabled-by-design' ||
    next.status === 'remote-cache-disabled-by-design'
  ) {
    throw new Error('Cannot combine disabled-by-design and collected cache evidence')
  }
  const admission = withArchiveOriginFallbacks({
    admission: collectAdmissionInvocations([
      ...(previous.admissionInvocations ?? []),
      ...(next.admissionInvocations ?? []),
    ]),
    invocations: [
      ...previous.invocations,
      ...next.invocations.filter(
        (item) =>
          previous.invocations.some(
            (priorInvocation) => priorInvocation.buildId === item.buildId,
          ) === false,
      ),
    ],
  })
  if (previous.status === 'no-native-logs') return { ...next, ...admission }
  if (next.status === 'no-native-logs') return { ...previous, ...admission }
  const seen = new Set(previous.invocations.map((item) => item.buildId))
  const additions = next.invocations.filter((item) => seen.has(item.buildId) === false)
  const addedIds = new Set(additions.map((item) => item.buildId))
  const invocations = [...previous.invocations, ...additions]
  const candidates = [
    ...previous.actions,
    ...next.actions.filter((item) => addedIds.has(item.buildId) === true),
  ]
  const buckets = invocations.map((invocation) =>
    candidates
      .filter((action) => invocationKey(action) === invocationKey(invocation))
      .toSorted((a, b) => compareRows({ a, b })),
  )
  const actions: CacheAction[] = []
  for (let round = 0; actions.length < maxCacheEvidenceActions; round++) {
    let added = false
    for (const bucket of buckets) {
      const action = bucket[round]
      if (action === undefined) continue
      actions.push(action)
      added = true
      if (actions.length === maxCacheEvidenceActions) break
    }
    if (added === false) break
  }
  const counts = zeroCounts()
  let actionCount = 0
  const excludedByDesign = zeroActionExclusionCounts()
  for (const invocation of invocations) {
    for (const outcome of cacheEvidenceOutcomes) counts[outcome] += invocation.counts[outcome]
    actionCount += invocation.actionCount
    if (invocation.excludedByDesign !== undefined)
      for (const reason of actionExclusionReasons)
        excludedByDesign[reason] += invocation.excludedByDesign[reason]
  }
  return {
    schemaVersion: 1,
    status: 'collected',
    ...admission,
    metadata: { ...previous.metadata, ...next.metadata },
    counts,
    ...(invocations.every((invocation) => invocation.excludedByDesign !== undefined) === true
      ? { excludedByDesign }
      : {}),
    actionCount,
    droppedActionCount: actionCount - actions.length,
    invocations,
    actions,
  }
}

const metadataKeys = [
  'repository',
  'runId',
  'runAttempt',
  'job',
  'headSha',
  'readOnly',
  'remoteCacheDisabled',
  'runnerOs',
  'runnerArch',
]
const decodeCounts = (value: unknown): OutcomeCounts => {
  const counts = zeroCounts()
  for (const outcome of cacheEvidenceOutcomes)
    counts[outcome] = count(field({ value: value, key: outcome }))
  return counts
}
const requiredText = (value: unknown): string => {
  const result = text(value)
  if (result === undefined) throw new Error('Invalid cache evidence identity')
  return result
}

/** Decode only allowlisted fields when appending; never copy arbitrary JSON. */
export const decodeCacheEvidence = (value: unknown): CacheEvidence => {
  const status = field({ value: value, key: 'status' })
  if (
    field({ value: value, key: 'schemaVersion' }) !== 1 ||
    (status !== 'collected' && status !== 'no-native-logs')
  ) {
    throw new Error('Unsupported cache evidence schema/status')
  }
  const invocationValues = field({ value: value, key: 'invocations' })
  const actionValues = field({ value: value, key: 'actions' })
  if (
    Array.isArray(invocationValues) === false ||
    Array.isArray(actionValues) === false ||
    actionValues.length > maxCacheEvidenceActions
  ) {
    throw new Error('Invalid cache evidence rows')
  }
  const invocations = invocationValues.map((item): CacheInvocation => {
    const invocation: CacheInvocation = {
      buildId: requiredText(field({ value: item, key: 'buildId' })),
      counts: decodeCounts(field({ value: item, key: 'counts' })),
      actionCount: count(field({ value: item, key: 'actionCount' })),
      missingDigestCount: count(field({ value: item, key: 'missingDigestCount' })),
      missingCommandDigestCount: count(field({ value: item, key: 'missingCommandDigestCount' })),
      missingIdentityCount: count(field({ value: item, key: 'missingIdentityCount' })),
      unpairedStartCount: count(field({ value: item, key: 'unpairedStartCount' })),
    }
    const excludedByDesign = field({ value: item, key: 'excludedByDesign' })
    if (excludedByDesign !== undefined)
      invocation.excludedByDesign = decodeActionExclusionCounts(excludedByDesign)
    const noDigestReasons = field({ value: item, key: 'noDigestReasons' })
    if (noDigestReasons !== undefined) invocation.noDigestReasons = decodeCounts(noDigestReasons)
    const archiveCounts = field({ value: item, key: 'archiveOriginFallbacks' })
    if (archiveCounts !== undefined)
      invocation.archiveOriginFallbacks = decodeArchiveOriginFallbacks(archiveCounts)
    const context = field({ value: item, key: 'context' })
    if (context !== undefined) invocation.context = requiredText(context)
    return invocation
  })
  const actions = actionValues.map((item): CacheAction => {
    const outcome = cacheEvidenceOutcomes.find(
      (candidate) => candidate === field({ value: item, key: 'outcome' }),
    )
    if (outcome === undefined) throw new Error('Invalid cache evidence outcome')
    const configuration = text(field({ value: item, key: 'configuration' }))
    const action: CacheAction = {
      buildId: requiredText(field({ value: item, key: 'buildId' })),
      category: requiredText(field({ value: item, key: 'category' })),
      exclusionReason: actionExclusionReason(requiredText(field({ value: item, key: 'category' }))),
      target: requiredText(field({ value: item, key: 'target' })),
      digest: requiredText(field({ value: item, key: 'digest' })),
      outcome,
      executionKind: count(field({ value: item, key: 'executionKind' })),
      cacheUploadResult: count(field({ value: item, key: 'cacheUploadResult' })),
    }
    const uploadErrors = decodeCacheUploadErrors(field({ value: item, key: 'uploadErrors' }))
    if (uploadErrors !== undefined) action.uploadErrors = uploadErrors
    const outputTinyDigests = decodeOutputTinyDigests(
      field({ value: item, key: 'outputTinyDigests' }),
    )
    if (outputTinyDigests !== undefined) action.outputTinyDigests = outputTinyDigests
    const exclusionReason = field({ value: item, key: 'exclusionReason' })
    if (exclusionReason !== undefined && exclusionReason !== action.exclusionReason)
      throw new Error('Invalid cache evidence exclusion reason')
    const context = field({ value: item, key: 'context' })
    if (context !== undefined) action.context = requiredText(context)
    if (configuration !== undefined) action.configuration = configuration
    return action
  })
  const metadata: Record<string, string> = {}
  for (const key of metadataKeys) {
    const entry = text(field({ value: field({ value: value, key: 'metadata' }), key: key }))
    if (entry !== undefined) metadata[key] = entry
  }
  return {
    schemaVersion: 1,
    status,
    ...decodeCacheAdmissionEvidence(value),
    ...(status === 'no-native-logs' ? { reason: 'No native Buck action logs observed.' } : {}),
    metadata,
    counts: decodeCounts(field({ value: value, key: 'counts' })),
    ...(field({ value, key: 'excludedByDesign' }) === undefined
      ? {}
      : {
          excludedByDesign: decodeActionExclusionCounts(field({ value, key: 'excludedByDesign' })),
        }),
    actionCount: count(field({ value: value, key: 'actionCount' })),
    droppedActionCount: count(field({ value: value, key: 'droppedActionCount' })),
    invocations,
    actions,
  }
}

export const disabledCacheEvidence = (): CacheEvidence => ({
  schemaVersion: 1,
  status: 'remote-cache-disabled-by-design',
  ...zeroAdmissionEvidence(),
  reason: 'In-Nix product reuse uses Nix substitution, not the shared Buck ActionCache.',
  metadata: {},
  counts: zeroCounts(),
  excludedByDesign: zeroActionExclusionCounts(),
  actionCount: 0,
  droppedActionCount: 0,
  invocations: [],
  actions: [],
})

export const emptyCacheEvidence = (): CacheEvidence => ({
  schemaVersion: 1,
  status: 'no-native-logs',
  ...zeroAdmissionEvidence(),
  reason: 'No native Buck action logs observed.',
  metadata: {},
  counts: zeroCounts(),
  excludedByDesign: zeroActionExclusionCounts(),
  actionCount: 0,
  droppedActionCount: 0,
  invocations: [],
  actions: [],
})

export const emptyActionArtifact = (status: CacheEvidence['status']): ActionArtifact => ({
  header: {
    type: 'header',
    schemaVersion: 1,
    cacheOutcomeMapping,
    metadata: {
      repo: null,
      runId: null,
      runAttempt: null,
      job: null,
      lane: null,
      headSha: null,
      posture: status === 'remote-cache-disabled-by-design' ? 'disabled-by-design' : 'read-only',
      startedAt: null,
      finishedAt: null,
    },
    status,
    complete: false,
    actionCount: 0,
    excludedByDesign: zeroActionExclusionCounts(),
    rows: 0,
    missingDigestCount: 0,
    missingIdentityCount: 0,
    missingTimestampCount: 0,
    droppedActionCount: 0,
    evidenceGaps: [],
    invocations: [],
  },
  actions: [],
})

/** Resolve freshness only after comparing actual native launches with all decoded IDs. */
export const finalizeNativeLogFreshness = ({
  invocations,
  confirmedBuildIds,
}: {
  invocations: ActionInvocation[]
  confirmedBuildIds: ReadonlySet<string>
}): boolean => {
  const decodedIds = new Set(invocations.map((item) => item.buildId))
  const rotated = [...confirmedBuildIds].some((buildId) => decodedIds.has(buildId) === false)
  const nativeInvocations = invocations.filter((item) => item.context === 'native-log')
  // Audits execute no actions and cannot populate the local action cache.
  const cacheBearingInvocations = nativeInvocations.filter((item) => item.actionCount > 0)
  const earliest = cacheBearingInvocations.reduce(
    (minimum, item) => Math.min(minimum, item.startedAt ?? Infinity),
    Infinity,
  )
  const earliestIds = new Set(
    cacheBearingInvocations
      .filter((item) => item.startedAt === earliest)
      .map((item) => item.buildId),
  )
  for (const invocation of nativeInvocations) {
    invocation.freshRoot =
      rotated === false &&
      invocation.freshRoot === true &&
      invocation.actionCount > 0 &&
      earliestIds.size === 1 &&
      invocation.startedAt === earliest
  }
  return rotated
}

const envTime = (key: string): number | null => {
  const value = process.env[key]
  if (value === undefined || /^[0-9]{1,16}$/.test(value) === false) return null
  const result = Number(value)
  return Number.isSafeInteger(result) === true ? result : null
}

const confirmedNativeBuildIds = async ({
  output,
  startedAt,
  finishedAt,
}: {
  output: string
  startedAt: number | null
  finishedAt: number | null
}): Promise<Set<string>> => {
  const confirmed = new Set<string>()
  const registry = Bun.file(`${output}.native-build-id-paths.jsonl`)
  // Legacy retained evidence has no registry and cannot establish rotation.
  if (startedAt === null || finishedAt === null || (await registry.exists()) === false)
    return confirmed
  if (registry.size > 4096 * 8192) return confirmed
  for (const line of (await registry.text()).split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const row: unknown = JSON.parse(line)
      const buildId = canonicalCacheAdmissionInvocationId(field({ value: row, key: 'buildId' }))
      const path = requiredText(field({ value: row, key: 'path' }))
      // Registry reads are bounded and deliberately serial to avoid opening thousands of files.
      // eslint-disable-next-line no-await-in-loop
      const info = await stat(path)
      if (info.isFile() === false || info.mtimeMs < startedAt || info.mtimeMs > finishedAt) continue
      if (info.size > 128) continue
      // eslint-disable-next-line no-await-in-loop -- Read only after the bounded stat guard.
      const nativeId = canonicalCacheAdmissionInvocationId((await Bun.file(path).text()).trim())
      if (nativeId === buildId) confirmed.add(buildId)
    } catch {
      // Reconciliation records malformed/missing native outputs as explicit gaps.
      // Preserve all other confirmed IDs and still write final diagnostic artifacts.
    }
  }
  return confirmed
}

const run = async (): Promise<void> => {
  // CLI-only consumers depend on this projection library; lazy loading avoids a static cycle.
  const { reconcileNativeShards, registerNativeShard, writeNativeShard } =
    await import('./buck2-cache-shards.ts')
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    strict: true,
    options: {
      events: { type: 'string' },
      output: { type: 'string' },
      context: { type: 'string' },
      'cache-read-policy': { type: 'string' },
      'actions-output': { type: 'string' },
      'fresh-root': { type: 'boolean', default: false },
      finalize: { type: 'boolean', default: false },
      'evidence-gap': { type: 'string' },
      'write-shard': { type: 'string' },
      'shard-build-id': { type: 'string' },
      'root-id': { type: 'string' },
      'register-native': { type: 'string' },
      'native-exit-code': { type: 'string' },
      'remote-cache-disabled-by-design': { type: 'boolean', default: false },
    },
  })
  const disabled = values['remote-cache-disabled-by-design']
  if (values.output === undefined || (disabled === true && values.events !== undefined)) {
    throw new Error(
      'Usage: --events <native-jsonl> --output <compact-json> [--context <label>], or --remote-cache-disabled-by-design --output <compact-json>',
    )
  }
  if (values.context !== undefined && /^[a-zA-Z0-9_.:-]{1,96}$/.test(values.context) === false) {
    throw new Error('Invalid evidence context label')
  }
  if (values['root-id'] !== undefined && /^[a-f0-9]{64}$/.test(values['root-id']) === false)
    throw new Error('Invalid root scope')
  if (values['register-native'] !== undefined) {
    console.log(
      await registerNativeShard({ output: values.output, buildId: values['register-native'] }),
    )
    return
  }
  if (values['write-shard'] !== undefined) {
    if (values['shard-build-id'] === undefined) throw new Error('Missing shard build ID')
    await writeNativeShard({
      output: values.output,
      events: values['write-shard'],
      buildId: values['shard-build-id'],
      freshRoot: values['fresh-root'],
      rootId: values['root-id'],
      context: values.context,
      cacheReadPolicy: decodeCacheReadPolicy(values['cache-read-policy'] ?? 'unknown'),
      exitCode:
        values['native-exit-code'] === undefined ? undefined : Number(values['native-exit-code']),
      onReady: () => console.log('ready'),
    })
    return
  }
  if (
    values['evidence-gap'] !== undefined &&
    /^[a-z][a-z0-9-]{0,95}$/.test(values['evidence-gap']) === false
  )
    throw new Error('Invalid evidence gap code')
  const actionsOutput =
    values['actions-output'] ?? join(dirname(values.output), actionsArtifactName)
  if (basename(actionsOutput) !== actionsArtifactName)
    throw new Error('Action artifact must use the canonical filename')
  let evidence = disabled === true ? disabledCacheEvidence() : emptyCacheEvidence()
  const previousSummary = Bun.file(values.output)
  let previous: CacheEvidence | undefined
  let full = emptyActionArtifact(evidence.status)
  let expectedNativeIds = new Set<string>()
  if (disabled === false && (await previousSummary.exists()) === true) {
    let previousValue: unknown
    try {
      previousValue = await previousSummary.json()
      previous = decodeCacheEvidence(previousValue)
    } catch {
      full.header.evidenceGaps.push('prior-summary-unreadable')
    }
    const previousActions = Bun.file(actionsOutput)
    if ((await previousActions.exists()) === true) {
      try {
        const bytes = new Uint8Array(await previousActions.arrayBuffer())
        const raw = gunzipSync(bytes, { maxOutputLength: maxActionArtifactBytes + 1024 * 1024 })
        const decoded = decodeActionArtifact(raw.toString('utf8'))
        decoded.header.evidenceGaps.push(...full.header.evidenceGaps)
        full = decoded
        const reference = field({ value: previousValue, key: 'actionsArtifact' })
        if (
          field({ value: reference, key: 'sha256' }) !==
            createHash('sha256').update(bytes).digest('hex') ||
          field({ value: reference, key: 'rows' }) !== full.actions.length
        )
          full.header.evidenceGaps.push('prior-artifact-reference-mismatch')
      } catch {
        full.header.evidenceGaps.push('prior-artifact-unreadable')
      }
    } else if ((previous?.actionCount ?? 0) > 0)
      full.header.evidenceGaps.push('prior-artifact-missing')
  }
  if (values.finalize === true && disabled === false) {
    const reconciled = await reconcileNativeShards({ output: values.output })
    evidence = mergeCacheEvidence({ previous: evidence, next: reconciled.summary })
    let mergedBytes = full.actions.reduce(
      (size, row) => size + Buffer.byteLength(JSON.stringify(row)) + 1,
      0,
    )
    for (const invocation of reconciled.artifact.header.invocations) {
      const existing = full.header.invocations.find((item) => item.buildId === invocation.buildId)
      if (existing !== undefined) {
        if (existing.rootId === undefined && invocation.rootId !== undefined)
          existing.rootId = invocation.rootId
        continue
      }
      full.header.invocations.push(invocation)
      for (const row of reconciled.artifact.actions.filter(
        (candidate) => candidate.buildId === invocation.buildId,
      )) {
        const size = Buffer.byteLength(JSON.stringify(row)) + 1
        if (mergedBytes + size > maxActionArtifactBytes) full.header.droppedActionCount++
        else {
          mergedBytes += size
          full.actions.push(row)
        }
      }
    }
    full.header.evidenceGaps.push(...reconciled.index.evidenceGaps)
    expectedNativeIds = new Set(reconciled.index.expectedBuildIds)
  }
  if (values['evidence-gap'] !== undefined) full.header.evidenceGaps.push(values['evidence-gap'])
  if (values.events !== undefined) {
    const rows: ActionRecord[] = []
    let rowBytes = full.actions.reduce(
      (total, row) => total + Buffer.byteLength(JSON.stringify(row)) + 1,
      0,
    )
    let dropped = 0
    const invocations: ActionInvocation[] = []
    const projector = createCacheEvidenceProjector({
      context: values.context,
      cacheReadPolicy: decodeCacheReadPolicy(values['cache-read-policy'] ?? 'unknown'),
      // Native-log candidates resolve by command start time at finalization.
      // Explicit proof contexts own independent wiped roots.
      freshRoot: values['fresh-root'] === true,
      rootId: values['root-id'],
      onAction: (row) => {
        const size = Buffer.byteLength(JSON.stringify(row)) + 1
        if (rowBytes + size > maxActionArtifactBytes) dropped++
        else {
          rowBytes += size
          rows.push(row)
        }
      },
      onInvocation: (invocation) => invocations.push(invocation),
    })
    const stream = createReadStream(values.events, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (line.trim().length === 0) continue
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          full.header.evidenceGaps.push('invalid-native-json')
          break
        }
        projector.add(value)
      }
      evidence = projector.finish()
      const invocation = invocations[0]
      if (
        invocation !== undefined &&
        full.header.invocations.some((item) => item.buildId === invocation.buildId) === false
      ) {
        for (const row of rows) full.actions.push(row)
        full.header.invocations.push(invocation)
        full.header.droppedActionCount += dropped
      }
    } catch {
      full.header.evidenceGaps.push('native-projection-failed')
      // Retain every available row even if a malformed invocation cannot be finalized.
      for (const row of rows) full.actions.push(row)
      full.header.droppedActionCount += dropped
    } finally {
      lines.close()
      stream.destroy()
    }
  }
  if (previous !== undefined) evidence = mergeCacheEvidence({ previous, next: evidence })
  // Admission IDs are independent of native build IDs: denied writers never start Buck.
  const admissionRows = [...(evidence.admissionInvocations ?? [])]
  const admissionFile = Bun.file(`${values.output}.admission.jsonl`)
  if ((await admissionFile.exists()) === true) {
    const stream = createReadStream(`${values.output}.admission.jsonl`, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (line.trim().length === 0) continue
        admissionRows.push(decodeCacheAdmissionInvocation(JSON.parse(line)))
      }
    } finally {
      lines.close()
      stream.destroy()
    }
  }
  Object.assign(
    evidence,
    withArchiveOriginFallbacks({
      admission: collectAdmissionInvocations(admissionRows),
      invocations: evidence.invocations,
    }),
  )
  const envFields = {
    repository: 'GITHUB_REPOSITORY',
    runId: 'GITHUB_RUN_ID',
    runAttempt: 'GITHUB_RUN_ATTEMPT',
    job: 'CI_BUCK2_CACHE_EVIDENCE_JOB',
    headSha: 'CI_BUCK2_CACHE_EVIDENCE_HEAD_SHA',
    readOnly: 'BUCK2_PUBLIC_CACHE_READ_ONLY',
    remoteCacheDisabled: 'BUCK2_NO_REMOTE_CACHE',
    runnerOs: 'RUNNER_OS',
    runnerArch: 'RUNNER_ARCH',
  }
  for (const [key, env] of Object.entries(envFields)) {
    const value = process.env[env]
    if (value !== undefined && /^[a-zA-Z0-9_./-]{1,160}$/.test(value) === true)
      evidence.metadata[key] = value
  }
  const header = full.header
  header.status = evidence.status
  header.metadata = {
    repo: safeIdentity({
      value: evidence.metadata.repository,
      grammar: /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/,
    }),
    runId: safeIdentity({ value: evidence.metadata.runId, grammar: /^[0-9]+$/ }),
    runAttempt: safeIdentity({ value: evidence.metadata.runAttempt, grammar: /^[0-9]+$/ }),
    job: safeIdentity({ value: evidence.metadata.job, grammar: /^[a-zA-Z0-9_.-]+$/ }),
    cell:
      process.env.CI_BUCK2_CACHE_EVIDENCE_JOB_NAME === undefined
        ? null
        : proofJobCell(process.env.CI_BUCK2_CACHE_EVIDENCE_JOB_NAME),
    lane:
      process.env.GITHUB_EVENT_NAME === 'merge_group'
        ? 'merge_group'
        : process.env.GITHUB_EVENT_NAME === 'pull_request' ||
            process.env.GITHUB_EVENT_NAME === 'pull_request_target'
          ? 'pr'
          : process.env.GITHUB_REF === 'refs/heads/main'
            ? evidence.metadata.readOnly === '0'
              ? 'main-writer'
              : 'main-reader'
            : null,
    headSha: safeIdentity({ value: evidence.metadata.headSha, grammar: /^[a-fA-F0-9]{40}$/ }),
    posture:
      disabled === true || evidence.metadata.remoteCacheDisabled === '1'
        ? 'disabled-by-design'
        : evidence.metadata.readOnly === '0'
          ? 'writer'
          : 'read-only',
    startedAt: header.metadata.startedAt ?? envTime('CI_BUCK2_CACHE_EVIDENCE_STARTED_AT'),
    finishedAt:
      values.finalize === true
        ? (envTime('CI_BUCK2_CACHE_EVIDENCE_FINISHED_AT') ?? Date.now())
        : header.metadata.finishedAt,
  }
  if (values.finalize === true) {
    const confirmedBuildIds = await confirmedNativeBuildIds({
      output: values.output,
      startedAt: header.metadata.startedAt,
      finishedAt: header.metadata.finishedAt,
    })
    if (finalizeNativeLogFreshness({ invocations: header.invocations, confirmedBuildIds }) === true)
      header.evidenceGaps.push('native-log-rotated')
    if (
      disabled === false &&
      header.invocations.some(
        (invocation) => expectedNativeIds.has(invocation.buildId) === false,
      ) === true
    )
      header.evidenceGaps.push('unregistered-native-invocation')
    for (const invocation of header.invocations) {
      if (invocationWithinJobWindow({ invocation, metadata: header.metadata }) === false) {
        invocation.freshRoot = false
        header.evidenceGaps.push('native-invocation-outside-job-window')
      }
    }
    const priorConfiguredActions = new Map<string, number>()
    for (const action of full.actions.toSorted(
      (a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity),
    )) {
      if (action.commandAction === false) continue
      const invocation = header.invocations.find((item) => item.buildId === action.buildId)
      const key =
        invocation?.rootId !== undefined &&
        action.category !== null &&
        action.target !== null &&
        action.configuration !== null &&
        typeof action.identifier === 'string'
          ? JSON.stringify([
              invocation.rootId,
              action.target,
              action.category,
              action.identifier,
              action.configuration,
            ])
          : undefined
      if (action.digest !== null) {
        if (key !== undefined && action.completedAt !== null)
          priorConfiguredActions.set(
            key,
            Math.min(priorConfiguredActions.get(key) ?? Infinity, action.completedAt),
          )
      } else if (
        action.executionKind !== 10 ||
        key === undefined ||
        action.startedAt === null ||
        (priorConfiguredActions.get(key) ?? Infinity) > action.startedAt
      )
        header.evidenceGaps.push('command-action-missing-native-digest')
    }
  }
  header.rows = full.actions.length
  header.actionCount = evidence.actionCount
  header.excludedByDesign = countActionExclusions(full.actions)
  header.missingDigestCount = full.actions.filter((row) => row.digest === null).length
  header.missingIdentityCount = full.actions.filter(
    (row) =>
      row.buildId === null ||
      row.category === null ||
      row.target === null ||
      row.configuration === null,
  ).length
  header.missingTimestampCount = full.actions.filter(
    (row) =>
      row.startedAt === null ||
      row.completedAt === null ||
      (row.cacheUploadResult === 1 && row.uploadCompletedAt === null),
  ).length
  if (header.droppedActionCount > 0) header.evidenceGaps.push('action-payload-size-limit')
  if (header.rows !== header.actionCount) header.evidenceGaps.push('action-count-mismatch')
  if (header.invocations.some((item) => item.complete === false) === true)
    header.evidenceGaps.push('incomplete-native-invocation')
  const metadataComplete = Object.values(header.metadata).every((item) => item !== null)
  if (values.finalize === true && metadataComplete === false)
    header.evidenceGaps.push('job-metadata-missing')
  header.evidenceGaps = [...new Set(header.evidenceGaps)].toSorted()
  header.complete =
    values.finalize === true &&
    metadataComplete === true &&
    header.evidenceGaps.length === 0 &&
    header.status !== 'no-native-logs'
  header.invocations.sort(
    (left, right) =>
      (left.startedAt ?? Infinity) - (right.startedAt ?? Infinity) ||
      (left.buildId < right.buildId ? -1 : left.buildId > right.buildId ? 1 : 0),
  )
  full.actions.sort((left, right) => {
    const a = JSON.stringify([
      left.buildId,
      left.completedAt,
      left.category,
      left.target,
      left.configuration,
      left.digest,
      left.startedAt,
      left.executionKind,
      left.cacheUploadResult,
    ])
    const b = JSON.stringify([
      right.buildId,
      right.completedAt,
      right.category,
      right.target,
      right.configuration,
      right.digest,
      right.startedAt,
      right.executionKind,
      right.cacheUploadResult,
    ])
    return a < b ? -1 : a > b ? 1 : 0
  })
  const raw = `${JSON.stringify(header)}\n${full.actions.map((row) => JSON.stringify(row)).join('\n')}${full.actions.length === 0 ? '' : '\n'}`
  const bytes = gzipSync(raw, { level: 9 })
  await Bun.write(actionsOutput, bytes)
  evidence.cacheOutcomeMapping = cacheOutcomeMapping
  evidence.actionsArtifact = {
    name: actionsArtifactName,
    rows: header.rows,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
    uncompressedBytes: Buffer.byteLength(raw),
    complete: header.complete,
    droppedActionCount: header.droppedActionCount,
  }
  await Bun.write(values.output, `${JSON.stringify(evidence)}\n`)
  if (values.finalize === true)
    await (
      await import('./buck2-cache-proof-reports.ts')
    ).writeBuck2CacheProofReports({
      summaryPath: values.output,
      actionsPath: actionsOutput,
      shardIndexPath: `${values.output}.shard-index.json`,
    })
  if (values.finalize === true && process.env.GITHUB_STEP_SUMMARY !== undefined) {
    const admission = decodeCacheAdmissionEvidence(evidence)
    const summary = Bun.file(process.env.GITHUB_STEP_SUMMARY)
    const previousText = (await summary.exists()) === true ? await summary.text() : ''
    const rows = admission.admissionInvocations.map(
      (invocation) =>
        `| ${invocation.invocationId} | ${invocation.admissionFallbacks.reapi} | ${invocation.admissionFallbacks.archiveOrigin} | ${invocation.admissionRetrySuccesses.reapi} | ${invocation.admissionRetrySuccesses.archiveOrigin} |`,
    )
    const counts = admission.archiveOriginFallbacks
    const acquisitionSummary =
      counts === undefined
        ? ''
        : `\n### Archive acquisition fallbacks\n\n| 404 miss | Header timeout | Connection error | CAS 5xx |\n| ---: | ---: | ---: | ---: |\n| ${counts['not-found']} | ${counts['headers-timeout']} | ${counts['connection-error']} | ${counts['server-error']} |\n`
    await Bun.write(
      summary,
      `${previousText}\n### Buck cache admission\n\n| Invocation ID | REAPI fallbacks | Archive fallbacks | REAPI retry successes | Archive retry successes |\n| --- | ---: | ---: | ---: | ---: |\n| Total | ${admission.admissionFallbacks.reapi} | ${admission.admissionFallbacks.archiveOrigin} | ${admission.admissionRetrySuccesses.reapi} | ${admission.admissionRetrySuccesses.archiveOrigin} |\n${rows.join('\n')}\n${acquisitionSummary}`,
    )
  }
  if (values.finalize === true && header.complete === false) {
    console.error('Cache action evidence incomplete; observation is invalid.')
    process.exitCode = 2
  }
  const inconsistent = evidence.invocations.reduce(
    (total, invocation) =>
      total +
      (invocation.noDigestReasons?.['remote-hit'] ?? 0) +
      (invocation.noDigestReasons?.uploaded ?? 0),
    0,
  )
  if (inconsistent > 0) {
    console.error(
      `Cache evidence: ${inconsistent} remote-hit/uploaded action(s) have no native action digest; artifact records inconsistencies.`,
    )
    process.exitCode = values.finalize === true ? 2 : 1
  }
}

if (import.meta.main) {
  await run().catch(() => {
    // Native payloads and input/output filesystem paths must not leak via errors.
    console.error(
      'Cache evidence collection failed: invalid arguments, native input, or existing evidence.',
    )
    process.exitCode = 1
  })
}
