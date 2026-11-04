import { createHash, timingSafeEqual } from 'node:crypto'
import { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'

import { NodeStream } from '@effect/platform-node'
import { Data, Effect, Schema, Stream } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import type { GatewayConfig } from './Config.ts'
import { Metrics } from './Metrics.ts'

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Usage = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Unknown),
  completion_tokens: Schema.optional(Schema.Unknown),
  input_tokens: Schema.optional(Schema.Unknown),
  output_tokens: Schema.optional(Schema.Unknown),
  prompt_tokens_details: Schema.optional(Schema.Unknown),
  completion_tokens_details: Schema.optional(Schema.Unknown),
  input_tokens_details: Schema.optional(Schema.Unknown),
  output_tokens_details: Schema.optional(Schema.Unknown),
})
const RequestModel = Schema.Struct({
  model: Schema.NonEmptyString,
  stream: Schema.optional(Schema.Boolean),
})
const decodeRequestModel = Schema.decodeUnknownSync(Schema.fromJsonString(RequestModel))
const decodeUsage = Schema.decodeUnknownOption(Usage)
const decodeTokenCount = Schema.decodeUnknownOption(TokenCount)
const tokenCount = (value: unknown) => {
  const parsed = decodeTokenCount(value)
  return parsed._tag === 'Some' ? parsed.value : undefined
}
const detailCount = ({ value, key }: { value: unknown; key: string }) =>
  typeof value === 'object' && value !== null && key in value
    ? tokenCount(Reflect.get(value, key))
    : undefined
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const ResponsesState = Schema.Struct({
  previous_response_id: Schema.optional(Schema.Unknown),
  conversation: Schema.optional(Schema.Unknown),
  input: Schema.optional(Schema.Unknown),
})
const decodeResponsesState = Schema.decodeUnknownSync(Schema.fromJsonString(ResponsesState))
class ServerSideStateReference extends Data.TaggedError('ServerSideStateReference') {}
class UpstreamStreamError extends Data.TaggedError('UpstreamStreamError')<{
  readonly cause: unknown
}> {}
class RequestBodyTooLarge extends Data.TaggedError('RequestBodyTooLarge') {}

const readBody = Effect.fn('ai-gateway-edge.readBody')(function* (
  request: IncomingMessage,
  limit: number,
) {
  const declared = request.headers['content-length']
  if (declared !== undefined && /^\d+$/.test(declared) === true && BigInt(declared) > BigInt(limit))
    return yield* new RequestBodyTooLarge()
  const chunks: Uint8Array[] = []
  let size = 0
  // Keep the socket open long enough to deliver 413 when stream consumption stops early.
  yield* NodeStream.fromReadable({
    evaluate: () => request,
    closeOnDone: false,
  }).pipe(
    Stream.runForEach((chunk) => {
      if (chunk.byteLength > limit - size) return Effect.fail(new RequestBodyTooLarge())
      size += chunk.byteLength
      chunks.push(chunk)
      return Effect.void
    }),
  )
  return Buffer.concat(chunks, size).toString('utf8')
})
const excludedHeaders = new Set([
  'authorization',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

/** Keep upstream response streaming abortable when a downstream socket closes. */
const abortOnSocketClose = (socket: Socket) => {
  const controller = new AbortController()
  const abort = () => controller.abort()
  socket.once('close', abort)
  return { signal: controller.signal, dispose: () => socket.removeListener('close', abort), abort }
}
const error = ({ status, message }: { status: number; message: string }) =>
  HttpServerResponse.jsonUnsafe(
    {
      error: {
        message,
        type: status === 401 ? 'authentication_error' : 'gateway_error',
        code: null,
      },
    },
    { status, ...(status === 413 ? { headers: { connection: 'close' } } : {}) },
  )

/** Process one SSE event at a time; arbitrarily split UTF-8 chunks never require buffering the response. */
class UsageEvents {
  private readonly decoder = new TextDecoder()
  private line = ''
  private data = ''
  private overflow = false
  private readonly maxEventChars: number
  private readonly maxLineChars: number
  private readonly record: (value: unknown) => void
  constructor({
    record,
    maxEventChars = 131072,
    maxLineChars = 65536,
  }: {
    record: (value: unknown) => void
    maxEventChars?: number
    maxLineChars?: number
  }) {
    this.record = record
    this.maxEventChars = maxEventChars
    this.maxLineChars = maxLineChars
  }
  push(bytes: Uint8Array) {
    const text = this.decoder.decode(bytes, { stream: true })
    for (const char of text) {
      if (char === '\n') {
        const line = this.line.replace(/\r$/, '')
        this.line = ''
        if (line === '') {
          if (this.overflow === false && this.data.length > 0) {
            try {
              this.record(decodeJson(this.data))
            } catch {
              /* malformed upstream event is not usage */
            }
          }
          this.data = ''
          this.overflow = false
        } else if (this.overflow === false && line.startsWith('data:') === true) {
          const data = line.slice(5).trimStart()
          if (this.data.length + data.length + 1 > this.maxEventChars) this.overflow = true
          else this.data += `${this.data.length === 0 ? '' : '\n'}${data}`
        }
      } else if (this.line.length < this.maxLineChars) this.line += char
      else this.overflow = true
    }
  }
}

/** Build digest-authenticated, usage-metered forwarding routes and their metrics. */
export const makeRoutes = ({
  config,
  metrics = new Metrics(config.maxModelLabels ?? 64),
}: {
  readonly config: GatewayConfig
  readonly metrics?: Metrics
}) => {
  const consumers = config.consumers.map(({ name, tokenSha256 }) => ({
    name,
    digest: Buffer.from(tokenSha256, 'hex'),
  }))
  if (
    new Set(config.consumers.map(({ name }) => name)).size !== consumers.length ||
    new Set(config.consumers.map(({ tokenSha256 }) => tokenSha256)).size !== consumers.length
  )
    throw new Error('Consumer names and token digests must be unique')

  const upstream = new URL(config.upstream)
  const maxRequestBodyBytes = config.maxRequestBodyBytes ?? 1048576
  const authenticate = (header: string | undefined) => {
    const match = /^Bearer ([^\s]+)$/.exec(header ?? '')
    const digest = createHash('sha256')
      .update(match?.[1] ?? '')
      .digest()
    let name: string | undefined
    for (const consumer of consumers) {
      // Check every entry, including for absent/malformed tokens.
      if (timingSafeEqual(digest, consumer.digest) === true && match !== null) name = consumer.name
    }
    return name
  }

  const meterUsage = ({
    consumer,
    model,
    status,
    value,
  }: {
    consumer: string
    model: string
    status: number
    value: unknown
  }) => {
    const parsed = decodeUsage(value)
    if (parsed._tag === 'None') return
    const usage = parsed.value
    const input = tokenCount(usage.prompt_tokens) ?? tokenCount(usage.input_tokens)
    const output = tokenCount(usage.completion_tokens) ?? tokenCount(usage.output_tokens)
    if (input !== undefined)
      metrics.addTokens({
        labels: { consumer, model },
        status: status,
        kind: 'input',
        count: input,
      })
    if (output !== undefined)
      metrics.addTokens({
        labels: { consumer, model },
        status: status,
        kind: 'output',
        count: output,
      })
    const cached =
      detailCount({ value: usage.prompt_tokens_details, key: 'cached_tokens' }) ??
      detailCount({ value: usage.input_tokens_details, key: 'cached_tokens' })
    const reasoning =
      detailCount({ value: usage.completion_tokens_details, key: 'reasoning_tokens' }) ??
      detailCount({ value: usage.output_tokens_details, key: 'reasoning_tokens' })
    if (cached !== undefined)
      metrics.addTokens({
        labels: { consumer, model },
        status: status,
        kind: 'cached',
        count: cached,
      })
    if (reasoning !== undefined)
      metrics.addTokens({
        labels: { consumer, model },
        status: status,
        kind: 'reasoning',
        count: reasoning,
      })
  }

  const forward = (
    path:
      | '/v1/chat/completions'
      | '/v1/responses'
      | '/v1/models'
      | '/v1/systemone'
      | '/alpha/decisions',
  ) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const consumer = authenticate(request.headers['authorization'])
      if (consumer === undefined || consumer === '')
        return error({ status: 401, message: 'Invalid bearer token' })
      if (!(request.source instanceof IncomingMessage))
        return error({ status: 500, message: 'Unsupported HTTP request' })
      const started = performance.now()
      let model = path === '/v1/models' ? 'models' : 'unknown'
      let body: string | undefined
      const requestBodyLimit =
        path === '/v1/responses'
          ? (config.routeMaxRequestBodyBytes?.['/v1/responses'] ?? maxRequestBodyBytes)
          : maxRequestBodyBytes
      const text = yield* readBody(request.source, requestBodyLimit).pipe(
        Effect.catchTag('RequestBodyTooLarge', () => Effect.void),
      )
      if (text === undefined) {
        metrics.record({
          labels: { consumer, model },
          status: 413,
          seconds: (performance.now() - started) / 1000,
        })
        return error({ status: 413, message: 'Request body too large' })
      }
      if (path !== '/v1/models') {
        const parsed = yield* Effect.try({
          try: () => {
            const value = decodeRequestModel(text)
            if (path === '/v1/responses') {
              const state = decodeResponsesState(text)
              if (
                (state.previous_response_id !== undefined && state.previous_response_id !== null) ||
                Object.hasOwn(state, 'conversation') === true ||
                (Array.isArray(state.input) === true &&
                  state.input.some(
                    (item: unknown) =>
                      typeof item === 'object' &&
                      item !== null &&
                      (('type' in item && item.type === 'item_reference') ||
                        ((!('type' in item) || item.type === null) && !('role' in item))),
                  ) === true)
              )
                throw new ServerSideStateReference()
            }
            if (path !== '/v1/chat/completions' || value.stream !== true)
              return { model: value.model, body: text }
            const payload = decodeJson(text)
            if (typeof payload !== 'object' || payload === null || Array.isArray(payload) === true)
              throw new Error('Expected object')
            const streamOptions = 'stream_options' in payload ? payload.stream_options : undefined
            return {
              model: value.model,
              body: encodeJson({
                ...payload,
                stream_options: {
                  ...(typeof streamOptions === 'object' &&
                  streamOptions !== null &&
                  Array.isArray(streamOptions) === false
                    ? streamOptions
                    : {}),
                  include_usage: true,
                },
              }),
            }
          },
          catch: (cause) =>
            cause instanceof ServerSideStateReference
              ? ('server-side state reference' as const)
              : ('invalid request' as const),
        }).pipe(Effect.catch((reason) => Effect.succeed({ reason })))
        if ('reason' in parsed) {
          metrics.record({
            labels: { consumer, model },
            status: 400,
            seconds: (performance.now() - started) / 1000,
          })
          return error({
            status: 400,
            message:
              parsed.reason === 'server-side state reference'
                ? 'Server-side state references are not supported; send self-contained input with encrypted reasoning items'
                : 'Invalid request JSON or model',
          })
        }
        model = parsed.model
        body = parsed.body
      }
      const requestHeaders = new Headers()
      const connectionOptions = new Set(
        (request.headers['connection'] ?? '').split(',').map((name) => name.trim().toLowerCase()),
      )
      for (const [name, value] of Object.entries(request.headers)) {
        if (
          value !== undefined &&
          excludedHeaders.has(name.toLowerCase()) === false &&
          connectionOptions.has(name.toLowerCase()) === false
        )
          requestHeaders.set(name, value)
      }
      requestHeaders.set('accept-encoding', 'identity')
      const effectSignal = yield* Effect.abortSignal
      const socketAbort = abortOnSocketClose(request.source.socket)
      const url = new URL(path, upstream)
      const result = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(url, {
            method: request.method,
            headers: requestHeaders,
            ...(body === undefined ? {} : { body }),
            signal: AbortSignal.any([signal, effectSignal, socketAbort.signal]),
          }),
        catch: () => 'upstream unavailable' as const,
      }).pipe(Effect.orElseSucceed(() => undefined))
      if (result === undefined) {
        socketAbort.dispose()
        metrics.record({
          labels: { consumer, model },
          status: 502,
          seconds: (performance.now() - started) / 1000,
        })
        return error({ status: 502, message: 'Upstream unavailable' })
      }
      const response = result
      const responseHeaders: Record<string, string> = {}
      const upstreamConnectionOptions = new Set(
        (response.headers.get('connection') ?? '')
          .split(',')
          .map((name) => name.trim().toLowerCase()),
      )
      response.headers.forEach((value, name) => {
        if (
          excludedHeaders.has(name.toLowerCase()) === false &&
          upstreamConnectionOptions.has(name.toLowerCase()) === false &&
          name.toLowerCase() !== 'content-encoding'
        )
          responseHeaders[name] = value
      })
      if (response.body === null) {
        socketAbort.dispose()
        metrics.record({
          labels: { consumer, model },
          status: response.status,
          seconds: (performance.now() - started) / 1000,
        })
        return HttpServerResponse.empty({ status: response.status, headers: responseHeaders })
      }
      let terminalUsageObserved = false
      const events = new UsageEvents({
        record: (value) => {
          if (path === '/v1/responses') {
            if (
              terminalUsageObserved === true ||
              typeof value !== 'object' ||
              value === null ||
              !('type' in value) ||
              (value.type !== 'response.completed' &&
                value.type !== 'response.incomplete' &&
                value.type !== 'response.failed')
            )
              return
            terminalUsageObserved = true
            if (
              'response' in value &&
              typeof value.response === 'object' &&
              value.response !== null &&
              'usage' in value.response
            )
              meterUsage({ consumer, model, status: response.status, value: value.response.usage })
            return
          }
          if (
            typeof value === 'object' &&
            value !== null &&
            'usage' in value &&
            value.usage !== null
          )
            meterUsage({
              consumer: consumer,
              model: model,
              status: response.status,
              value: value.usage,
            })
        },
        ...(path === '/v1/responses' ? { maxEventChars: 16777216, maxLineChars: 16777216 } : {}),
      })
      const isSse = response.headers.get('content-type')?.includes('text/event-stream') ?? false
      const stream = Stream.fromReadableStream({
        evaluate: () => response.body!,
        onError: (cause) => new UpstreamStreamError({ cause }),
      }).pipe(
        Stream.tap((chunk) =>
          Effect.sync(() => {
            if (isSse === true) events.push(chunk)
          }),
        ),
        Stream.ensuring(
          Effect.sync(() => {
            socketAbort.dispose()
            socketAbort.abort()
            metrics.record({
              labels: { consumer, model },
              status: response.status,
              seconds: (performance.now() - started) / 1000,
            })
          }),
        ),
      )
      if (isSse === true)
        return HttpServerResponse.stream(stream, {
          status: response.status,
          headers: responseHeaders,
        })
      // Preserve non-stream upstream bytes; JSON usage is optional even for error responses.
      const bytes = yield* Stream.runCollect(stream).pipe(
        Effect.map((chunks) => Buffer.concat([...chunks])),
      )
      const json = yield* Effect.try({
        try: () => decodeJson(bytes.toString('utf8')),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined))
      if (typeof json === 'object' && json !== null && 'usage' in json && json.usage !== null)
        meterUsage({ consumer: consumer, model: model, status: response.status, value: json.usage })
      return HttpServerResponse.uint8Array(bytes, {
        status: response.status,
        headers: responseHeaders,
      })
    })

  const health = Effect.gen(function* () {
    const result = yield* Effect.tryPromise({
      try: (signal) => fetch(new URL('/healthz', upstream), { signal }),
      catch: () => 'upstream unavailable' as const,
    }).pipe(Effect.orElseSucceed(() => undefined))
    return result?.ok === true
      ? HttpServerResponse.jsonUnsafe({ status: 'ok' })
      : HttpServerResponse.jsonUnsafe({ status: 'unavailable' }, { status: 503 })
  })
  return {
    router: HttpRouter.addAll([
      HttpRouter.route('GET', '/healthz', health),
      HttpRouter.route('GET', '/v1/models', forward('/v1/models')),
      HttpRouter.route('POST', '/v1/chat/completions', forward('/v1/chat/completions')),
      HttpRouter.route('POST', '/v1/responses', forward('/v1/responses')),
      HttpRouter.route('POST', '/v1/systemone', forward('/v1/systemone')),
      HttpRouter.route('POST', '/alpha/decisions', forward('/alpha/decisions')),
    ]),
    metrics,
  }
}
