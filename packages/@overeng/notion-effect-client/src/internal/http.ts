import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from '@effect/platform'
import { Context, Duration, Effect, Option, Redacted, Schema } from 'effect'

import { NOTION_API_BASE_URL, NOTION_API_VERSION, NotionConfig } from '../config.ts'
import { NotionApiError, NotionErrorResponse } from '../error.ts'

/** Rate limit info extracted from response headers */
export interface RateLimitInfo {
  /** Requests remaining in current window */
  readonly remaining: number
  /** Seconds until rate limit resets */
  readonly resetAfterSeconds: number
}

/** Sanitized route metadata used for request tracing, progress, and quota accounting. */
export interface NotionHttpRouteInfo {
  readonly route: string
  readonly operation: string
  readonly spanLabel: string
}

/** Structured HTTP event emitted after every Notion API response and retry decision. */
export type NotionHttpTelemetryEvent =
  | {
      readonly _tag: 'response'
      readonly method: BuildRequestOptions['method']
      readonly route: string
      readonly operation: string
      readonly status: number
      readonly attempt: number
      readonly quotaCost: number
      readonly rateLimit: Option.Option<RateLimitInfo>
    }
  | {
      readonly _tag: 'retry'
      readonly method: BuildRequestOptions['method']
      readonly route: string
      readonly operation: string
      readonly status: number
      readonly attempt: number
      readonly nextAttempt: number
      readonly delayMs: number
      readonly rateLimit: Option.Option<RateLimitInfo>
    }

/** Optional reporter for live Notion HTTP quota/progress consumers such as CLIs. */
export type NotionHttpTelemetryReporter = {
  readonly report: (event: NotionHttpTelemetryEvent) => Effect.Effect<void>
}

/** Optional Effect service used by callers that want realtime HTTP/rate-limit visibility. */
export class NotionHttpTelemetry extends Context.Tag(
  '@overeng/notion-effect-client/NotionHttpTelemetry',
)<NotionHttpTelemetry, NotionHttpTelemetryReporter>() {}

/** Options for building a Notion API request */
export interface BuildRequestOptions {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly body?: unknown
}

/** Options for executing a Notion API request */
export interface ExecuteRequestOptions<A, I, R> {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly responseSchema: Schema.Schema<A, I, R>
  readonly body?: unknown
}

const parseNonNegativeInt = (input: string | undefined): number => {
  if (input === undefined) {
    return 0
  }
  const value = Number.parseInt(input, 10)
  return Number.isNaN(value) === true ? 0 : Math.max(0, value)
}

const parseRetryAfterSeconds = (input: string | undefined): number => {
  if (input === undefined) {
    return 0
  }
  const seconds = Number.parseInt(input, 10)
  if (Number.isNaN(seconds) === false) {
    return Math.max(0, seconds)
  }

  const resetAt = Date.parse(input)
  if (Number.isNaN(resetAt) === true) {
    return 0
  }

  return Math.max(0, Math.ceil((resetAt - Date.now()) / 1000))
}

const routeTokenForPreviousSegment = (previous: string | undefined): string => {
  switch (previous) {
    case 'blocks':
      return '{block_id}'
    case 'data_sources':
      return '{data_source_id}'
    case 'databases':
      return '{database_id}'
    case 'pages':
      return '{page_id}'
    case 'properties':
      return '{property_id}'
    case 'users':
      return '{user_id}'
    case 'views':
      return '{view_id}'
    default:
      return '{id}'
  }
}

const isLikelyIdentifierSegment = (segment: string): boolean =>
  /^[0-9a-f]{32}$/i.test(segment) ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) ||
  (segment.length >= 16 && /^[A-Za-z0-9_-]+$/.test(segment))

const operationForRoute = (route: string): string => {
  switch (route) {
    case '/blocks/{block_id}':
      return 'blocks.retrieve'
    case '/blocks/{block_id}/children':
      return 'blocks.children'
    case '/comments':
      return 'comments.create'
    case '/custom_emojis':
      return 'custom_emojis.list'
    case '/data_sources':
      return 'data_sources.create'
    case '/data_sources/{data_source_id}':
      return 'data_sources.object'
    case '/data_sources/{data_source_id}/query':
      return 'data_sources.query'
    case '/databases':
      return 'databases.create'
    case '/databases/{database_id}':
      return 'databases.object'
    case '/pages':
      return 'pages.create'
    case '/pages/{page_id}':
      return 'pages.object'
    case '/pages/{page_id}/markdown':
      return 'pages.markdown'
    case '/pages/{page_id}/move':
      return 'pages.move'
    case '/pages/{page_id}/properties/{property_id}':
      return 'pages.property'
    case '/search':
      return 'search'
    case '/users/me':
      return 'users.me'
    case '/users/{user_id}':
      return 'users.retrieve'
    case '/views':
      return 'views.collection'
    case '/views/{view_id}':
      return 'views.object'
    default:
      return route.replace(/^\//, '').replaceAll('/', '.')
  }
}

const shouldTemplateSegment = ({
  segment,
  previous,
}: {
  readonly segment: string
  readonly previous: string | undefined
}): boolean =>
  previous !== undefined &&
  (previous !== 'users' || segment !== 'me') &&
  (routeTokenForPreviousSegment(previous) !== '{id}' || isLikelyIdentifierSegment(segment))

/** Converts a concrete Notion API path into a stable, non-sensitive route key. */
export const notionHttpRouteInfo = ({
  method,
  path,
}: {
  readonly method: BuildRequestOptions['method']
  readonly path: string
}): NotionHttpRouteInfo => {
  const pathname = path.split('?')[0] ?? '/'
  const segments = pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment, index, all) => {
      const previous = all[index - 1]
      return shouldTemplateSegment({ segment, previous }) === true
        ? routeTokenForPreviousSegment(previous)
        : segment
    })
  const route = `/${segments.join('/')}`
  const operation = operationForRoute(route)
  return {
    route,
    operation,
    spanLabel: `${method} ${operation}`.slice(0, 39),
  }
}

/** Options for POST request */
export interface PostRequestOptions<A, I, R> {
  readonly path: string
  readonly body: unknown
  readonly responseSchema: Schema.Schema<A, I, R>
}

/** Options for PATCH request */
export interface PatchRequestOptions<A, I, R> {
  readonly path: string
  readonly body: unknown
  readonly responseSchema: Schema.Schema<A, I, R>
}

/**
 * Parse rate limit headers from Notion API response.
 */
export const parseRateLimitHeaders = (
  headers: Headers | Record<string, string | undefined>,
): Option.Option<RateLimitInfo> => {
  const getHeader = (name: string): string | undefined => {
    if (headers instanceof Headers === true) {
      return headers.get(name) ?? undefined
    }

    return headers[name.toLowerCase()] ?? headers[name]
  }

  const remainingRaw = getHeader('x-ratelimit-remaining')
  const retryAfterRaw = getHeader('retry-after')
  if (remainingRaw === undefined && retryAfterRaw === undefined) {
    return Option.none()
  }

  const remaining = parseNonNegativeInt(remainingRaw)
  const resetAfterSeconds = parseRetryAfterSeconds(retryAfterRaw)

  return Option.some({
    remaining,
    resetAfterSeconds,
  })
}

const annotateRateLimitSpan = (input: {
  readonly method: BuildRequestOptions['method']
  readonly route: NotionHttpRouteInfo
  readonly status?: number
  readonly attempt: number
  readonly attempts: number
  readonly retryDelayMs?: number
  readonly rateLimit: Option.Option<RateLimitInfo>
}): Effect.Effect<void> =>
  Effect.annotateCurrentSpan(
    definedSpanAttributes({
      'span.label': input.route.spanLabel,
      'notion.http.method': input.method,
      'notion.http.route': input.route.route,
      'notion.http.operation': input.route.operation,
      'notion.http.status_code': input.status,
      'notion.http.retry.attempt': input.attempt,
      'notion.http.retry.attempts': input.attempts,
      'notion.http.retry.delay_ms': input.retryDelayMs,
      'notion.quota.cost': input.attempts,
      'notion.rate_limit.present': Option.isSome(input.rateLimit),
      'notion.rate_limit.remaining': Option.getOrUndefined(
        Option.map(input.rateLimit, (rateLimit) => rateLimit.remaining),
      ),
      'notion.rate_limit.reset_after_ms': Option.getOrUndefined(
        Option.map(input.rateLimit, (rateLimit) => rateLimit.resetAfterSeconds * 1000),
      ),
    }),
  )

const reportHttpTelemetry = (event: NotionHttpTelemetryEvent): Effect.Effect<void> =>
  Effect.serviceOption(NotionHttpTelemetry).pipe(
    Effect.flatMap((service) =>
      Option.match(service, {
        onNone: () => Effect.void,
        onSome: (telemetry) => telemetry.report(event),
      }),
    ),
  )

const definedSpanAttributes = (
  attributes: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> =>
  Object.fromEntries(
    Object.entries(attributes).filter((entry): entry is [string, string | number | boolean] => {
      const value = entry[1]
      return value !== undefined
    }),
  )

/**
 * Build a Notion API request with proper headers.
 */
export const buildRequest = ({
  method,
  path,
  body,
}: BuildRequestOptions): Effect.Effect<
  HttpClientRequest.HttpClientRequest,
  NotionApiError,
  NotionConfig
> =>
  Effect.gen(function* () {
    const config = yield* NotionConfig
    const requestUrl = `${NOTION_API_BASE_URL}${path}`

    const baseRequest = HttpClientRequest.make(method)(requestUrl).pipe(
      HttpClientRequest.setHeader('Authorization', `Bearer ${Redacted.value(config.authToken)}`),
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
  })
/* No `Effect.withSpan` here: request construction is a trivial synchronous
     shape (header mapping + body encoding) and the generated span was noise
     — 85 zero-signal spans per `pixeltrail sync` run. Method/path are
     already carried on the surrounding `NotionHttp.<METHOD>` span. */

/** Parse error response from Notion API. */
const parseErrorResponse = (opts: {
  response: HttpClientResponse.HttpClientResponse
  requestUrl: string
  requestMethod: string
}): Effect.Effect<NotionApiError> => {
  const { response, requestUrl, requestMethod } = opts
  return Effect.gen(function* () {
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
}

/** Map HttpClientError to NotionApiError. */
const mapHttpClientError = (opts: {
  error: HttpClientError.HttpClientError
  path: string
  method: string
}): NotionApiError =>
  new NotionApiError({
    status: 0,
    code: 'service_unavailable',
    message: opts.error.message,
    retryAfterSeconds: Option.none(),
    requestId: Option.none(),
    url: Option.some(`${NOTION_API_BASE_URL}${opts.path}`),
    method: Option.some(opts.method),
  })

/**
 * Execute a Notion API request with error handling and automatic retry.
 *
 * Retry behavior:
 * - Retryable: rate_limited, internal_server_error, service_unavailable, gateway_timeout
 * - Non-retryable: invalid_request, unauthorized, object_not_found, etc.
 * - Uses exponential backoff, respecting retry-after header for rate limits
 */
export const executeRequest = <A, I, R>({
  method,
  path,
  responseSchema,
  body,
}: ExecuteRequestOptions<A, I, R>): Effect.Effect<
  A,
  NotionApiError,
  NotionConfig | HttpClient.HttpClient | R
> =>
  Effect.gen(function* () {
    const config = yield* NotionConfig
    const client = yield* HttpClient.HttpClient

    const retryEnabled = config.retryEnabled ?? true
    const maxRetries = config.maxRetries ?? 3
    const retryBaseDelay = config.retryBaseDelay ?? 1000
    const route = notionHttpRouteInfo({ method, path })

    const makeRequest = (attempt: number) =>
      Effect.gen(function* () {
        const request = yield* buildRequest({ method, path, body })
        const response = yield* client
          .execute(request)
          .pipe(Effect.mapError((error) => mapHttpClientError({ error, path, method })))
        const rateLimit = parseRateLimitHeaders(response.headers)
        yield* annotateRateLimitSpan({
          method,
          route,
          status: response.status,
          attempt,
          attempts: attempt + 1,
          rateLimit,
        })
        yield* reportHttpTelemetry({
          _tag: 'response',
          method,
          route: route.route,
          operation: route.operation,
          status: response.status,
          attempt,
          quotaCost: 1,
          rateLimit,
        })

        if (response.status >= 400) {
          const error = yield* parseErrorResponse({
            response,
            requestUrl: `${NOTION_API_BASE_URL}${path}`,
            requestMethod: method,
          })
          return yield* error
        }

        const json = yield* response.json.pipe(
          Effect.mapError((error) => mapHttpClientError({ error, path, method })),
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

    if (retryEnabled === false) {
      return yield* makeRequest(0)
    }

    let retries = 0

    while (true) {
      const result = yield* makeRequest(retries).pipe(Effect.either)

      if (result._tag === 'Right') {
        return result.right
      }

      const error = result.left

      if (error.isRetryable === false || retries >= maxRetries) {
        return yield* error
      }

      const retryAfterMs = Option.match(error.retryAfterSeconds, {
        onNone: () => 0,
        onSome: (s) => s * 1000,
      })

      const backoffMs = retryBaseDelay * 2 ** retries
      const delayMs = Math.max(backoffMs, retryAfterMs)
      const rateLimit =
        error.status === 429 && Option.isSome(error.retryAfterSeconds) === true
          ? Option.some({
              remaining: 0,
              resetAfterSeconds: error.retryAfterSeconds.value,
            })
          : Option.none<RateLimitInfo>()

      yield* annotateRateLimitSpan({
        method,
        route,
        status: error.status,
        attempt: retries,
        attempts: retries + 1,
        retryDelayMs: delayMs,
        rateLimit,
      })
      yield* reportHttpTelemetry({
        _tag: 'retry',
        method,
        route: route.route,
        operation: route.operation,
        status: error.status,
        attempt: retries,
        nextAttempt: retries + 1,
        delayMs,
        rateLimit,
      })

      yield* Effect.sleep(Duration.millis(delayMs))

      retries++
    }
  }).pipe(
    Effect.withSpan(`NotionHttp.${method}`, {
      attributes: {
        'span.label': notionHttpRouteInfo({ method, path }).spanLabel,
        'notion.http.method': method,
        'notion.http.route': notionHttpRouteInfo({ method, path }).route,
        'notion.http.operation': notionHttpRouteInfo({ method, path }).operation,
      },
    }),
  )

/** Options for GET request */
export interface GetRequestOptions<A, I, R> {
  readonly path: string
  readonly responseSchema: Schema.Schema<A, I, R>
}

/** GET request helper. */
export const get = <A, I, R>({
  path,
  responseSchema,
}: GetRequestOptions<A, I, R>): Effect.Effect<
  A,
  NotionApiError,
  NotionConfig | HttpClient.HttpClient | R
> => executeRequest({ method: 'GET', path, responseSchema })

/**
 * POST request helper.
 */
export const post = <A, I, R>({
  path,
  body,
  responseSchema,
}: PostRequestOptions<A, I, R>): Effect.Effect<
  A,
  NotionApiError,
  NotionConfig | HttpClient.HttpClient | R
> => executeRequest({ method: 'POST', path, responseSchema, body })

/**
 * PATCH request helper.
 */
export const patch = <A, I, R>({
  path,
  body,
  responseSchema,
}: PatchRequestOptions<A, I, R>): Effect.Effect<
  A,
  NotionApiError,
  NotionConfig | HttpClient.HttpClient | R
> => executeRequest({ method: 'PATCH', path, responseSchema, body })

/** Options for DELETE request */
export interface DeleteRequestOptions<A, I, R> {
  readonly path: string
  readonly responseSchema: Schema.Schema<A, I, R>
}

/** DELETE request helper. */
export const del = <A, I, R>({
  path,
  responseSchema,
}: DeleteRequestOptions<A, I, R>): Effect.Effect<
  A,
  NotionApiError,
  NotionConfig | HttpClient.HttpClient | R
> => executeRequest({ method: 'DELETE', path, responseSchema })
