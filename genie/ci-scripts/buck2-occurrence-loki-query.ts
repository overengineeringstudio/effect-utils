import { Clock, Effect, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientRequest from 'effect/http/HttpClientRequest'

import { readBoundedBytes } from './buck2-cache-join-download.ts'
import { OccurrenceLokiResponse } from './buck2-occurrence-loki.ts'

export class OccurrenceLokiQueryError extends Schema.TaggedError<OccurrenceLokiQueryError>()(
  'OccurrenceLokiQueryError',
  { message: Schema.String },
) {}

const failure = (message: string) =>
  new OccurrenceLokiQueryError({ message: `${message}; occurrence coverage UNKNOWN` })
const pageLimit = 5000
const hourNs = 3_600_000_000_000n
const decodeResponse = Schema.decodeUnknownSync(Schema.fromJsonString(OccurrenceLokiResponse))

export interface OccurrenceLokiPage {
  readonly lines: readonly string[]
  readonly downloadedBytes: number
}

export interface OccurrenceLokiPageSummary {
  readonly pages: number
  readonly rows: number
  readonly downloadedBytes: number
}

/** Exhaust hourly windows, handing off one validated page at a time (including replayed rows). */
export const consumeOccurrenceLokiPages = <TError, TRequirements>(
  options: {
    readonly url: string
    readonly windowStartMs: number
    readonly windowEndMs: number
    readonly host?: string
    readonly wallTimeMs?: number
  },
  consumePage: (page: OccurrenceLokiPage) => Effect.Effect<void, TError, TRequirements>,
): Effect.Effect<
  OccurrenceLokiPageSummary,
  OccurrenceLokiQueryError | TError,
  HttpClient.HttpClient | TRequirements
> =>
  Effect.suspend(() => {
    const wallTimeMs = options.wallTimeMs ?? 600_000
    if (!Number.isSafeInteger(wallTimeMs) || wallTimeMs < 1 || wallTimeMs > 600_000)
      return Effect.fail(
        failure('Occurrence reader wall-time budget must be 1..600000 milliseconds'),
      )
    const deadlineFailure = () => failure('Occurrence reader wall-time budget exceeded')
    return Effect.gen(function* () {
      const deadline = (yield* Clock.currentTimeMillis) + wallTimeMs
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
      let pages = 0
      let rows = 0
      let downloadedBytes = 0
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
          const response = yield* client
            .execute(HttpClientRequest.get(`${url.href}?${params}`))
            .pipe(
              Effect.provideService(FetchHttpClient.RequestInit, { redirect: 'manual' }),
              Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
              Effect.mapError(() => failure('Occurrence reader HTTP transport failed')),
            )
          if (response.status !== 200)
            return yield* failure(`Occurrence reader returned HTTP ${response.status}`)
          const bytes = yield* readBoundedBytes(response.stream, 64 * 1024 * 1024).pipe(
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
          const lines: string[] = []
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
              lines.push(line)
            }
          }
          if (count > pageLimit)
            return yield* failure('Occurrence reader exceeded the fixed 5000-row page limit')
          // Validate the whole page before handing any evidence to the consumer.
          if (count === pageLimit && greatest <= cursor)
            return yield* failure(
              'Occurrence reader full-page cursor cannot advance; completeness cannot be proven',
            )
          if ((yield* Clock.currentTimeMillis) >= deadline) return yield* deadlineFailure()
          yield* consumePage({ lines, downloadedBytes: bytes.length })
          if ((yield* Clock.currentTimeMillis) >= deadline) return yield* deadlineFailure()
          pages++
          rows += count
          downloadedBytes += bytes.length
          if (count < pageLimit) break
          // Inclusive continuation replays boundary rows and cannot lose unseen tied rows.
          // A full page at the cursor cannot prove that all ties have been observed.
          // The full-page tie guard above proves this cursor advances.
          cursor = greatest
        }
      }
      return { pages, rows, downloadedBytes }
    }).pipe(
      Effect.timeoutOrElse({
        duration: wallTimeMs,
        orElse: () => Effect.fail(deadlineFailure()),
      }),
    )
  })
