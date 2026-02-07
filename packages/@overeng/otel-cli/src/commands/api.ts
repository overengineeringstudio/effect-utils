/**
 * otel api
 *
 * Raw API calls to Grafana, Tempo, and Collector.
 * A debug tool for direct HTTP interaction with the OTEL stack.
 */

import * as Cli from '@effect/cli'
import { HttpClient, HttpClientRequest } from '@effect/platform'
import { Console, Data, Effect, Option, Schema } from 'effect'

import { OtelConfig } from '../services/OtelConfig.ts'

// =============================================================================
// Types
// =============================================================================

/** Supported services for API calls. */
const Service = Schema.Literal('grafana', 'tempo', 'collector')
type Service = typeof Service.Type

/** Supported HTTP methods. */
const HttpMethod = Schema.Literal('GET', 'POST', 'PUT', 'DELETE', 'PATCH')
type HttpMethod = typeof HttpMethod.Type

// =============================================================================
// Errors
// =============================================================================

/** Error from API operations. */
export class ApiError extends Data.TaggedError('ApiError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

// =============================================================================
// CLI Arguments & Options
// =============================================================================

const serviceArg = Cli.Args.text({ name: 'service' }).pipe(
  Cli.Args.withDescription('Service: grafana, tempo, collector'),
)

const methodArg = Cli.Args.text({ name: 'method' }).pipe(
  Cli.Args.withDescription('HTTP method: GET, POST, PUT, DELETE, PATCH'),
)

const pathArg = Cli.Args.text({ name: 'path' }).pipe(
  Cli.Args.withDescription('API path (e.g., /api/search)'),
)

const bodyOption = Cli.Options.text('body').pipe(
  Cli.Options.withAlias('d'),
  Cli.Options.withDescription('Request body (JSON string)'),
  Cli.Options.optional,
)

const queryOption = Cli.Options.keyValueMap('query').pipe(
  Cli.Options.withAlias('q'),
  Cli.Options.withDescription('Query parameters (key=value, repeatable)'),
  Cli.Options.optional,
)

const headerOption = Cli.Options.keyValueMap('header').pipe(
  Cli.Options.withAlias('H'),
  Cli.Options.withDescription('Extra headers (key:value, repeatable)'),
  Cli.Options.optional,
)

const verboseOption = Cli.Options.boolean('verbose').pipe(
  Cli.Options.withAlias('v'),
  Cli.Options.withDescription('Show full request/response details'),
  Cli.Options.withDefault(false),
)

// =============================================================================
// Command Implementation
// =============================================================================

/** Raw API calls to Grafana, Tempo, and Collector. */
export const apiCommand = Cli.Command.make(
  'api',
  {
    service: serviceArg,
    method: methodArg,
    path: pathArg,
    body: bodyOption,
    query: queryOption,
    header: headerOption,
    verbose: verboseOption,
  },
  ({ service, method, path, body, query, header, verbose }) =>
    Effect.gen(function* () {
      // Validate service
      const validatedService = yield* Schema.decodeUnknown(Service)(service).pipe(
        Effect.mapError(
          () =>
            new ApiError({
              message: `Invalid service: ${service}. Must be one of: grafana, tempo, collector`,
            }),
        ),
      )

      // Validate method
      const validatedMethod = yield* Schema.decodeUnknown(HttpMethod)(method.toUpperCase()).pipe(
        Effect.mapError(
          () =>
            new ApiError({
              message: `Invalid method: ${method}. Must be one of: GET, POST, PUT, DELETE, PATCH`,
            }),
        ),
      )

      // Get config and resolve base URL
      const config = yield* OtelConfig
      const baseUrl = getBaseUrl({ service: validatedService, config })

      // Build the full URL with query parameters
      const url = new URL(path.startsWith('/') ? path : `/${path}`, baseUrl)
      if (Option.isSome(query)) {
        for (const [key, value] of query.value) {
          url.searchParams.append(key, value)
        }
      }

      // Build request
      let request = createRequest({ method: validatedMethod, url: url.toString() })

      // Add headers
      if (Option.isSome(header)) {
        for (const [key, value] of header.value) {
          request = HttpClientRequest.setHeader(key, value)(request)
        }
      }

      // Add Basic auth for Grafana (default: admin:admin)
      if (validatedService === 'grafana') {
        const auth = Buffer.from('admin:admin').toString('base64')
        request = HttpClientRequest.setHeader('Authorization', `Basic ${auth}`)(request)
      }

      // Add body if provided
      if (Option.isSome(body)) {
        request = HttpClientRequest.setHeader('Content-Type', 'application/json')(request)
        const bodyValue = body.value
        const parsed = yield* Effect.try({
          try: () => JSON.parse(bodyValue) as unknown,
          catch: (error) =>
            new ApiError({
              message: 'Failed to parse request body as JSON',
              cause: error,
            }),
        })
        request = yield* HttpClientRequest.bodyJson(parsed)(request).pipe(
          Effect.mapError(
            (error) =>
              new ApiError({
                message: 'Failed to set request body',
                cause: error,
              }),
          ),
        )
      }

      // Show verbose request info
      if (verbose) {
        yield* Console.log(`> ${validatedMethod} ${url.toString()}`)
        for (const [key, value] of Object.entries(request.headers)) {
          if (key !== 'authorization') {
            yield* Console.log(`> ${key}: ${String(value)}`)
          } else {
            yield* Console.log(`> ${key}: [redacted]`)
          }
        }
        yield* Console.log('')
      }

      // Execute request
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(request).pipe(
        Effect.mapError(
          (error) =>
            new ApiError({
              message: `Request failed: ${String(error)}`,
              cause: error,
            }),
        ),
      )

      // Show verbose response info
      if (verbose) {
        yield* Console.log(`< ${String(response.status)}`)
        yield* Console.log('')
      }

      // Get response body as text
      const responseText = yield* response.text.pipe(
        Effect.mapError(
          (error) =>
            new ApiError({
              message: 'Failed to read response body',
              cause: error,
            }),
        ),
      )

      // Try to pretty-print if JSON, otherwise output raw
      const contentType = response.headers['content-type'] ?? ''
      if (contentType.includes('application/json') || looksLikeJson(responseText)) {
        const parseResult = yield* Effect.try({
          try: () => JSON.parse(responseText) as unknown,
          catch: () => null,
        })
        if (parseResult !== null) {
          yield* Console.log(prettyPrintJson(parseResult))
        } else {
          yield* Console.log(responseText)
        }
      } else {
        yield* Console.log(responseText)
      }
    }),
).pipe(Cli.Command.withDescription('Raw API calls to Grafana, Tempo, and Collector'))

// =============================================================================
// Helpers
// =============================================================================

/** Get base URL for a service from config. */
const getBaseUrl = (opts: {
  service: Service
  config: {
    grafanaUrl: string
    tempoQueryUrl: string
    metricsUrl: string
  }
}): string => {
  switch (opts.service) {
    case 'grafana':
      return opts.config.grafanaUrl
    case 'tempo':
      return opts.config.tempoQueryUrl
    case 'collector':
      return opts.config.metricsUrl
  }
}

/** Create an HTTP request with the given method and URL. */
const createRequest = (opts: {
  method: HttpMethod
  url: string
}): HttpClientRequest.HttpClientRequest => {
  switch (opts.method) {
    case 'GET':
      return HttpClientRequest.get(opts.url)
    case 'POST':
      return HttpClientRequest.post(opts.url)
    case 'PUT':
      return HttpClientRequest.put(opts.url)
    case 'DELETE':
      return HttpClientRequest.del(opts.url)
    case 'PATCH':
      return HttpClientRequest.patch(opts.url)
  }
}

/** Check if text looks like JSON (starts with { or [). */
const looksLikeJson = (text: string): boolean => {
  const trimmed = text.trim()
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

/** Pretty-print a value as JSON with 2-space indentation. */
const prettyPrintJson = (value: unknown): string => JSON.stringify(value, null, 2)
