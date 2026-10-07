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
 *
 * Outcomes use data.proto's numeric enums, not command cache_hit booleans.
 * Digests are the exact native RE ActionCache `hash:size`, NOT output tiny_digest.
 * End spans repeat identity; active starts supply only a fallback. The compact
 * view stays bounded; an optional sink receives every normalized action row.
 */
import { createReadStream } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'
import { gzipSync, gunzipSync } from 'node:zlib'

import { decodeActionArtifact } from './buck2-action-evidence-codec.ts'
import {
  actionsArtifactName,
  cacheOutcomeMapping,
  invocationWithinJobWindow,
  maxActionArtifactBytes,
  outcomeFor,
  type ActionArtifact,
  type ActionInvocation,
  type ActionRecord,
} from './buck2-action-evidence.ts'

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
export type CacheAdmissionInvocation = {
  invocationId: string
  admissionFallbacks: { reapi: number; archiveOrigin: number }
  admissionRetrySuccesses: { reapi: number; archiveOrigin: number }
}
type CacheAdmissionEvidence = {
  admissionFallbacks: CacheAdmissionInvocation['admissionFallbacks']
  admissionRetrySuccesses: CacheAdmissionInvocation['admissionRetrySuccesses']
  admissionInvocations: CacheAdmissionInvocation[]
}
export type CacheAction = {
  buildId: string
  context?: string
  category: string
  target: string
  configuration?: string
  digest: string
  outcome: CacheOutcome
  executionKind: number
  cacheUploadResult: number
}
export type CacheInvocation = {
  buildId: string
  context?: string
  counts: OutcomeCounts
  actionCount: number
  missingDigestCount: number
  missingCommandDigestCount: number
  /** Missing native digests grouped by outcome; absent on older retained artifacts. */
  noDigestReasons?: OutcomeCounts
  missingIdentityCount: number
  unpairedStartCount: number
}
export type CacheEvidence = {
  schemaVersion: 1
  status: 'collected' | 'remote-cache-disabled-by-design' | 'no-native-logs'
  /** Absent only on retained summaries written before admission collection. */
  admissionFallbacks?: CacheAdmissionInvocation['admissionFallbacks']
  admissionRetrySuccesses?: CacheAdmissionInvocation['admissionRetrySuccesses']
  admissionInvocations?: CacheAdmissionInvocation[]
  reason?: string
  metadata: Record<string, string>
  counts: OutcomeCounts
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
})
const decodeAdmissionCounters = (
  value: unknown,
): CacheAdmissionInvocation['admissionFallbacks'] => ({
  reapi: count(field({ value, key: 'reapi' })),
  archiveOrigin: count(field({ value, key: 'archiveOrigin' })),
})
export const decodeCacheAdmissionInvocation = (value: unknown): CacheAdmissionInvocation => {
  const invocationId = text(field({ value, key: 'invocationId' }))
  if (
    invocationId === undefined ||
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(invocationId) === false
  )
    throw new Error('Invalid cache admission invocation ID')
  const admissionFallbacks = decodeAdmissionCounters(field({ value, key: 'admissionFallbacks' }))
  const admissionRetrySuccesses = decodeAdmissionCounters(
    field({ value, key: 'admissionRetrySuccesses' }),
  )
  for (const endpoint of admissionEndpoints) {
    if (admissionFallbacks[endpoint] + admissionRetrySuccesses[endpoint] > 1)
      throw new Error('Invalid cache admission invocation counters')
  }
  return { invocationId: invocationId.toLowerCase(), admissionFallbacks, admissionRetrySuccesses }
}
const collectAdmissionInvocations = (
  invocations: CacheAdmissionInvocation[],
): CacheAdmissionEvidence => {
  const result = zeroAdmissionEvidence()
  const seen = new Map<string, CacheAdmissionInvocation>()
  for (const invocation of invocations) {
    const previous = seen.get(invocation.invocationId)
    if (previous !== undefined) {
      if (JSON.stringify(previous) !== JSON.stringify(invocation))
        throw new Error('Conflicting cache admission invocation')
      continue
    }
    seen.set(invocation.invocationId, invocation)
    result.admissionInvocations.push(invocation)
    for (const endpoint of admissionEndpoints) {
      result.admissionFallbacks[endpoint] += invocation.admissionFallbacks[endpoint]
      result.admissionRetrySuccesses[endpoint] += invocation.admissionRetrySuccesses[endpoint]
    }
  }
  return result
}
/** Legacy v1 summaries omit all admission fields; present fields remain strictly validated. */
export const decodeCacheAdmissionEvidence = (value: unknown): CacheAdmissionEvidence => {
  const rows = field({ value, key: 'admissionInvocations' })
  if (rows !== undefined && Array.isArray(rows) === false)
    throw new Error('Invalid cache admission invocations')
  const result = collectAdmissionInvocations(
    rows === undefined ? [] : rows.map(decodeCacheAdmissionInvocation),
  )
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
const safeIdentity = (value: string | undefined, grammar: RegExp): string | null =>
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

/** Pure incremental projector: add one decoded JSONL value, finish once. */
export const createCacheEvidenceProjector = ({
  context,
  onAction,
  onInvocation,
  freshRoot = false,
}: {
  context?: string
  onAction?: (action: ActionRecord) => void
  onInvocation?: (invocation: ActionInvocation) => void
  freshRoot?: boolean
} = {}): {
  add: (value: unknown) => void
  finish: () => CacheEvidence
} => {
  let buildId: string | undefined
  const starts = new Map<string, { identity: Identity; startedAt: number | null }>()
  const ended = new Set<string>()
  let invocationStartedAt: number | null = null
  let invocationCompletedAt: number | null = null
  let invalidActionCount = 0
  const actions: CacheAction[] = []
  const counts = zeroCounts()
  let actionCount = 0
  let missingDigestCount = 0
  let missingCommandDigestCount = 0
  let missingIdentityCount = 0
  const noDigestReasons = zeroCounts()
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
    const spanId = field({ value: event, key: 'span_id' })
    // Large u64 ids must not be rounded into a false start/end pairing.
    const spanKey =
      typeof spanId === 'string'
        ? spanId
        : typeof spanId === 'number' && Number.isSafeInteger(spanId) === true
          ? String(spanId)
          : undefined
    const data = field({ value: event, key: 'data' })
    const time = eventTime(event)
    const startData = field({ value: field({ value: data, key: 'SpanStart' }), key: 'data' })
    const endData = field({ value: field({ value: data, key: 'SpanEnd' }), key: 'data' })
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
    if (end === undefined) return
    if (spanKey !== undefined) {
      if (ended.has(spanKey) === true) return
      ended.add(spanKey)
    }
    const fallback = spanKey === undefined ? undefined : starts.get(spanKey)
    if (spanKey !== undefined) starts.delete(spanKey)
    const identity = identityFor(end)
    const category = identity.category ?? fallback?.identity.category
    const target = identity.target ?? fallback?.identity.target
    const configuration = identity.configuration ?? fallback?.identity.configuration
    const executionKind = nativeEnum(field({ value: end, key: 'execution_kind' }))
    const cacheUploadResult = nativeEnum(field({ value: end, key: 'cache_upload_result' }))
    const outcome = outcomeFor({ executionKind: executionKind, uploadResult: cacheUploadResult })
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
    const row: ActionRecord = {
      type: 'action',
      buildId: safeIdentity(buildId, /^[a-zA-Z0-9_.-]+$/),
      context: safeIdentity(context, /^[a-zA-Z0-9_.:-]+$/),
      category: safeIdentity(category, /^[a-zA-Z0-9_.-]+$/),
      target: safeIdentity(target, labelGrammar),
      configuration: safeIdentity(configuration, configurationGrammar),
      digest: safeIdentity(digest, /^[a-fA-F0-9]+:[0-9]+$/),
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
    }
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
          (row.digest === null && (executionKind !== 10 || cacheUploadResult === 1)) ||
          row.startedAt === null))
    )
      invalidActionCount++
    onAction?.(row)
    if (digest === undefined || category === undefined || target === undefined) return
    if (buildId === undefined) throw new Error('Action event is missing its native trace id')
    retainRepresentative({
      rows: actions,
      action: {
        buildId,
        ...(context === undefined ? {} : { context }),
        category,
        target,
        ...(configuration === undefined ? {} : { configuration }),
        digest,
        outcome,
        executionKind,
        cacheUploadResult,
      },
    })
  }
  const finish = (): CacheEvidence => {
    if (buildId === undefined) throw new Error('Event file is missing its native trace id')
    onInvocation?.({
      buildId,
      context: context ?? null,
      startedAt: invocationStartedAt,
      completedAt: invocationCompletedAt,
      freshRoot,
      actionCount,
      complete:
        invalidActionCount === 0 &&
        starts.size === 0 &&
        invocationStartedAt !== null &&
        invocationCompletedAt !== null &&
        invocationCompletedAt >= invocationStartedAt,
    })
    return {
      schemaVersion: 1,
      status: 'collected',
      ...zeroAdmissionEvidence(),
      metadata: {},
      counts: { ...counts },
      actionCount,
      // Includes nondigest/nonidentity actions; omission counters explain why.
      droppedActionCount: actionCount - actions.length,
      invocations: [
        {
          buildId,
          ...(context === undefined ? {} : { context }),
          counts: { ...counts },
          actionCount,
          missingDigestCount,
          missingCommandDigestCount,
          noDigestReasons: { ...noDigestReasons },
          missingIdentityCount,
          unpairedStartCount: starts.size,
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
  const admission = collectAdmissionInvocations([
    ...(previous.admissionInvocations ?? []),
    ...(next.admissionInvocations ?? []),
  ])
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
  for (const invocation of invocations) {
    for (const outcome of cacheEvidenceOutcomes) counts[outcome] += invocation.counts[outcome]
    actionCount += invocation.actionCount
  }
  return {
    schemaVersion: 1,
    status: 'collected',
    ...admission,
    metadata: { ...previous.metadata, ...next.metadata },
    counts,
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
    const noDigestReasons = field({ value: item, key: 'noDigestReasons' })
    if (noDigestReasons !== undefined) invocation.noDigestReasons = decodeCounts(noDigestReasons)
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
      target: requiredText(field({ value: item, key: 'target' })),
      digest: requiredText(field({ value: item, key: 'digest' })),
      outcome,
      executionKind: count(field({ value: item, key: 'executionKind' })),
      cacheUploadResult: count(field({ value: item, key: 'cacheUploadResult' })),
    }
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
  actionCount: 0,
  droppedActionCount: 0,
  invocations: [],
  actions: [],
})

const emptyActionArtifact = (status: CacheEvidence['status']): ActionArtifact => ({
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

const envTime = (key: string): number | null => {
  const value = process.env[key]
  if (value === undefined || /^[0-9]{1,16}$/.test(value) === false) return null
  const result = Number(value)
  return Number.isSafeInteger(result) === true ? result : null
}

const run = async (): Promise<void> => {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    strict: true,
    options: {
      events: { type: 'string' },
      output: { type: 'string' },
      context: { type: 'string' },
      'actions-output': { type: 'string' },
      'fresh-root': { type: 'boolean', default: false },
      finalize: { type: 'boolean', default: false },
      'evidence-gap': { type: 'string' },
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
      // Native-log candidates resolve by command start time at finalization.
      // Explicit proof contexts own independent wiped roots.
      freshRoot: values['fresh-root'] === true,
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
  Object.assign(evidence, collectAdmissionInvocations(admissionRows))
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
  if (values.finalize === true) {
    // Audits execute no actions and cannot populate the local action cache.
    const nativeInvocations = header.invocations.filter((item) => item.context === 'native-log')
    const cacheBearingInvocations = nativeInvocations.filter((item) => item.actionCount > 0)
    const earliest = cacheBearingInvocations.reduce(
      (minimum, item) => Math.min(minimum, item.startedAt ?? Infinity),
      Infinity,
    )
    const tied = cacheBearingInvocations.filter((item) => item.startedAt === earliest).length !== 1
    for (const invocation of nativeInvocations) {
      invocation.freshRoot =
        invocation.freshRoot === true &&
        invocation.actionCount > 0 &&
        tied === false &&
        invocation.startedAt === earliest
    }
  }
  header.metadata = {
    repo: safeIdentity(evidence.metadata.repository, /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
    runId: safeIdentity(evidence.metadata.runId, /^[0-9]+$/),
    runAttempt: safeIdentity(evidence.metadata.runAttempt, /^[0-9]+$/),
    job: safeIdentity(evidence.metadata.job, /^[a-zA-Z0-9_.-]+$/),
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
    headSha: safeIdentity(evidence.metadata.headSha, /^[a-fA-F0-9]{40}$/),
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
    for (const invocation of header.invocations) {
      if (!invocationWithinJobWindow(invocation, header.metadata)) {
        invocation.freshRoot = false
        header.evidenceGaps.push('native-invocation-outside-job-window')
      }
    }
    // Buck's LocalActionCache hits omit command metadata (including the RE action
    // digest). Preserve those rows, but permit the omission only outside freshness.
    for (const action of full.actions) {
      if (action.commandAction && action.executionKind === 10 && action.digest === null) {
        const invocation = header.invocations.find((item) => item.buildId === action.buildId)
        if (invocation === undefined || invocation.freshRoot)
          header.evidenceGaps.push('fresh-local-cache-action-missing-digest')
      }
    }
  }
  header.rows = full.actions.length
  header.actionCount = evidence.actionCount
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
  header.evidenceGaps = [...new Set(header.evidenceGaps)].sort()
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
  if (values.finalize === true && process.env.GITHUB_STEP_SUMMARY !== undefined) {
    const admission = decodeCacheAdmissionEvidence(evidence)
    const summary = Bun.file(process.env.GITHUB_STEP_SUMMARY)
    const previousText = (await summary.exists()) === true ? await summary.text() : ''
    const rows = admission.admissionInvocations.map(
      (invocation) =>
        `| ${invocation.invocationId} | ${invocation.admissionFallbacks.reapi} | ${invocation.admissionFallbacks.archiveOrigin} | ${invocation.admissionRetrySuccesses.reapi} | ${invocation.admissionRetrySuccesses.archiveOrigin} |`,
    )
    await Bun.write(
      summary,
      `${previousText}\n### Buck cache admission\n\n| Invocation ID | REAPI fallbacks | Archive fallbacks | REAPI retry successes | Archive retry successes |\n| --- | ---: | ---: | ---: | ---: |\n| Total | ${admission.admissionFallbacks.reapi} | ${admission.admissionFallbacks.archiveOrigin} | ${admission.admissionRetrySuccesses.reapi} | ${admission.admissionRetrySuccesses.archiveOrigin} |\n${rows.join('\n')}\n`,
    )
  }
  if (values.finalize === true && header.complete === false) {
    console.error('Cache action evidence incomplete; observation is invalid.')
    process.exitCode = 1
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
    process.exitCode = 1
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
