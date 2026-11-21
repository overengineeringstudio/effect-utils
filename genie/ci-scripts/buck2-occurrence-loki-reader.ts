import { createHash } from 'node:crypto'

import { Effect, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'

import {
  cacheOutcomeMapping,
  zeroActionExclusionCounts,
  type ActionArtifact,
} from './buck2-action-evidence.ts'
import {
  aggregateOccurrences,
  previousUtcDay,
  renderOccurrenceOtlp,
  type OccurrenceScorecard,
} from './buck2-cache-join.ts'
import type { RetainedOccurrenceFile } from './buck2-occurrence-record-codec.ts'
import {
  reconcileOccurrenceRecords,
  type OccurrenceEvidenceRecord,
} from './buck2-occurrence-records.ts'

class ReaderError extends Schema.TaggedError<ReaderError>()('ReaderError', {
  message: Schema.String,
}) {}
const error = (message: string) => new ReaderError({ message })
export interface ReaderOptions {
  lokiUrl: string
  mimirUrl: string
  expectedHosts: readonly string[]
  now: number
  maxRuntimeMs: number
  queryTimeoutMs: number
}
const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) === true)
    throw error('invalid-response')
  return value as Record<string, unknown>
}
const array = (value: unknown): unknown[] => {
  if (Array.isArray(value) === false) throw error('invalid-response')
  return value
}
const attempt = <A>(body: () => A) =>
  Effect.try({ try: body, catch: () => error('invalid-response') })

/** DRAFT producer contract: #2656 at 7a7eef1005c1a3ad3908f9c726cb20663e2e4c16. */
export const reassembleSnapshots = (lines: readonly string[]) => {
  const gaps = new Set<string>()
  const snapshots = new Map<
    string,
    { count: number; lines: Map<number, string>; invalid: boolean }
  >()
  for (const line of lines) {
    try {
      const envelope = object(JSON.parse(line))
      if (envelope.type !== 'buck2.occurrence.ledger') {
        gaps.add('unparsable-envelope')
        continue
      }
      if (envelope.version !== 1) {
        gaps.add('unknown-envelope-version')
        continue
      }
      const { snapshotSha256: hash, ordinal, recordCount: count, line: body } = envelope
      if (
        typeof hash !== 'string' ||
        /^[a-f0-9]{64}$/.test(hash) === false ||
        typeof body !== 'string' ||
        body.includes('\n') === true ||
        Number.isSafeInteger(ordinal) === false ||
        Number.isSafeInteger(count) === false ||
        Number(count) <= 0 ||
        Number(ordinal) < 0 ||
        Number(ordinal) >= Number(count)
      ) {
        gaps.add('unparsable-envelope')
        continue
      }
      const snapshot = snapshots.get(hash) ?? {
        count: Number(count),
        lines: new Map<number, string>(),
        invalid: false,
      }
      snapshots.set(hash, snapshot)
      if (snapshot.count !== count) {
        gaps.add('record-count-mismatch')
        snapshot.invalid = true
      }
      const previous = snapshot.lines.get(Number(ordinal))
      if (previous !== undefined && previous !== body) {
        gaps.add('conflicting-ordinal')
        snapshot.invalid = true
      }
      snapshot.lines.set(Number(ordinal), body)
    } catch {
      gaps.add('unparsable-envelope')
    }
  }
  const files: RetainedOccurrenceFile[] = []
  for (const [hash, snapshot] of snapshots) {
    if (snapshot.lines.size !== snapshot.count) {
      gaps.add('missing-ordinal')
      continue
    }
    if (snapshot.invalid === true) continue
    const body = [...snapshot.lines]
      .toSorted(([a], [b]) => a - b)
      .map(([, line]) => `${line}\n`)
      .join('')
    if (createHash('sha256').update(body).digest('hex') !== hash) {
      gaps.add('hash-mismatch')
      continue
    }
    files.push({ name: `${hash}.jsonl`, body })
  }
  return { files, evidenceGaps: [...gaps].toSorted() }
}

/** Query boundaries are inclusive Loki nanoseconds, so children never overlap. */
export const readPartitions = (options: {
  start: bigint
  end: bigint
  limit: number
  limitKnown: boolean
  query: (start: bigint, end: bigint) => Effect.Effect<readonly string[], ReaderError>
}) =>
  Effect.gen(function* () {
    const lines: string[] = []
    const gaps = new Set<string>()
    const pending: [bigint, bigint][] = [[options.start, options.end]]
    while (pending.length > 0) {
      const [start, end] = pending.pop()!
      const entries = yield* options.query(start, end)
      if (entries.length >= options.limit) {
        if (start === end) {
          gaps.add('saturated-timestamp')
          continue
        }
        const middle = (start + end) / 2n
        pending.push([middle + 1n, end], [start, middle])
      } else {
        if (options.limitKnown === false && entries.length > 0) gaps.add('unknown-query-limit')
        lines.push(...entries)
      }
    }
    return { lines, evidenceGaps: [...gaps] }
  })

export const assertReadWindow = ({
  now,
  start,
  end,
}: {
  now: number
  start: number
  end: number
}) => {
  if (
    Number.isSafeInteger(now) === false ||
    Number.isSafeInteger(start) === false ||
    Number.isSafeInteger(end) === false ||
    start < now - 48 * 3600_000 ||
    start >= end ||
    end > now
  )
    throw error('outside-48h-window')
}

// The adapter only reshapes validated records; it does not attest extra provenance.
const artifact = (record: OccurrenceEvidenceRecord): ActionArtifact => ({
  header: {
    type: 'header',
    schemaVersion: 1,
    cacheOutcomeMapping,
    metadata: {
      repo: null,
      host: record.host,
      runId: record.runId,
      runAttempt: null,
      job: null,
      lane:
        record.lane === 'main-reader' ||
        record.lane === 'main-writer' ||
        record.lane === 'merge_group' ||
        record.lane === 'pr'
          ? record.lane
          : null,
      headSha: null,
      posture: 'read-only',
      startedAt: record.startedAt,
      finishedAt: record.completedAt,
    },
    status: 'collected',
    complete: true,
    actionCount: 1,
    rows: 1,
    excludedByDesign: zeroActionExclusionCounts(),
    missingDigestCount: 0,
    missingIdentityCount: 0,
    missingTimestampCount: 0,
    droppedActionCount: 0,
    evidenceGaps: [],
    invocations: [
      {
        buildId: record.buildId,
        ...(record.rootId === null ? {} : { rootId: record.rootId }),
        context: null,
        cacheReadPolicy: 'unknown',
        startedAt: record.startedAt,
        completedAt: record.completedAt,
        freshRoot: false,
        actionCount: 1,
        excludedByDesign: zeroActionExclusionCounts(),
        complete: true,
      },
    ],
  },
  actions: [
    {
      type: 'action',
      occurrenceId: record.id,
      host: record.host,
      executionOutcome: record.executionOutcome === 'failed' ? 'unknown' : record.executionOutcome,
      durationNs: record.durationNs,
      totalBytes: record.totalBytes,
      buildId: record.buildId,
      context: null,
      category: null,
      target: null,
      exclusionReason: null,
      configuration: null,
      digest: record.digest,
      executionKind: 0,
      cacheUploadResult: 0,
      outcome: 'other',
      cacheOutcome: 'other',
      uploadOutcome: 'not-uploaded',
      startedAt: record.startedAt,
      completedAt: record.completedAt,
      endTime: record.completedAt,
      uploadCompletedAt: null,
      commandAction: true,
    },
  ],
})

export const readOccurrenceLoki = (options: ReaderOptions) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const { since, until } = previousUtcDay(options.now)
    yield* attempt(() => assertReadWindow({ now: options.now, start: since, end: options.now }))
    const get = ({
      base,
      path,
      params = {},
    }: {
      base: string
      path: string
      params?: Record<string, string>
    }) =>
      Effect.gen(function* () {
        const url = new URL(path, base)
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
        const response = yield* client.execute(HttpClientRequest.get(url.href))
        if (response.status < 200 || response.status >= 300)
          return yield* Effect.fail(error('http-error'))
        return yield* response.text
      }).pipe(
        Effect.timeout(`${options.queryTimeoutMs} millis`),
        Effect.mapError(() => error('query-failed')),
      )
    const collect = Effect.gen(function* () {
      const gaps = new Set<string>()
      const config = yield* get({ base: options.lokiUrl, path: '/config' }).pipe(
        Effect.catch(() => Effect.succeed('')),
      )
      const match = /^\s*max_entries_limit_per_query:\s*(\d+)\s*$/m.exec(config)
      const effective = match === null ? undefined : Number(match[1])
      const known = effective !== undefined && Number.isSafeInteger(effective) && effective > 0
      const limit = known === true ? effective! : 1000
      const bounds = {
        start: (BigInt(since) * 1_000_000n).toString(),
        end: (BigInt(options.now) * 1_000_000n).toString(),
      }
      // Discover actual stream labels; never assume host_name/hostname or a gateway default.
      const discovery = yield* get({
        base: options.lokiUrl,
        path: '/loki/api/v1/series',
        params: {
          ...bounds,
          'match[]': '{service_name="infra/buck2-events"}',
        },
      })
      const streams = yield* attempt(() => {
        const result = object(JSON.parse(discovery))
        if (result.status !== 'success') throw error('discovery-failed')
        return array(result.data).map(object)
      })
      if (streams.length === 0) gaps.add('missing-host-streams')
      const lines: string[] = []
      for (const stream of streams) {
        if (stream.service_name !== 'infra/buck2-events') {
          gaps.add('invalid-stream-labels')
          continue
        }
        const host = stream.host_name ?? stream.hostname ?? stream.host
        if (typeof host !== 'string' || host.length === 0) gaps.add('unvalidated-host-label')
        if (
          Object.entries(stream).some(
            ([key, value]) =>
              /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) === false || typeof value !== 'string',
          ) === true
        ) {
          gaps.add('invalid-stream-labels')
          continue
        }
        const selector = `{${Object.entries(stream)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(',')}}`
        const partition = yield* readPartitions({
          start: BigInt(bounds.start),
          end: BigInt(bounds.end),
          limit,
          limitKnown: known,
          query: (start, end) =>
            Effect.gen(function* () {
              const body = yield* get({
                base: options.lokiUrl,
                path: '/loki/api/v1/query_range',
                params: {
                  query: selector,
                  start: String(start),
                  end: String(end),
                  direction: 'forward',
                  limit: String(limit),
                },
              })
              return yield* attempt(() => {
                const response = object(JSON.parse(body))
                const data = object(response.data)
                if (response.status !== 'success' || data.resultType !== 'streams')
                  throw error('invalid-query-result')
                return array(data.result).flatMap((result) =>
                  array(object(result).values).map((value) => {
                    const pair = array(value)
                    if (
                      pair.length !== 2 ||
                      typeof pair[0] !== 'string' ||
                      /^\d+$/.test(pair[0]) === false ||
                      BigInt(pair[0]) < start ||
                      BigInt(pair[0]) > end ||
                      typeof pair[1] !== 'string'
                    )
                      throw error('invalid-entry')
                    return pair[1]
                  }),
                )
              })
            }),
        })
        lines.push(...partition.lines)
        for (const gap of partition.evidenceGaps) gaps.add(gap)
      }
      const seconds = Math.ceil((options.now - since) / 1000)
      for (const metric of [
        'loki_write_dropped_entries_total',
        'otelcol_exporter_send_failed_log_records_total',
        'loki_write_dropped_entries_total{reason="ingester_error"}',
      ]) {
        const check = yield* get({
          base: options.mimirUrl,
          path: '/prometheus/api/v1/query',
          params: {
            query: `increase(${metric}[${seconds}s])`,
            time: String(options.now / 1000),
          },
        }).pipe(
          Effect.flatMap((body) =>
            attempt(() => {
              const response = object(JSON.parse(body))
              const data = object(response.data)
              if (response.status !== 'success' || data.resultType !== 'vector')
                throw error('invalid-sink-response')
              const values = array(data.result).map((row) => Number(array(object(row).value)[1]))
              if (values.some((value) => Number.isFinite(value) === false || value < 0) === true)
                throw error('invalid-sink-value')
              return values
            }),
          ),
          Effect.catch(() => Effect.succeed(null)),
        )
        if (check === null) gaps.add('sink-check-unavailable')
        else if (check.length === 0) gaps.add('sink-counter-missing')
        else if (check.some((value) => value > 0) === true) gaps.add('sink-drop-increase')
      }
      const snapshots = reassembleSnapshots(lines)
      for (const gap of snapshots.evidenceGaps) gaps.add(gap)
      return { files: snapshots.files, evidenceGaps: [...gaps] }
    }).pipe(
      Effect.timeout(`${options.maxRuntimeMs} millis`),
      Effect.catch(() =>
        Effect.succeed({
          files: [] as RetainedOccurrenceFile[],
          evidenceGaps: ['collection-failed-or-runtime-exhausted'],
        }),
      ),
    )
    const collected = yield* collect
    const reconciled = yield* attempt(() =>
      reconcileOccurrenceRecords({
        files: collected.files,
        expectedHosts: options.expectedHosts,
        windowStartMs: since,
        windowEndMs: until,
      }),
    )
    // #2653 local-ledger provenance cannot satisfy #2604's GitHub-only header.
    // Keep the mismatch visible rather than inventing a repository or CI lane.
    const seamGaps =
      reconciled.records.length === 0
        ? []
        : ['reader-seam:missing-repo', 'reader-seam:unsupported-lane']
    const evidenceGaps = [
      ...new Set([...collected.evidenceGaps, ...reconciled.evidenceGaps, ...seamGaps]),
    ].toSorted()
    const scorecard = aggregateOccurrences({
      artifacts: reconciled.records.map(artifact),
      windowStartMs: since,
      windowEndMs: until,
      evidenceGaps,
    })
    const reasons = [
      ...new Set(
        scorecard.reasons.map((reason) =>
          reason === 'missing-repo'
            ? 'reader-seam:missing-repo'
            : reason === 'missing-lane'
              ? 'reader-seam:unsupported-lane'
              : reason,
        ),
      ),
    ].toSorted()
    return { ...scorecard, reasons, evidenceGaps, records: reconciled.records }
  })

export const readerOtlp = (report: OccurrenceScorecard) => {
  const payload = renderOccurrenceOtlp(report)
  for (const resource of payload.resourceMetrics)
    for (const scope of resource.scopeMetrics) scope.scope.name = 'buck2-occurrence-loki-reader'
  return payload
}
