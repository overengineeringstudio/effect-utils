import { createHash, timingSafeEqual } from 'node:crypto'
import { Socket } from 'node:net'

import { Data, Effect, Schema, Stream } from 'effect'
import { HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http'

import type { GatewayConfig } from './Config.ts'
import { Metrics } from './Metrics.ts'

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Usage = Schema.Struct({
  prompt_tokens: Schema.optional(TokenCount),
  completion_tokens: Schema.optional(TokenCount),
  input_tokens: Schema.optional(TokenCount),
  output_tokens: Schema.optional(TokenCount),
  prompt_tokens_details: Schema.optional(
    Schema.Struct({ cached_tokens: Schema.optional(TokenCount) }),
  ),
  completion_tokens_details: Schema.optional(
    Schema.Struct({ reasoning_tokens: Schema.optional(TokenCount) }),
  ),
})
const RequestModel = Schema.Struct({
  model: Schema.NonEmptyString,
  stream: Schema.optional(Schema.Boolean),
})
const decodeRequestModel = Schema.decodeUnknownSync(Schema.fromJsonString(RequestModel))
const decodeUsage = Schema.decodeUnknownOption(Usage)
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
class UpstreamStreamError extends Data.TaggedError('UpstreamStreamError')<{
  readonly cause: unknown
}> {}
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
    { status },
  )

/** Process one SSE event at a time; arbitrarily split UTF-8 chunks never require buffering the response. */
class UsageEvents {
  private readonly decoder = new TextDecoder()
  private line = ''
  private data = ''
  private readonly record: (value: unknown) => void
  constructor(record: (value: unknown) => void) {
    this.record = record
  }
  push(bytes: Uint8Array) {
    const text = this.decoder.decode(bytes, { stream: true })
    for (const char of text) {
      if (char === '\n') {
        const line = this.line.replace(/\r$/, '')
        this.line = ''
        if (line === '') {
          if (this.data.length > 0) {
            try {
              this.record(decodeJson(this.data))
            } catch {
              /* malformed upstream event is not usage */
            }
            this.data = ''
          }
        } else if (line.startsWith('data:') === true && this.data.length < 131072)
          this.data += `${this.data.length === 0 ? '' : '\n'}${line.slice(5).trimStart()}`
      } else if (this.line.length < 65536) this.line += char
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
    const input = usage.prompt_tokens ?? usage.input_tokens
    const output = usage.completion_tokens ?? usage.output_tokens
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
    if (usage.prompt_tokens_details?.cached_tokens !== undefined)
      metrics.addTokens({
        labels: { consumer, model },
        status: status,
        kind: 'cached',
        count: usage.prompt_tokens_details.cached_tokens,
      })
    if (usage.completion_tokens_details?.reasoning_tokens !== undefined)
      metrics.addTokens({
        labels: { consumer, model },
        status: status,
        kind: 'reasoning',
        count: usage.completion_tokens_details.reasoning_tokens,
      })
  }

  const forward = (
    path: '/v1/chat/completions' | '/v1/models' | '/v1/systemone' | '/alpha/decisions',
  ) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const consumer = authenticate(request.headers['authorization'])
      if (consumer === undefined || consumer === '')
        return error({ status: 401, message: 'Invalid bearer token' })
      const started = performance.now()
      let model = path === '/v1/models' ? 'models' : 'unknown'
      let body: string | undefined
      if (path !== '/v1/models') {
        const text = yield* request.text
        const parsed = yield* Effect.try({
          try: () => {
            const value = decodeRequestModel(text)
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
          catch: () => 'invalid request' as const,
        }).pipe(Effect.orElseSucceed(() => undefined))
        if (parsed === undefined) {
          metrics.record({
            labels: { consumer, model },
            status: 400,
            seconds: (performance.now() - started) / 1000,
          })
          return error({ status: 400, message: 'Invalid request JSON or model' })
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
      if (!('socket' in request.source) || !(request.source.socket instanceof Socket))
        return error({ status: 500, message: 'Unsupported HTTP request' })
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
      const events = new UsageEvents((value) => {
        if (typeof value === 'object' && value !== null && 'usage' in value && value.usage !== null)
          meterUsage({
            consumer: consumer,
            model: model,
            status: response.status,
            value: value.usage,
          })
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
      HttpRouter.route('POST', '/v1/systemone', forward('/v1/systemone')),
      HttpRouter.route('POST', '/alpha/decisions', forward('/alpha/decisions')),
    ]),
    metrics,
  }
}
