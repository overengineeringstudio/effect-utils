import { Effect, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'

import { makeDownloadBudget, readBoundedBytes } from './buck2-cache-join-download.ts'
import {
  OccurrenceLokiResponse,
  reconstructOccurrenceLokiSnapshots,
} from './buck2-occurrence-loki.ts'
import type { RetainedOccurrenceFile } from './buck2-occurrence-record-codec.ts'

export class OccurrenceLokiQueryError extends Schema.TaggedError<OccurrenceLokiQueryError>()(
  'OccurrenceLokiQueryError',
  { message: Schema.String },
) {}

const failure = (message: string) =>
  new OccurrenceLokiQueryError({ message: `${message}; occurrence coverage UNKNOWN` })
const pageLimit = 5000
const hourNs = 3_600_000_000_000n
const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(OccurrenceLokiResponse))

/** Exhaust every half-open hourly window before reconstructing any producer snapshot. */
export const fetchOccurrenceLoki = (options: {
  readonly url: string
  readonly windowStartMs: number
  readonly windowEndMs: number
  readonly host?: string
}): Effect.Effect<RetainedOccurrenceFile[], OccurrenceLokiQueryError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      try: () => new URL(options.url),
      catch: () => failure('Invalid occurrence reader URL'),
    })
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.pathname !== '/buck2-occurrences/v1/query_range' ||
      url.search !== '' ||
      url.hash !== '' ||
      url.username !== '' ||
      url.password !== '' ||
      options.url.includes('?') ||
      options.url.includes('#')
    )
      return yield* failure(
        'Occurrence reader URL must be the fixed query_range route without credentials, query or fragment',
      )
    if (options.host !== undefined && !/^[A-Za-z0-9_.-]{1,64}$/.test(options.host))
      return yield* failure('Invalid occurrence reader host')
    if (
      !Number.isSafeInteger(options.windowStartMs) ||
      !Number.isSafeInteger(options.windowEndMs) ||
      options.windowStartMs < 0 ||
      options.windowEndMs <= options.windowStartMs
    )
      return yield* failure(
        'Occurrence reader requires an increasing nonnegative integer millisecond window',
      )
    if (options.windowEndMs - options.windowStartMs > 86_400_000)
      return yield* failure('Occurrence reader window must cover at most 24 hours')

    const client = yield* HttpClient.HttpClient
    const budget = makeDownloadBudget(512 * 1024 * 1024)
    const lines = new Set<string>()
    const end = BigInt(options.windowEndMs) * 1_000_000n
    for (let start = BigInt(options.windowStartMs) * 1_000_000n; start < end; start += hourNs) {
      const endExclusive = start + hourNs < end ? start + hourNs : end
      let cursor = start
      while (true) {
        // Order is part of the fixed proxy contract; never forward arbitrary URL arguments.
        const params = new URLSearchParams([
          ['start', cursor.toString()],
          ['end', (endExclusive - 1n).toString()],
          ['limit', String(pageLimit)],
          ['direction', 'forward'],
        ])
        if (options.host !== undefined) params.append('host', options.host)
        const response = yield* client.execute(HttpClientRequest.get(`${url.href}?${params}`)).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual' }),
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          Effect.mapError(() => failure('Occurrence reader HTTP transport failed')),
        )
        if (response.status !== 200)
          return yield* failure(`Occurrence reader returned HTTP ${response.status}`)
        const bytes = yield* readBoundedBytes(response.stream, 64 * 1024 * 1024, budget).pipe(
          Effect.mapError((cause) =>
            failure(`Occurrence reader response download failed: ${cause.message}`),
          ),
        )
        const page = yield* Effect.try({
          try: () => decodeResponse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
          catch: () => failure('Malformed occurrence reader response'),
        })
        let count = 0
        let greatest = cursor
        for (const stream of page.data.result) {
          let previous = cursor
          for (const [timestamp, line] of stream.values) {
            if (!/^(0|[1-9][0-9]*)$/.test(timestamp))
              return yield* failure('Malformed occurrence reader nanosecond timestamp')
            const time = BigInt(timestamp)
            if (time < cursor || time >= endExclusive)
              return yield* failure(
                'Occurrence reader returned a timestamp outside the requested page window',
              )
            if (time < previous)
              return yield* failure(
                'Occurrence reader returned nonmonotonic timestamps within a stream',
              )
            previous = time
            if (time > greatest) greatest = time
            count++
            lines.add(line)
          }
        }
        if (count > pageLimit)
          return yield* failure('Occurrence reader exceeded the fixed 5000-row page limit')
        if (count < pageLimit) break
        // Inclusive continuation replays boundary rows and cannot lose unseen tied rows.
        // A full page at the cursor cannot prove that all ties have been observed.
        if (greatest <= cursor)
          return yield* failure(
            'Occurrence reader full-page cursor cannot advance; completeness cannot be proven',
          )
        cursor = greatest
      }
    }
    return yield* Effect.try({
      try: () => reconstructOccurrenceLokiSnapshots(lines),
      catch: () =>
        failure('Occurrence reader returned incomplete, conflicting or corrupt producer snapshots'),
    })
  })
