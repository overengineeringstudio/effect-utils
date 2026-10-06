#!/usr/bin/env bun
/**
 * Project pinned Buck2 `log show` JSONL, never command/environment/log payloads.
 *
 * bun genie/ci-scripts/buck2-cache-evidence.ts --events show.jsonl --output evidence.json --context proof-a-build
 * Reusing --output appends new build ids; duplicate logs preserve the first context.
 * --remote-cache-disabled-by-design --output evidence.json records the in-Nix exclusion.
 * --output evidence.json alone initializes honest no-native-logs evidence.
 *
 * Outcomes use data.proto's numeric enums, not command cache_hit booleans.
 * Digests are the exact native RE ActionCache `hash:size`, NOT output tiny_digest.
 * End spans repeat identity; active starts supply only a fallback. Memory retains
 * active action identities and at most 64 representatives, not the event stream.
 */
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { parseArgs } from 'node:util'

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
  missingIdentityCount: number
  unpairedStartCount: number
}
export type CacheEvidence = {
  schemaVersion: 1
  status: 'collected' | 'remote-cache-disabled-by-design' | 'no-native-logs'
  reason?: string
  metadata: Record<string, string>
  counts: OutcomeCounts
  actionCount: number
  droppedActionCount: number
  invocations: CacheInvocation[]
  actions: CacheAction[]
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
const outcomeFor = ({
  executionKind,
  uploadResult,
}: {
  executionKind: number
  uploadResult: number
}): CacheOutcome => {
  if (uploadResult === 1) return 'uploaded'
  switch (executionKind) {
    case 1:
    case 8:
      return 'local'
    case 3:
      return 'remote-hit'
    case 7:
    case 10:
      return 'local-cache'
    case 2:
    case 11:
      return 'remote-execution'
    case 9:
      return 'remote-dep-file-hit'
    default:
      return 'other'
  }
}

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

/** Pure incremental projector: add one decoded JSONL value, finish once. */
export const createCacheEvidenceProjector = ({ context }: { context?: string } = {}): {
  add: (value: unknown) => void
  finish: () => CacheEvidence
} => {
  let buildId: string | undefined
  const starts = new Map<string, Identity>()
  const actions: CacheAction[] = []
  const counts = zeroCounts()
  let actionCount = 0
  let missingDigestCount = 0
  let missingCommandDigestCount = 0
  let missingIdentityCount = 0
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
    const start = field({
      value: field({ value: field({ value: data, key: 'SpanStart' }), key: 'data' }),
      key: 'ActionExecution',
    })
    if (start !== undefined && spanKey !== undefined) starts.set(spanKey, identityFor(start))
    const end = field({
      value: field({ value: field({ value: data, key: 'SpanEnd' }), key: 'data' }),
      key: 'ActionExecution',
    })
    if (end === undefined) return
    const fallback = spanKey === undefined ? undefined : starts.get(spanKey)
    if (spanKey !== undefined) starts.delete(spanKey)
    const identity = identityFor(end)
    const category = identity.category ?? fallback?.category
    const target = identity.target ?? fallback?.target
    const configuration = identity.configuration ?? fallback?.configuration
    const executionKind = nativeEnum(field({ value: end, key: 'execution_kind' }))
    const cacheUploadResult = nativeEnum(field({ value: end, key: 'cache_upload_result' }))
    const outcome = outcomeFor({ executionKind: executionKind, uploadResult: cacheUploadResult })
    counts[outcome]++
    actionCount++
    const digest = digestFor(end)
    if (digest === undefined) {
      missingDigestCount++
      if (
        field({ value: end, key: 'kind' }) === 'Run' ||
        cacheUploadResult === 1 ||
        executionKind === 3
      )
        missingCommandDigestCount++
    }
    if (category === undefined || target === undefined) missingIdentityCount++
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
    return {
      schemaVersion: 1,
      status: 'collected',
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
  if (previous.status === 'no-native-logs') return next
  if (next.status === 'no-native-logs') return previous
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
  reason: 'No native Buck action logs observed.',
  metadata: {},
  counts: zeroCounts(),
  actionCount: 0,
  droppedActionCount: 0,
  invocations: [],
  actions: [],
})

const run = async (): Promise<void> => {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    strict: true,
    options: {
      events: { type: 'string' },
      output: { type: 'string' },
      context: { type: 'string' },
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
  let evidence = disabled === true ? disabledCacheEvidence() : emptyCacheEvidence()
  if (values.events !== undefined) {
    const projector = createCacheEvidenceProjector({ context: values.context })
    const stream = createReadStream(values.events, { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    let lineNumber = 0
    try {
      for await (const line of lines) {
        lineNumber++
        if (line.trim().length === 0) continue
        let value: unknown
        try {
          value = JSON.parse(line)
        } catch {
          throw new Error(`Invalid native JSON on line ${lineNumber}`)
        }
        projector.add(value)
      }
      evidence = projector.finish()
    } finally {
      lines.close()
      stream.destroy()
    }
  }
  if (disabled === false) {
    const previous = Bun.file(values.output)
    if ((await previous.exists()) === true) {
      evidence = mergeCacheEvidence({
        previous: decodeCacheEvidence(await previous.json()),
        next: evidence,
      })
    }
  }
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
  await Bun.write(values.output, `${JSON.stringify(evidence)}\n`)
  const missing = evidence.invocations.reduce(
    (total, invocation) => total + invocation.missingCommandDigestCount,
    0,
  )
  if (missing > 0) {
    console.error(
      `Cache evidence: ${missing} command action(s) have no native action digest; artifact records omissions.`,
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
