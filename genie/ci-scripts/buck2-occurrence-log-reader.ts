import { Effect, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'

import {
  makeDownloadBudget,
  readBoundedBytes,
  type DownloadBudget,
} from './buck2-cache-join-download.ts'
import {
  makeOccurrenceLogAssembler,
  OccurrenceLogEnvelope,
  occurrenceLogLimits,
} from './buck2-occurrence-log-envelope.ts'

const LogResponse = Schema.fromJsonString(Schema.Struct({
  status: Schema.Literal('success'),
  warnings: Schema.optional(Schema.Array(Schema.String)),
  data: Schema.Struct({
    resultType: Schema.Literal('streams'),
    result: Schema.Array(Schema.Struct({
      stream: Schema.Record(Schema.String, Schema.String),
      values: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
    })),
  }),
}))
const EnvelopeJson = Schema.fromJsonString(OccurrenceLogEnvelope)
class OccurrenceLogReadError extends Schema.TaggedError<OccurrenceLogReadError>()(
  'OccurrenceLogReadError', { message: Schema.String },
) {}

export interface OccurrenceLogReadOptions {
  /** Full, governed endpoint: server owns the fixed selector, never client LogQL. */
  readonly url: string
  readonly startNs: bigint
  readonly endNs: bigint
  readonly hosts: readonly string[]
  /** Reserves from the caller's shared API budget before every network request. */
  readonly reserveRequest: () => boolean
  readonly budget?: DownloadBudget
  readonly pageLimit?: number
}

/** Exhaust finite host/time partitions; a saturated 1ns bucket is explicitly UNKNOWN. */
export const readOccurrenceLogs = Effect.fn('buck2-cache-join.occurrence-logs')(function* (
  options: OccurrenceLogReadOptions,
) {
  const assembler = makeOccurrenceLogAssembler()
  const gaps = new Set<string>([
    // Enumeration cannot certify collector loss, whole missing snapshots or later arrivals.
    'occurrence-log-ingestion-closure-unproven',
  ])
  const budget = options.budget ?? makeDownloadBudget(occurrenceLogLimits.totalBytes)
  const limit = options.pageLimit ?? 5000
  const endpoint = URL.parse(options.url)
  if (
    endpoint === null ||
    endpoint.username !== '' || endpoint.password !== '' ||
    endpoint.search !== '' || endpoint.hash !== '' ||
    endpoint.pathname !== '/buck2-occurrences/v1/query_range' ||
    !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:') ||
    Number.isSafeInteger(limit) === false || limit < 1 || limit > 5000 ||
    options.startNs < 0n || options.endNs <= options.startNs ||
    options.startNs.toString().length > 20 || options.endNs.toString().length > 20 ||
    options.hosts.some((host) => /^[A-Za-z0-9_.-]{1,64}$/.test(host) === false)
  ) {
    return { files: [], evidenceGaps: ['occurrence-log-invalid-request'] }
  }
  const client = yield* HttpClient.HttpClient
  let calls = 0
  const partitions = (options.hosts.length === 0 ? [undefined] : [...new Set(options.hosts)])
    .map((host) => ({ host, start: options.startNs, end: options.endNs }))
  if (options.hosts.length === 0) gaps.add('occurrence-log-host-inventory-unavailable')
  const collect = Effect.gen(function* () {
    while (partitions.length > 0) {
      const partition = partitions.pop()
      if (partition === undefined) break
      if (calls >= 800 || options.reserveRequest() === false) {
        gaps.add('occurrence-log-api-budget-exhausted')
        break
      }
      calls++
      yield* Effect.sleep('250 millis')
      const url = new URL(endpoint)
      url.searchParams.set('start', partition.start.toString())
      url.searchParams.set('end', partition.end.toString())
      url.searchParams.set('limit', String(limit))
      url.searchParams.set('direction', 'forward')
      if (partition.host !== undefined) url.searchParams.set('host', partition.host)
      const response = yield* client.execute(HttpClientRequest.get(url.href)).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual' }),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      )
      if (response.status !== 200) {
        return yield* new OccurrenceLogReadError({ message: 'Occurrence log HTTP status refused' })
      }
      const bytes = yield* readBoundedBytes(response.stream, occurrenceLogLimits.snapshotBytes, budget)
      const page = yield* Schema.decodeUnknownEffect(LogResponse)(bytes.toString('utf8'))
      if (page.warnings !== undefined && page.warnings.length > 0) {
        gaps.add('occurrence-log-backend-warning')
      }
      let count = 0
      for (const stream of page.data.result) {
        for (const [timestamp, body] of stream.values) {
          count++
          if (/^(0|[1-9][0-9]*)$/.test(timestamp) === false ||
            BigInt(timestamp) < partition.start || BigInt(timestamp) >= partition.end) {
            gaps.add('occurrence-log-out-of-window-row')
            continue
          }
          const envelope = yield* Schema.decodeUnknownEffect(EnvelopeJson)(body).pipe(Effect.result)
          if (envelope._tag === 'Failure') gaps.add('occurrence-log-malformed-envelope')
          else assembler.add(envelope.success)
        }
      }
      if (count >= limit) {
        if (partition.end - partition.start <= 1n) {
          gaps.add('occurrence-log-saturated-nanosecond')
          continue
        }
        const middle = partition.start + (partition.end - partition.start) / 2n
        partitions.push({ ...partition, start: middle }, { ...partition, end: middle })
      }
    }
  })
  const collected = yield* collect.pipe(Effect.timeout('120 seconds'), Effect.result)
  if (collected._tag === 'Failure') gaps.add('occurrence-log-query-gap')
  const reconstructed = assembler.finish()
  return {
    files: reconstructed.files,
    evidenceGaps: [...gaps, ...reconstructed.evidenceGaps],
  }
})
