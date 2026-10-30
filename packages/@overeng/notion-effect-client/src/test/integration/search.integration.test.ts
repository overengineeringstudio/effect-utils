import { createHash } from 'node:crypto'

import { Clock, Duration, Effect, Exit, Option, Schedule, Schema } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { NotionDatabases } from '../../databases.ts'
import { NotionHttpTelemetry } from '../../internal/http.ts'
import { NotionPages } from '../../pages.ts'
import { NotionSearch } from '../../search.ts'
import { collectSearchFixtures } from '../test-utils.ts'
import {
  IntegrationTestLayer,
  SKIP_FIXTURE_INTEGRATION,
  SKIP_INTEGRATION,
  TEST_PARENT_PAGE_ID,
} from './setup.ts'

Vitest.describe.skipIf(SKIP_INTEGRATION)('NotionSearch (integration)', () => {
  Vitest.it.live('returns valid page or data source objects without a query', () =>
    Effect.gen(function* () {
      const result = yield* NotionSearch.search({ pageSize: 10 })
      for (const item of result.results) {
        expect(['page', 'data_source']).toContain(item.object)
        expect(item.id.length).toBeGreaterThan(0)
      }
    }).pipe(Effect.provide(IntegrationTestLayer)),
  )

  Vitest.it.live('accepts an empty query even in an empty workspace', () =>
    NotionSearch.search({ query: '' }).pipe(Effect.provide(IntegrationTestLayer)),
  )

  Vitest.describe.skipIf(SKIP_FIXTURE_INTEGRATION)('isolated search fixtures', () => {
    Vitest.it.live(
      'finds run-scoped fixtures with filters, sorting, pagination, and streaming',
      () =>
        Effect.gen(function* () {
          const query = crypto.randomUUID().replaceAll('-', '')
          const title = [{ type: 'text', text: { content: query } }]
          const page = yield* Effect.acquireRelease(
            NotionPages.create({
              parent: { type: 'page_id', page_id: TEST_PARENT_PAGE_ID },
              properties: { title: { title } },
            }),
            (created) => NotionPages.archive({ pageId: created.id }).pipe(Effect.orDie),
          )
          const database = yield* Effect.acquireRelease(
            NotionDatabases.create({
              parent: { type: 'page_id', page_id: page.id },
              title,
              properties: { Name: { title: {} } },
            }),
            (created) => NotionDatabases.archive({ databaseId: created.id }).pipe(Effect.orDie),
          )
          const dataSourceId = database.data_sources?.[0]?.id
          if (dataSourceId === undefined) {
            return yield* Effect.die('Search fixture database did not create a data source')
          }

          // Every query shape observes its own index readiness, sharing the fixture's
          // one-minute deadline (including HTTP requests and rate-limit retries).
          const indexStarted = yield* Clock.currentTimeMillis
          const indexDeadline = indexStarted + 60000
          const expectedFixtureIds = [page.id, dataSourceId]
          const waitForIndex = <TResult, TError, TRequirements>(
            shape: string,
            search: Effect.Effect<TResult, TError, TRequirements>,
            until: (result: TResult) => boolean,
            summarize: (result: TResult) => {
              readonly items: readonly { readonly id: string }[]
              readonly hasMore: boolean | undefined
            },
          ) =>
            Effect.gen(function* () {
              const started = yield* Clock.currentTimeMillis
              const remaining = indexDeadline - started
              let attempts = 0
              let lastResult:
                | {
                    readonly observedFixtureIds: readonly string[]
                    readonly nonfixtureResultCount: number
                    readonly itemCount: number
                    readonly hasMore: boolean | undefined
                  }
                | undefined
              const httpEvents: {
                readonly kind: 'response' | 'retry'
                readonly pollAttempt: number
                readonly attempt: number
                readonly status: number
                readonly elapsedMs: number
                readonly delayMs: number | undefined
              }[] = []
              const retentionLimit = 100
              const cursorHashes = new Set<string>()
              const searchPages: {
                readonly pollAttempt: number
                readonly page: number
                readonly resultCount: number
                readonly matchingFixtureCount: number
                readonly nonfixtureResultCount: number
                readonly requestCursorHash: string | null
                /** Null on the first page of each polling attempt (no predecessor). */
                readonly requestCursorMatchesPreviousResponse: boolean | null
                readonly hasMore: boolean
                readonly nextCursorHash: string | null
                readonly repeatedTrackedCursor: boolean
                readonly cursorTrackingSaturated: boolean
              }[] = []
              let totalSearchPages = 0
              let totalMatchingFixtureCount = 0
              let totalNonfixtureResultCount = 0
              let cursorMismatchCount = 0
              let previousCursorHash: string | null = null
              let pageInAttempt = 0
              let observedAttempt = 0
              let observerFailures = 0
              let cursorTrackingSaturated = false
              const observedPageSchema = Schema.Struct({
                results: Schema.Array(Schema.Struct({ id: Schema.String })),
                has_more: Schema.Boolean,
                next_cursor: Schema.NullOr(Schema.String),
              })
              const observedRequestSchema = Schema.fromJsonString(
                Schema.Struct({ start_cursor: Schema.optional(Schema.String) }),
              )
              const observePage = HttpClient.tap((response) =>
                Effect.gen(function* () {
                  if (
                    response.request.method !== 'POST' ||
                    new URL(response.request.url).pathname !== '/v1/search' ||
                    response.status < 200 ||
                    response.status >= 300
                  ) {
                    return
                  }
                  // Fetch responses cache their body bytes. The real client still
                  // decodes this same response; this observer never issues requests.
                  const body = yield* response.json
                  const result = yield* Schema.decodeUnknownEffect(observedPageSchema)(body)
                  const requestBody = response.request.body
                  if (requestBody._tag !== 'Uint8Array') {
                    return yield* Effect.die('Search observer expected a JSON request body')
                  }
                  const request = yield* Schema.decodeEffect(observedRequestSchema)(
                    new TextDecoder().decode(requestBody.body),
                  )
                  const requestCursorHash =
                    request.start_cursor === undefined
                      ? null
                      : createHash('sha256').update(request.start_cursor).digest('hex')
                  if (observedAttempt !== attempts) {
                    observedAttempt = attempts
                    pageInAttempt = 0
                    cursorHashes.clear()
                    cursorTrackingSaturated = false
                    previousCursorHash = null
                  }
                  pageInAttempt++
                  totalSearchPages++
                  const cursorHash =
                    result.next_cursor === null
                      ? null
                      : createHash('sha256').update(result.next_cursor).digest('hex')
                  const requestCursorMatchesPreviousResponse =
                    pageInAttempt === 1 ? null : requestCursorHash === previousCursorHash
                  if (requestCursorMatchesPreviousResponse === false) cursorMismatchCount++
                  previousCursorHash = cursorHash
                  const matchingFixtureCount = result.results.filter((item) =>
                    expectedFixtureIds.includes(item.id),
                  ).length
                  const nonfixtureResultCount = result.results.length - matchingFixtureCount
                  totalMatchingFixtureCount += matchingFixtureCount
                  totalNonfixtureResultCount += nonfixtureResultCount
                  const repeatedTrackedCursor = cursorHash !== null && cursorHashes.has(cursorHash)
                  if (cursorHash !== null && repeatedTrackedCursor === false) {
                    if (cursorHashes.size < retentionLimit) {
                      cursorHashes.add(cursorHash)
                    } else {
                      cursorTrackingSaturated = true
                    }
                  }
                  searchPages.push({
                    pollAttempt: attempts,
                    page: pageInAttempt,
                    resultCount: result.results.length,
                    matchingFixtureCount,
                    nonfixtureResultCount,
                    requestCursorHash: requestCursorHash?.slice(0, 12) ?? null,
                    requestCursorMatchesPreviousResponse,
                    hasMore: result.has_more,
                    nextCursorHash: cursorHash?.slice(0, 12) ?? null,
                    // False means "not in the retained first 100 hashes", not
                    // global uniqueness once cursor tracking is saturated.
                    repeatedTrackedCursor,
                    cursorTrackingSaturated,
                  })
                  if (searchPages.length > retentionLimit) searchPages.shift()
                }).pipe(
                  // Even malformed JSON/schema failures must leave the original
                  // response and its client-side decoding outcome untouched.
                  Effect.catchCause(() =>
                    Effect.sync(() => {
                      observerFailures++
                    }),
                  ),
                ),
              )
              return yield* Effect.suspend(() => {
                attempts++
                return search
              }).pipe(
                // Every readiness shape, including earlier filtered streams,
                // uses this wait-local observer with fresh bounded tracking.
                Effect.updateService(HttpClient.HttpClient, observePage),
                Effect.tap((result) =>
                  Effect.sync(() => {
                    const { items, hasMore } = summarize(result)
                    const observedFixtureIds = items
                      .filter((item) => expectedFixtureIds.includes(item.id))
                      .map((item) => item.id)
                    lastResult = {
                      observedFixtureIds,
                      nonfixtureResultCount: items.length - observedFixtureIds.length,
                      itemCount: items.length,
                      hasMore,
                    }
                  }),
                ),
                Effect.repeat({ schedule: Schedule.spaced('2 seconds'), until }),
                Effect.timeout(Duration.millis(Math.max(0, remaining))),
                Effect.provideService(NotionHttpTelemetry, {
                  report: (event) =>
                    Effect.gen(function* () {
                      httpEvents.push({
                        kind: event._tag,
                        pollAttempt: attempts,
                        attempt: event.attempt,
                        status: event.status,
                        elapsedMs: (yield* Clock.currentTimeMillis) - indexStarted,
                        delayMs: event._tag === 'retry' ? event.delayMs : undefined,
                      })
                      if (httpEvents.length > retentionLimit) httpEvents.shift()
                    }),
                }),
                Effect.onExit((exit) =>
                  Effect.gen(function* () {
                    const now = yield* Clock.currentTimeMillis
                    // Only synthetic fixture IDs, counts, and cursor hashes are logged.
                    // Successful shapes matter too: they may consume a later shape's deadline.
                    const message =
                      Exit.isFailure(exit) === true
                        ? 'Notion search fixture readiness failed'
                        : 'Notion search fixture readiness succeeded'
                    const diagnostics = yield* Schema.encodeEffect(
                      Schema.fromJsonString(Schema.Unknown),
                    )({
                      shape,
                      attempts,
                      elapsedMs: now - indexStarted,
                      pollElapsedMs: now - started,
                      remainingMs: Math.max(0, indexDeadline - now),
                      remainingAtStartMs: remaining,
                      expectedFixtureIds,
                      lastResult,
                      httpEvents,
                      searchPageObserver: {
                        shape,
                        searchPages,
                        totalSearchPages,
                        totalMatchingFixtureCount,
                        totalNonfixtureResultCount,
                        cursorMismatchCount,
                        observerFailures,
                        retainedCursorHashCount: cursorHashes.size,
                        cursorTrackingSaturated,
                        retentionLimit,
                      },
                    })
                    yield* Exit.isFailure(exit) === true
                      ? Effect.logError(message, diagnostics)
                      : Effect.logInfo(message, diagnostics)
                  }).pipe(
                    // Diagnostic encoding/logging must not replace the readiness outcome.
                    Effect.ignoreCause({ log: false }),
                  ),
                ),
              )
            })
          const indexed = yield* waitForIndex(
            'search:unfiltered',
            NotionSearch.search({ query }),
            (result) =>
              result.results.some((item) => item.id === page.id) &&
              result.results.some((item) => item.id === dataSourceId),
            (result) => ({ items: result.results, hasMore: result.hasMore }),
          )
          expect(indexed.results.map((item) => item.id)).toEqual(
            expect.arrayContaining([page.id, dataSourceId]),
          )

          // Both object types exist for this query, so neither filter can pass
          // vacuously or simply return the unfiltered results.
          for (const [value, id] of [
            ['page', page.id],
            ['data_source', dataSourceId],
          ] as const) {
            const filtered = yield* waitForIndex(
              `search:filter=${value}`,
              NotionSearch.search({
                query,
                filter: { property: 'object', value },
              }),
              (result) => result.results.some((item) => item.id === id),
              (result) => ({ items: result.results, hasMore: result.hasMore }),
            )
            expect(filtered.results.map((item) => item.id)).toContain(id)
            for (const item of filtered.results) expect(item.object).toBe(value)

            const streamed = yield* waitForIndex(
              `searchStream:filter=${value}:pageSize=10`,
              collectSearchFixtures(
                NotionSearch.searchStream({
                  query,
                  filter: { property: 'object', value },
                  // Batch the bounded readiness scan; pageSize=1 is exercised below.
                  pageSize: 10,
                }),
                [id],
              ),
              (items) => items.some((item) => item.id === id),
              (items) => ({ items, hasMore: undefined }),
            )
            expect(streamed.map((item) => item.id)).toContain(id)
            for (const item of streamed) expect(item.object).toBe(value)
          }

          const sorted = yield* waitForIndex(
            'search:sort=last_edited_time:descending',
            NotionSearch.search({
              query,
              sort: { direction: 'descending', timestamp: 'last_edited_time' },
            }),
            (result) =>
              result.results.some((item) => item.id === page.id) &&
              result.results.some((item) => item.id === dataSourceId),
            (result) => ({ items: result.results, hasMore: result.hasMore }),
          )
          expect(sorted.results.map((item) => item.id)).toEqual(
            expect.arrayContaining([page.id, dataSourceId]),
          )

          const first = yield* waitForIndex(
            'search:pageSize=1:first',
            NotionSearch.search({ query, pageSize: 1 }),
            (result) => result.results.length === 1 && result.hasMore,
            (result) => ({ items: result.results, hasMore: result.hasMore }),
          )
          expect(first.results).toHaveLength(1)
          expect(first.hasMore).toBe(true)
          expect(Option.isSome(first.nextCursor)).toBe(true)
          const second = yield* waitForIndex(
            'search:pageSize=1:nextCursor',
            NotionSearch.search({
              query,
              pageSize: 1,
              startCursor: Option.getOrThrow(first.nextCursor),
            }),
            (result) => result.results.length === 1,
            (result) => ({ items: result.results, hasMore: result.hasMore }),
          )
          expect(second.results).toHaveLength(1)
          expect(second.results[0]?.id).not.toBe(first.results[0]?.id)

          const streamed = yield* waitForIndex(
            'searchStream:unfiltered:pageSize=10',
            collectSearchFixtures(NotionSearch.searchStream({ query, pageSize: 10 }), [
              page.id,
              dataSourceId,
            ]),
            (items) =>
              items.some((item) => item.id === page.id) &&
              items.some((item) => item.id === dataSourceId),
            (items) => ({ items, hasMore: undefined }),
          )
          expect(streamed.map((item) => item.id)).toEqual(
            expect.arrayContaining([page.id, dataSourceId]),
          )
        }).pipe(Effect.scoped, Effect.provide(IntegrationTestLayer)),
      { timeout: 120000 },
    )
  })
})
