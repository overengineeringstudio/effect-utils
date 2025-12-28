import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from '@effect/platform'
import { Effect, Option, Schedule, Schema } from 'effect'
import { NOTION_API_BASE_URL, NOTION_API_VERSION, NotionConfig } from '../config.ts'
import { NotionApiError, NotionErrorResponse } from '../error.ts'

/** Rate limit info extracted from response headers */
export interface RateLimitInfo {
  /** Requests remaining in current window */
  readonly remaining: number
  /** Seconds until rate limit resets */
  readonly resetAfterSeconds: number
}

/**
 * Parse rate limit headers from Notion API response.
 */
export const parseRateLimitHeaders = (headers: Headers): Option.Option<RateLimitInfo> => {
  const remaining = headers.get('x-ratelimit-remaining')
  const resetAfter = headers.get('retry-after')

  if (remaining === null) {
    return Option.none()
  }

  return Option.some({
    remaining: parseInt(remaining, 10),
    resetAfterSeconds: resetAfter ? parseInt(resetAfter, 10) : 0,
  })
}

/**
 * Build a Notion API request with proper headers.
 */
export const buildRequest = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Effect.Effect<HttpClientRequest.HttpClientRequest, never, NotionConfig> =>
  Effect.gen(function* () {
    const config = yield* NotionConfig

    const baseRequest = HttpClientRequest.make(method)(`${NOTION_API_BASE_URL}${path}`).pipe(
      HttpClientRequest.setHeader('Authorization', `Bearer ${config.authToken}`),
      HttpClientRequest.setHeader('Notion-Version', NOTION_API_VERSION),
      HttpClientRequest.setHeader('Content-Type', 'application/json'),
    )

    if (body !== undefined) {
      return yield* HttpClientRequest.bodyJson(body)(baseRequest)
    }

    return baseRequest
  }).pipe(
    Effect.withSpan('NotionHttp.buildRequest', {
      attributes: { 'notion.method': method, 'notion.path': path },
    }),
    Effect.orDie, // bodyJson can fail with HttpBodyError, but only if JSON.stringify fails which shouldn't happen with valid data
  )

/**
 * Parse error response from Notion API.
 */
const parseErrorResponse = (
  response: HttpClientResponse.HttpClientResponse,
  requestUrl: string,
  requestMethod: string,
): Effect.Effect<NotionApiError, NotionApiError> =>
  Effect.gen(function* () {
    const requestId = Option.fromNullable(response.headers['x-request-id'])

    const json = yield* response.json.pipe(
      Effect.catchAll(() =>
        Effect.succeed({
          object: 'error' as const,
          status: response.status,
          code: 'internal_server_error' as const,
          message: `HTTP ${response.status} error`,
        }),
      ),
    )

    const parsed = yield* Schema.decodeUnknown(NotionErrorResponse)(json).pipe(
      Effect.catchAll(() =>
        Effect.succeed({
          object: 'error' as const,
          status: response.status,
          code: 'internal_server_error' as const,
          message:
            typeof json === 'object' && json !== null && 'message' in json
              ? String(json.message)
              : `HTTP ${response.status} error`,
        }),
      ),
    )

    return new NotionApiError({
      status: parsed.status,
      code: parsed.code,
      message: parsed.message,
      requestId,
      url: Option.some(requestUrl),
      method: Option.some(requestMethod),
    })
  })

/**
 * Map HttpClientError to NotionApiError.
 */
const mapHttpClientError = (
  error: HttpClientError.HttpClientError,
  path: string,
  method: string,
): NotionApiError =>
  new NotionApiError({
    status: 0,
    code: 'service_unavailable',
    message: error.message,
    requestId: Option.none(),
    url: Option.some(`${NOTION_API_BASE_URL}${path}`),
    method: Option.some(method),
  })

/**
 * Execute a Notion API request with error handling and optional retry.
 */
export const executeRequest = <A, I, R>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  responseSchema: Schema.Schema<A, I, R>,
  body?: unknown,
): Effect.Effect<A, NotionApiError, NotionConfig | HttpClient.HttpClient | R> =>
  Effect.gen(function* () {
    const config = yield* NotionConfig
    const client = yield* HttpClient.HttpClient
    const request = yield* buildRequest(method, path, body)

    const retryEnabled = config.retryEnabled ?? true
    const maxRetries = config.maxRetries ?? 3
    const retryBaseDelay = config.retryBaseDelay ?? 1000

    const makeRequest = Effect.gen(function* () {
      const response = yield* client
        .execute(request)
        .pipe(Effect.mapError((e) => mapHttpClientError(e, path, method)))

      if (response.status >= 400) {
        const error = yield* parseErrorResponse(response, `${NOTION_API_BASE_URL}${path}`, method)
        return yield* Effect.fail(error)
      }

      const json = yield* response.json.pipe(
        Effect.mapError((e) => mapHttpClientError(e, path, method)),
      )

      return yield* Schema.decodeUnknown(responseSchema)(json).pipe(
        Effect.mapError(
          (parseError) =>
            new NotionApiError({
              status: response.status,
              code: 'invalid_request',
              message: `Failed to parse response: ${parseError.message}`,
              requestId: Option.fromNullable(response.headers['x-request-id']),
              url: Option.some(`${NOTION_API_BASE_URL}${path}`),
              method: Option.some(method),
            }),
        ),
      )
    })

    if (retryEnabled) {
      const retrySchedule = Schedule.exponential(retryBaseDelay).pipe(
        Schedule.intersect(Schedule.recurs(maxRetries)),
        Schedule.whileInput((error: NotionApiError) => error.isRetryable),
      )

      return yield* makeRequest.pipe(Effect.retry(retrySchedule))
    }

    return yield* makeRequest
  }).pipe(Effect.withSpan(`NotionHttp.${method}`, { attributes: { 'notion.path': path } }))

/**
 * GET request helper.
 */
export const get = <A, I, R>(
  path: string,
  responseSchema: Schema.Schema<A, I, R>,
): Effect.Effect<A, NotionApiError, NotionConfig | HttpClient.HttpClient | R> =>
  executeRequest('GET', path, responseSchema)

/**
 * POST request helper.
 */
export const post = <A, I, R>(
  path: string,
  body: unknown,
  responseSchema: Schema.Schema<A, I, R>,
): Effect.Effect<A, NotionApiError, NotionConfig | HttpClient.HttpClient | R> =>
  executeRequest('POST', path, responseSchema, body)

/**
 * PATCH request helper.
 */
export const patch = <A, I, R>(
  path: string,
  body: unknown,
  responseSchema: Schema.Schema<A, I, R>,
): Effect.Effect<A, NotionApiError, NotionConfig | HttpClient.HttpClient | R> =>
  executeRequest('PATCH', path, responseSchema, body)

/**
 * DELETE request helper.
 */
export const del = <A, I, R>(
  path: string,
  responseSchema: Schema.Schema<A, I, R>,
): Effect.Effect<A, NotionApiError, NotionConfig | HttpClient.HttpClient | R> =>
  executeRequest('DELETE', path, responseSchema)
