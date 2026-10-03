/**
 * W3C Trace Context `traceparent` codec plus the propagation carriers a browser actually has.
 *
 * Browsers cannot set headers on a WebSocket handshake, so the same value rides three carriers:
 * - HTTP: the `traceparent` header (Effect `HttpClient` injects it automatically; {@link headers}
 *   covers raw `fetch`/`EventSource` code).
 * - WebSocket upgrade: a `?traceparent=` query parameter ({@link toUrl} / {@link wsUrl}).
 * - WebSocket messages: an optional `traceparent` field on a command ({@link withField}).
 *
 * Pure and DOM-free: the server side (gateway relay, tests) uses the same {@link decode},
 * {@link fromUrl} and {@link fromField} so both ends agree on one format.
 *
 * @see https://www.w3.org/TR/trace-context/#traceparent-header
 */
import { Effect, Option, Schema, Tracer } from 'effect'

const pattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/
const zeroTraceId = '0'.repeat(32)
const zeroSpanId = '0'.repeat(16)

/** Default carrier key for the WebSocket URL parameter and the message field. */
export const defaultKey = 'traceparent'

/**
 * A valid version-00 `traceparent`: lowercase hex, non-zero trace and parent ids. Use it as the
 * schema for the optional message field in wire protocols (`Schema.optionalKey(Traceparent)`).
 */
export const Traceparent = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter(
      (value: string) => {
        const match = pattern.exec(value)
        return match !== null && match[1] !== zeroTraceId && match[2] !== zeroSpanId
      },
      { expected: 'a W3C traceparent (00-<32 hex>-<16 hex>-<2 hex>, lowercase, non-zero ids)' },
    ),
  ),
  Schema.brand('Traceparent'),
  Schema.annotate({ identifier: 'Otel.Traceparent' }),
)
/** Validated version-00 W3C carrier value. */
export type Traceparent = typeof Traceparent.Type

const isTraceparent = Schema.is(Traceparent)

/** Parses a carrier value into the remote parent span; invalid or absent values are `None`. */
export const decode = (value: string | null | undefined): Option.Option<Tracer.ExternalSpan> => {
  if (value === null || value === undefined || isTraceparent(value) === false) return Option.none()
  const [, traceId, spanId, flags] = pattern.exec(value)!
  return Option.some(
    Tracer.externalSpan({
      traceId: traceId!,
      spanId: spanId!,
      sampled: (Number.parseInt(flags!, 16) & 1) === 1,
    }),
  )
}

/**
 * Encodes a span as `traceparent`. `None` for spans that carry no real context: Effect's noop span
 * (tracing disabled) reports the ids `"noop"`, which must never reach the wire.
 */
export const encode = (span: Tracer.AnySpan): Option.Option<Traceparent> => {
  const value = `00-${span.traceId}-${span.spanId}-${span.sampled === true ? '01' : '00'}`
  return isTraceparent(value) === true ? Option.some(value) : Option.none()
}

/** `traceparent` of the current span, `None` outside a span or with tracing disabled. */
export const current: Effect.Effect<Option.Option<Traceparent>> = Effect.currentSpan.pipe(
  Effect.map(encode),
  Effect.orElseSucceed(() => Option.none<Traceparent>()),
)

/** W3C-only headers for raw `fetch` (no `b3`, so cross-origin requests need one allowed header). */
export const headers: Effect.Effect<Readonly<Record<string, string>>> = Effect.map(
  current,
  Option.match({ onNone: () => ({}), onSome: (traceparent) => ({ traceparent }) }),
)

/** Returns a copy of `url` carrying `traceparent` as a query parameter (replaces an existing one). */
export const toUrl = ({
  url,
  traceparent,
  param,
}: {
  readonly url: string | URL
  readonly traceparent: Traceparent
  readonly param?: string | undefined
}): URL => {
  const next = new URL(url)
  next.searchParams.set(param ?? defaultKey, traceparent)
  return next
}

/**
 * The WebSocket upgrade URL for the current span: `http(s)` becomes `ws(s)` and the current
 * `traceparent` (when there is one) is added as a query parameter.
 */
export const wsUrl = ({
  url,
  param,
}: {
  readonly url: string | URL
  readonly param?: string | undefined
}): Effect.Effect<URL> =>
  Effect.map(current, (traceparent) => {
    const next = new URL(url)
    if (next.protocol === 'http:') next.protocol = 'ws:'
    if (next.protocol === 'https:') next.protocol = 'wss:'
    return Option.isSome(traceparent) === true
      ? toUrl({
          url: next,
          traceparent: traceparent.value,
          ...(param === undefined ? {} : { param }),
        })
      : next
  })

/** Server side of {@link toUrl}: the remote parent carried by an upgrade URL. */
export const fromUrl = ({
  url,
  param,
}: {
  readonly url: string | URL
  readonly param?: string | undefined
}): Option.Option<Tracer.ExternalSpan> => decode(new URL(url).searchParams.get(param ?? defaultKey))

/**
 * Adds the current `traceparent` to a WebSocket command. The field is omitted (not `undefined`)
 * outside a span so the encoded message stays valid under `Schema.optionalKey`.
 */
export const withField = <TMessage extends object>({
  message,
  field,
}: {
  readonly message: TMessage
  readonly field?: string | undefined
}): Effect.Effect<TMessage & { readonly traceparent?: Traceparent }> =>
  Effect.map(current, (traceparent) =>
    Option.isSome(traceparent) === true
      ? { ...message, [field ?? defaultKey]: traceparent.value }
      : message,
  )

/** Server side of {@link withField}: the remote parent carried by a decoded command. */
export const fromField = ({
  message,
  field,
}: {
  readonly message: unknown
  readonly field?: string | undefined
}): Option.Option<Tracer.ExternalSpan> => {
  if (typeof message !== 'object' || message === null) return Option.none()
  const value = (message as Record<string, unknown>)[field ?? defaultKey]
  return typeof value === 'string' ? decode(value) : Option.none()
}
