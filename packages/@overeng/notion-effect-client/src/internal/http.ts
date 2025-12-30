import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from '@effect/platform'
import { Duration, Effect, Option, Schema } from 'effect'
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
export const parseRateLimitHeaders = (
  headers: Headers | Record<string, string | undefined>,
): Option.Option<RateLimitInfo> => {
  const getHeader = (name: string): string | undefined => {
    if (headers instanceof Headers) {
      return headers.get(name) ?? undefined
    }

    return headers[name.toLowerCase()] ?? headers[name]
  }

  const remainingRaw = getHeader('x-ratelimit-remaining')
  if (remainingRaw === undefined) {
    return Option.none()
  }

  const remaining = Number.parseInt(remainingRaw, 10)
  if (Number.isNaN(remaining)) {
    return Option.none()
  }

  const resetAfterRaw = getHeader('retry-after')
  const resetAfterSeconds = resetAfterRaw ? Number.parseInt(resetAfterRaw, 10) : 0

  return Option.some({
    remaining,
    resetAfterSeconds: Number.isNaN(resetAfterSeconds) ? 0 : resetAfterSeconds,
  })
}

/**
 * Build a Notion API request with proper headers.
 */
export const buildRequest = (
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Effect.Effect<HttpClientRequest.HttpClientRequest, NotionApiError, NotionConfig> =>
  Effect.gen(function* () {
    const config = yield* NotionConfig
    const requestUrl = `${NOTION_API_BASE_URL}${path}`

    const baseRequest = HttpClientRequest.make(method)(requestUrl).pipe(
      HttpClientRequest.setHeader('Authorization', `Bearer ${config.authToken}`),
      HttpClientRequest.setHeader('Notion-Version', NOTION_API_VERSION),
      HttpClientRequest.setHeader('Content-Type', 'application/json'),
    )

    if (body !== undefined) {
      return yield* HttpClientRequest.bodyJson(body)(baseRequest).pipe(
        Effect.mapError(
          (cause) =>
            new NotionApiError({
              status: 0,
              code: 'invalid_request',
              message: `Failed to encode request body: ${String(cause)}`,
              retryAfterSeconds: Option.none(),
              requestId: Option.none(),
              url: Option.some(requestUrl),
              method: Option.some(method),
            }),
        ),
      )
    }

    return baseRequest
  }).pipe(
    Effect.withSpan('NotionHttp.buildRequest', {
      attributes: { 'notion.method': method, 'notion.path': path },
    }),
  )

/**
 * Parse error response from Notion API.
 */
const parseErrorResponse = (
  response: HttpClientResponse.HttpClientResponse,
  requestUrl: string,
  requestMethod: string,
): Effect.Effect<NotionApiError> =>
  Effect.gen(function* () {
    const requestId = Option.fromNullable(response.headers['x-request-id'])
    const retryAfterSeconds =
      response.status === 429
        ? parseRateLimitHeaders(response.headers).pipe(
            Option.map((r) => r.resetAfterSeconds),
            Option.filter((s) => s > 0),
          )
        : Option.none<number>()

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
      retryAfterSeconds,
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
    retryAfterSeconds: Option.none(),
    requestId: Option.none(),
    url: Option.some(`${NOTION_API_BASE_URL}${path}`),
    method: Option.some(method),
  })

/**
 * Execute a Notion API request with error handling and automatic retry.
 *
 * Retry behavior:
 * - Retryable: rate_limited, internal_server_error, service_unavailable, gateway_timeout
 * - Non-retryable: invalid_request, unauthorized, object_not_found, etc.
 * - Uses exponential backoff, respecting retry-after header for rate limits
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

    const retryEnabled = config.retryEnabled ?? true
    const maxRetries = config.maxRetries ?? 3
    const retryBaseDelay = config.retryBaseDelay ?? 1000

    const makeRequest = Effect.gen(function* () {
      const request = yield* buildRequest(method, path, body)
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
              retryAfterSeconds: Option.none(),
              requestId: Option.fromNullable(response.headers['x-request-id']),
              url: Option.some(`${NOTION_API_BASE_URL}${path}`),
              method: Option.some(method),
            }),
        ),
      )
    })

    if (!retryEnabled) {
      return yield* makeRequest
    }

    let retries = 0

    while (true) {
      const result = yield* makeRequest.pipe(Effect.either)

      if (result._tag === 'Right') {
        return result.right
      }

      const error = result.left

      if (!error.isRetryable || retries >= maxRetries) {
        return yield* Effect.fail(error)
      }

      const retryAfterMs = Option.match(error.retryAfterSeconds, {
        onNone: () => 0,
        onSome: (s) => s * 1000,
      })

      const backoffMs = retryBaseDelay * 2 ** retries
      const delayMs = Math.max(backoffMs, retryAfterMs)

      yield* Effect.sleep(Duration.millis(delayMs))

      retries++
    }
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
