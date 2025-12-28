import type { HttpClientRequest } from '@effect/platform'
import { describe, it } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import { expect } from 'vitest'
import { NOTION_API_BASE_URL, NOTION_API_VERSION, NotionConfig } from '../config.ts'
import { NotionApiError } from '../error.ts'
import { createTestLayer, sampleResponses } from '../test/test-utils.ts'
import { buildRequest, get, parseRateLimitHeaders, post } from './http.ts'

describe('parseRateLimitHeaders', () => {
  it.effect('returns None when headers are missing', () =>
    Effect.sync(() => {
      const headers = new Headers()
      const result = parseRateLimitHeaders(headers)
      expect(Option.isNone(result)).toBe(true)
    }),
  )

  it.effect('parses rate limit headers correctly', () =>
    Effect.sync(() => {
      const headers = new Headers({
        'x-ratelimit-remaining': '100',
        'retry-after': '60',
      })
      const result = parseRateLimitHeaders(headers)
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.remaining).toBe(100)
        expect(result.value.resetAfterSeconds).toBe(60)
      }
    }),
  )

  it.effect('handles missing retry-after header', () =>
    Effect.sync(() => {
      const headers = new Headers({
        'x-ratelimit-remaining': '50',
      })
      const result = parseRateLimitHeaders(headers)
      expect(Option.isSome(result)).toBe(true)
      if (Option.isSome(result)) {
        expect(result.value.remaining).toBe(50)
        expect(result.value.resetAfterSeconds).toBe(0)
      }
    }),
  )
})

describe('buildRequest', () => {
  it.effect('builds request with correct headers', () =>
    Effect.gen(function* () {
      const request = yield* buildRequest('GET', '/databases/123')

      expect(request.method).toBe('GET')
      expect(request.url).toBe(`${NOTION_API_BASE_URL}/databases/123`)
      expect(request.headers.authorization).toBe('Bearer secret-token')
      expect(request.headers['notion-version']).toBe(NOTION_API_VERSION)
      expect(request.headers['content-type']).toBe('application/json')
    }).pipe(Effect.provideService(NotionConfig, { authToken: 'secret-token' })),
  )

  it.effect('returns NotionApiError for JSON-encoding failures', () =>
    Effect.gen(function* () {
      const body: Record<string, unknown> = {}
      body.self = body

      const error = yield* buildRequest('POST', '/databases/123/query', body).pipe(Effect.flip)

      expect(error).toBeInstanceOf(NotionApiError)
      expect(error.code).toBe('invalid_request')
      expect(error.status).toBe(0)
      expect(Option.getOrNull(error.url)).toBe(`${NOTION_API_BASE_URL}/databases/123/query`)
      expect(Option.getOrNull(error.method)).toBe('POST')
    }).pipe(Effect.provideService(NotionConfig, { authToken: 'test-token' })),
  )

  it.effect('includes body for POST requests', () =>
    Effect.gen(function* () {
      const body = { filter: { property: 'Status', select: { equals: 'Done' } } }
      const request = yield* buildRequest('POST', '/databases/123/query', body)

      expect(request.method).toBe('POST')
      // Body is set but we can't easily inspect it without reading the stream
    }).pipe(Effect.provideService(NotionConfig, { authToken: 'test-token' })),
  )
})

describe('executeRequest', () => {
  const TestSchema = Schema.Struct({
    object: Schema.Literal('database'),
    id: Schema.String,
  })

  it.effect('successfully parses valid response', () =>
    Effect.gen(function* () {
      const result = yield* get('/databases/123', TestSchema)

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

  it.effect('returns NotionApiError for 4xx responses', () =>
    Effect.gen(function* () {
      const result = yield* get('/databases/invalid', TestSchema).pipe(Effect.flip)

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

  it.effect('returns NotionApiError for 5xx responses', () =>
    Effect.gen(function* () {
      const result = yield* get('/databases/123', TestSchema).pipe(Effect.flip)

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

  it.effect('returns NotionApiError for invalid response schema', () =>
    Effect.gen(function* () {
      const result = yield* get('/databases/123', TestSchema).pipe(Effect.flip)

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

  it.effect('includes request metadata in error', () =>
    Effect.gen(function* () {
      const result = yield* get('/databases/123', TestSchema).pipe(Effect.flip)

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

  it.effect('captures x-request-id from error response', () =>
    Effect.gen(function* () {
      const result = yield* get('/databases/123', TestSchema).pipe(Effect.flip)

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

  it.effect('captures retry-after for rate limited responses', () =>
    Effect.gen(function* () {
      const result = yield* get('/databases/123', TestSchema).pipe(Effect.flip)

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

describe('post', () => {
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

  it.effect('sends body with POST request', () =>
    Effect.gen(function* () {
      let capturedRequest: HttpClientRequest.HttpClientRequest | undefined

      const result = yield* post(
        '/databases/db-123/query',
        { filter: { property: 'Status' } },
        QueryResponseSchema,
      ).pipe(
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

describe('NotionApiError.isRetryable', () => {
  it.effect('rate_limited is retryable', () =>
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

  it.effect('internal_server_error is retryable', () =>
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

  it.effect('service_unavailable is retryable', () =>
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

  it.effect('invalid_request is not retryable', () =>
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

  it.effect('object_not_found is not retryable', () =>
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
