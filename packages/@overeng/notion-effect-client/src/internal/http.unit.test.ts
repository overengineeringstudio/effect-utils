import type { HttpClientRequest } from '@effect/platform'
import { Effect, Fiber, Option, Redacted, Schema, TestClock, Tracer } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { NOTION_API_BASE_URL, NOTION_API_VERSION, NotionConfig } from '../config.ts'
import { NotionApiError } from '../error.ts'
import { createTestLayer, type MockResponse, sampleResponses } from '../test/test-utils.ts'
import {
  buildRequest,
  get,
  NotionHttpTelemetry,
  notionHttpRouteInfo,
  parseRateLimitHeaders,
  post,
  type NotionHttpTelemetryEvent,
} from './http.ts'

type RecordedSpan = {
  readonly name: string
  readonly attributes: Record<string, unknown>
  ended: boolean
}

const makeRecordingTracer = (): {
  readonly tracer: Tracer.Tracer
  readonly spans: ReadonlyArray<RecordedSpan>
} => {
  const spans: RecordedSpan[] = []
  return {
    spans,
    tracer: Tracer.make({
      span: (name, parent, context, links, startTime, kind, options) => {
        const attributes = new Map<string, unknown>(Object.entries(options?.attributes ?? {}))
        const recorded: RecordedSpan = {
          name,
          attributes: Object.fromEntries(attributes),
          ended: false,
        }
        spans.push(recorded)
        return {
          _tag: 'Span',
          name,
          spanId: `span-${spans.length}`,
          traceId: 'trace-notion-http',
          parent,
          context,
          status: { _tag: 'Started', startTime },
          attributes,
          links,
          sampled: true,
          kind,
          end: () => {
            recorded.ended = true
          },
          attribute: (key, value) => {
            attributes.set(key, value)
            recorded.attributes[key] = value
          },
          event: () => {},
          addLinks: () => {},
        }
      },
      context: (f) => f(),
    }),
  }
}

Vitest.describe('parseRateLimitHeaders', () => {
  Vitest.it.effect('returns None when headers are missing', () =>
    Effect.sync(() => {
      const headers = new Headers()
      const result = parseRateLimitHeaders(headers)
      expect(Option.isNone(result)).toBe(true)
    }),
  )

  Vitest.it.effect('parses rate limit headers correctly', () =>
    Effect.sync(() => {
      const headers = new Headers({
        'x-ratelimit-remaining': '100',
        'retry-after': '60',
      })
      const result = parseRateLimitHeaders(headers)
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result) === true) {
        expect(result.value.remaining).toBe(100)
        expect(result.value.resetAfterSeconds).toBe(60)
      }
    }),
  )

  Vitest.it.effect('handles missing retry-after header', () =>
    Effect.sync(() => {
      const headers = new Headers({
        'x-ratelimit-remaining': '50',
      })
      const result = parseRateLimitHeaders(headers)
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result) === true) {
        expect(result.value.remaining).toBe(50)
        expect(result.value.resetAfterSeconds).toBe(0)
      }
    }),
  )

  Vitest.it.effect('parses retry-after when remaining header is absent', () =>
    Effect.sync(() => {
      const headers = new Headers({
        'retry-after': '12',
      })
      const result = parseRateLimitHeaders(headers)
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result) === true) {
        expect(result.value.remaining).toBe(0)
        expect(result.value.resetAfterSeconds).toBe(12)
      }
    }),
  )

  Vitest.it.effect('parses retry-after HTTP date headers', () =>
    Effect.sync(() => {
      const headers = new Headers({
        'retry-after': new Date(Date.now() + 1000 * 15).toUTCString(),
      })
      const result = parseRateLimitHeaders(headers)
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result) === true) {
        expect(result.value.remaining).toBe(0)
        expect(result.value.resetAfterSeconds).toBeGreaterThan(0)
        expect(result.value.resetAfterSeconds).toBeLessThanOrEqual(20)
      }
    }),
  )
})

Vitest.describe('notionHttpRouteInfo', () => {
  Vitest.it.effect('sanitizes IDs while preserving route-level quota keys', () =>
    Effect.sync(() => {
      expect(
        notionHttpRouteInfo({
          method: 'POST',
          path: '/data_sources/2d4e3d41-f4a3-8000-bf14-f64cdf1c7501/query?page_size=100',
        }),
      ).toEqual({
        route: '/data_sources/{data_source_id}/query',
        operation: 'data_sources.query',
        spanLabel: 'POST data_sources.query',
      })
      expect(
        notionHttpRouteInfo({
          method: 'GET',
          path: '/pages/page_1234567890abcdef/properties/title',
        }),
      ).toEqual({
        route: '/pages/{page_id}/properties/{property_id}',
        operation: 'pages.property',
        spanLabel: 'GET pages.property',
      })
    }),
  )
})

Vitest.describe('buildRequest', () => {
  Vitest.it.effect('builds request with correct headers', () =>
    Effect.gen(function* () {
      const request = yield* buildRequest({
        method: 'GET',
        path: '/databases/123',
      })

      expect(request.method).toBe('GET')
      expect(request.url).toBe(`${NOTION_API_BASE_URL}/databases/123`)
      expect(request.headers.authorization).toBe('Bearer secret-token')
      expect(request.headers['notion-version']).toBe(NOTION_API_VERSION)
      expect(request.headers['content-type']).toBe('application/json')
    }).pipe(
      Effect.provideService(NotionConfig, {
        authToken: Redacted.make('secret-token'),
      }),
    ),
  )

  Vitest.it.effect('returns NotionApiError for JSON-encoding failures', () =>
    Effect.gen(function* () {
      const body: Record<string, unknown> = {}
      body.self = body

      const error = yield* buildRequest({
        method: 'POST',
        path: '/databases/123/query',
        body,
      }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(NotionApiError)
      expect(error.code).toBe('invalid_request')
      expect(error.status).toBe(0)
      expect(Option.getOrNull(error.url)).toBe(`${NOTION_API_BASE_URL}/databases/123/query`)
      expect(Option.getOrNull(error.method)).toBe('POST')
    }).pipe(
      Effect.provideService(NotionConfig, {
        authToken: Redacted.make('test-token'),
      }),
    ),
  )

  Vitest.it.effect('includes body for POST requests', () =>
    Effect.gen(function* () {
      const body = {
        filter: { property: 'Status', select: { equals: 'Done' } },
      }
      const request = yield* buildRequest({
        method: 'POST',
        path: '/databases/123/query',
        body,
      })

      expect(request.method).toBe('POST')
      // Body is set but we can't easily inspect it without reading the stream
    }).pipe(
      Effect.provideService(NotionConfig, {
        authToken: Redacted.make('test-token'),
      }),
    ),
  )
})

Vitest.describe('executeRequest', () => {
  const TestSchema = Schema.Struct({
    object: Schema.Literal('database'),
    id: Schema.String,
  })

  Vitest.it.effect('successfully parses valid response', () =>
    Effect.gen(function* () {
      const result = yield* get({
        path: '/databases/123',
        responseSchema: TestSchema,
      })

      expect(result.object).toBe('database')
      expect(result.id).toBe('db-123')
    }).pipe(
      Effect.provide(
        createTestLayer(() => ({
          status: 200,
          body: sampleResponses.database,
        })),
      ),
    ),
  )

  Vitest.it.effect('reports sanitized HTTP telemetry with rate-limit headers', () =>
    Effect.gen(function* () {
      const events: NotionHttpTelemetryEvent[] = []
      const result = yield* get({
        path: '/databases/1234567890abcdef1234567890abcdef',
        responseSchema: TestSchema,
      }).pipe(
        Effect.provideService(NotionHttpTelemetry, {
          report: (event) =>
            Effect.sync(() => {
              events.push(event)
            }),
        }),
      )

      expect(result.id).toBe('db-123')
      expect(events).toHaveLength(1)
      const event = events[0]
      expect(event).toMatchObject({
        _tag: 'response',
        method: 'GET',
        route: '/databases/{database_id}',
        operation: 'databases.object',
        status: 200,
        attempt: 0,
        quotaCost: 1,
      })
      expect(
        event === undefined ? undefined : Option.getOrUndefined(event.rateLimit)?.remaining,
      ).toBe(42)
    }).pipe(
      Effect.provide(
        createTestLayer(() => ({
          status: 200,
          body: sampleResponses.database,
          headers: {
            'x-ratelimit-remaining': '42',
            'retry-after': '7',
          },
        })),
      ),
    ),
  )

  Vitest.it.effect('annotates NotionHttp spans with sanitized quota attributes', () =>
    Effect.gen(function* () {
      const trace = makeRecordingTracer()
      yield* get({
        path: '/data_sources/1234567890abcdef1234567890abcdef/query?page_size=100',
        responseSchema: TestSchema,
      }).pipe(Effect.withTracer(trace.tracer))

      const span = trace.spans.find((candidate) => candidate.name === 'NotionHttp.GET')
      expect(span?.attributes).toMatchObject({
        'span.label': 'GET data_sources.query',
        'notion.http.method': 'GET',
        'notion.http.route': '/data_sources/{data_source_id}/query',
        'notion.http.operation': 'data_sources.query',
        'notion.http.status_code': 200,
        'notion.http.retry.attempts': 1,
        'notion.quota.cost': 1,
        'notion.rate_limit.remaining': 11,
        'notion.rate_limit.reset_after_ms': 3000,
      })
    }).pipe(
      Effect.provide(
        createTestLayer(() => ({
          status: 200,
          body: sampleResponses.database,
          headers: {
            'x-ratelimit-remaining': '11',
            'retry-after': '3',
          },
        })),
      ),
    ),
  )

  Vitest.it.effect('returns NotionApiError for 4xx responses', () =>
    Effect.gen(function* () {
      const result = yield* get({
        path: '/databases/invalid',
        responseSchema: TestSchema,
      }).pipe(Effect.flip)

      expect(result).toBeInstanceOf(NotionApiError)
      expect(result.status).toBe(404)
      expect(result.code).toBe('object_not_found')
    }).pipe(
      Effect.provide(
        createTestLayer(() => ({
          status: 404,
          body: sampleResponses.error(404, 'object_not_found', 'Database not found'),
        })),
      ),
    ),
  )

  Vitest.it.effect('returns NotionApiError for 5xx responses', () =>
    Effect.gen(function* () {
      const result = yield* get({
        path: '/databases/123',
        responseSchema: TestSchema,
      }).pipe(Effect.flip)

      expect(result).toBeInstanceOf(NotionApiError)
      expect(result.status).toBe(500)
      expect(result.code).toBe('internal_server_error')
    }).pipe(
      Effect.provide(
        createTestLayer(() => ({
          status: 500,
          body: sampleResponses.error(500, 'internal_server_error', 'Internal error'),
        })),
      ),
    ),
  )

  Vitest.it.effect('returns NotionApiError for invalid response schema', () =>
    Effect.gen(function* () {
      const result = yield* get({
        path: '/databases/123',
        responseSchema: TestSchema,
      }).pipe(Effect.flip)

      expect(result).toBeInstanceOf(NotionApiError)
      expect(result.code).toBe('invalid_request')
      expect(result.message).toContain('Failed to parse response')
    }).pipe(
      Effect.provide(
        createTestLayer(() => ({
          status: 200,
          body: { invalid: 'response' }, // Missing required fields
        })),
      ),
    ),
  )

  Vitest.it.effect('includes request metadata in error', () =>
    Effect.gen(function* () {
      const result = yield* get({
        path: '/databases/123',
        responseSchema: TestSchema,
      }).pipe(Effect.flip)

      expect(Option.isSome(result.url)).toBe(true)
      expect(Option.getOrNull(result.url)).toBe(`${NOTION_API_BASE_URL}/databases/123`)
      expect(Option.isSome(result.method)).toBe(true)
      expect(Option.getOrNull(result.method)).toBe('GET')
    }).pipe(
      Effect.provide(
        createTestLayer(() => ({
          status: 400,
          body: sampleResponses.error(400, 'invalid_request', 'Bad request'),
        })),
      ),
    ),
  )

  Vitest.it.effect('captures x-request-id from error response', () =>
    Effect.gen(function* () {
      const result = yield* get({
        path: '/databases/123',
        responseSchema: TestSchema,
      }).pipe(Effect.flip)

      expect(Option.isSome(result.requestId)).toBe(true)
      expect(Option.getOrNull(result.requestId)).toBe('req-abc-123')
    }).pipe(
      Effect.provide(
        createTestLayer(() => ({
          status: 400,
          body: sampleResponses.error(400, 'invalid_request', 'Bad request'),
          headers: { 'x-request-id': 'req-abc-123' },
        })),
      ),
    ),
  )

  Vitest.it.effect('captures retry-after for rate limited responses', () =>
    Effect.gen(function* () {
      const result = yield* get({
        path: '/databases/123',
        responseSchema: TestSchema,
      }).pipe(Effect.flip)

      expect(result.code).toBe('rate_limited')
      expect(Option.getOrNull(result.retryAfterSeconds)).toBe(2)
    }).pipe(
      Effect.provide(
        createTestLayer(() => ({
          status: 429,
          body: sampleResponses.error(429, 'rate_limited', 'Rate limited'),
          headers: {
            'retry-after': '2',
            'x-ratelimit-remaining': '0',
          },
        })),
      ),
    ),
  )
})

Vitest.describe('executeRequest retry schedule', () => {
  const TestSchema = Schema.Struct({
    object: Schema.Literal('database'),
    id: Schema.String,
  })

  const retryConfig = {
    authToken: Redacted.make('test-token'),
    retryEnabled: true,
    maxRetries: 3,
    retryBaseDelay: 1000,
  } as const

  /**
   * Drives a retrying request under TestClock, returning the recorded retry
   * telemetry once the request settles. `responses` is the per-attempt
   * response sequence; the harness advances virtual time generously so the
   * schedule's sleeps elapse without depending on wall-clock.
   */
  const runWithRetries = (responses: ReadonlyArray<MockResponse>) =>
    Effect.gen(function* () {
      let call = 0
      const events: NotionHttpTelemetryEvent[] = []

      const fiber = yield* get({ path: '/databases/123', responseSchema: TestSchema }).pipe(
        Effect.either,
        Effect.provideService(NotionHttpTelemetry, {
          report: (event) =>
            Effect.sync(() => {
              events.push(event)
            }),
        }),
        Effect.provide(
          createTestLayer(() => {
            const response = responses[Math.min(call, responses.length - 1)]
            call += 1
            return response ?? { status: 200, body: sampleResponses.database }
          }, retryConfig),
        ),
        Effect.fork,
      )

      // Enough virtual time for all exponential + Retry-After sleeps to fire.
      yield* TestClock.adjust('60 seconds')
      const result = yield* Fiber.join(fiber)

      const retryEvents = events.filter(
        (event): event is Extract<NotionHttpTelemetryEvent, { _tag: 'retry' }> =>
          event._tag === 'retry',
      )
      const responseEvents = events.filter((event) => event._tag === 'response')
      return { result, retryEvents, responseEvents, calls: call }
    })

  Vitest.it.scoped(
    'floors exponential backoff with Retry-After (max(backoff, Retry-After)) then succeeds',
    () =>
      Effect.gen(function* () {
        // Attempt 0: 429 retry-after=5s ⇒ delay = max(1000, 5000) = 5000.
        // Attempt 1: 503 no retry-after ⇒ delay = max(2000, 0) = 2000.
        // Attempt 2: success.
        const { result, retryEvents, responseEvents, calls } = yield* runWithRetries([
          {
            status: 429,
            body: sampleResponses.error(429, 'rate_limited', 'Rate limited'),
            headers: { 'retry-after': '5', 'x-ratelimit-remaining': '0' },
          },
          {
            status: 503,
            body: sampleResponses.error(503, 'service_unavailable', 'Unavailable'),
          },
          { status: 200, body: sampleResponses.database },
        ])

        expect(result._tag).toBe('Right')
        expect(calls).toBe(3)
        expect(retryEvents.map((event) => event.attempt)).toEqual([0, 1])
        expect(retryEvents.map((event) => event.delayMs)).toEqual([5000, 2000])
        // Response telemetry reports the live attempt index per try.
        expect(responseEvents.map((event) => event.attempt)).toEqual([0, 1, 2])
      }),
  )

  Vitest.it.scoped('stops after maxRetries with pure exponential backoff', () =>
    Effect.gen(function* () {
      const { result, retryEvents, calls } = yield* runWithRetries([
        { status: 500, body: sampleResponses.error(500, 'internal_server_error', 'Boom') },
      ])

      // Initial attempt + 3 retries = 4 calls; delays 1000, 2000, 4000.
      expect(result._tag).toBe('Left')
      expect(calls).toBe(4)
      expect(retryEvents.map((event) => event.delayMs)).toEqual([1000, 2000, 4000])
      if (result._tag === 'Left') {
        expect(result.left.code).toBe('internal_server_error')
      }
    }),
  )

  Vitest.it.scoped('does not retry non-retryable errors', () =>
    Effect.gen(function* () {
      const { result, retryEvents, calls } = yield* runWithRetries([
        { status: 404, body: sampleResponses.error(404, 'object_not_found', 'Missing') },
      ])

      expect(result._tag).toBe('Left')
      expect(calls).toBe(1)
      expect(retryEvents).toHaveLength(0)
    }),
  )
})

Vitest.describe('post', () => {
  const QueryResponseSchema = Schema.Struct({
    object: Schema.Literal('list'),
    results: Schema.Array(
      Schema.Struct({
        object: Schema.Literal('page'),
        id: Schema.String,
      }),
    ),
    has_more: Schema.Boolean,
    next_cursor: Schema.NullOr(Schema.String),
  })

  Vitest.it.effect('sends body with POST request', () =>
    Effect.gen(function* () {
      let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

      const result = yield* post({
        path: '/databases/db-123/query',
        body: { filter: { property: 'Status' } },
        responseSchema: QueryResponseSchema,
      }).pipe(
        Effect.provide(
          createTestLayer((req) => {
            capturedRequest = req
            return {
              status: 200,
              body: sampleResponses.paginatedPages(false, null),
            }
          }),
        ),
      )

      expect(result.object).toBe('list')
      expect(result.results.length).toBe(2)
      expect(capturedRequest?.method).toBe('POST')
    }),
  )
})

Vitest.describe('NotionApiError.isRetryable', () => {
  Vitest.it.effect('rate_limited is retryable', () =>
    Effect.sync(() => {
      const error = new NotionApiError({
        status: 429,
        code: 'rate_limited',
        message: 'Rate limited',
        retryAfterSeconds: Option.none(),
        requestId: Option.none(),
        url: Option.none(),
        method: Option.none(),
      })
      expect(error.isRetryable).toBe(true)
    }),
  )

  Vitest.it.effect('internal_server_error is retryable', () =>
    Effect.sync(() => {
      const error = new NotionApiError({
        status: 500,
        code: 'internal_server_error',
        message: 'Server error',
        retryAfterSeconds: Option.none(),
        requestId: Option.none(),
        url: Option.none(),
        method: Option.none(),
      })
      expect(error.isRetryable).toBe(true)
    }),
  )

  Vitest.it.effect('service_unavailable is retryable', () =>
    Effect.sync(() => {
      const error = new NotionApiError({
        status: 503,
        code: 'service_unavailable',
        message: 'Service unavailable',
        retryAfterSeconds: Option.none(),
        requestId: Option.none(),
        url: Option.none(),
        method: Option.none(),
      })
      expect(error.isRetryable).toBe(true)
    }),
  )

  Vitest.it.effect('invalid_request is not retryable', () =>
    Effect.sync(() => {
      const error = new NotionApiError({
        status: 400,
        code: 'invalid_request',
        message: 'Bad request',
        retryAfterSeconds: Option.none(),
        requestId: Option.none(),
        url: Option.none(),
        method: Option.none(),
      })
      expect(error.isRetryable).toBe(false)
    }),
  )

  Vitest.it.effect('object_not_found is not retryable', () =>
    Effect.sync(() => {
      const error = new NotionApiError({
        status: 404,
        code: 'object_not_found',
        message: 'Not found',
        retryAfterSeconds: Option.none(),
        requestId: Option.none(),
        url: Option.none(),
        method: Option.none(),
      })
      expect(error.isRetryable).toBe(false)
    }),
  )
})
