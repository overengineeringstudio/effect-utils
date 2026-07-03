import { Effect, Option, Schema } from 'effect'

import {
  OtelAttr,
  OtelAttrs,
  OtelOperation,
  OtelSpan,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'

import {
  NotionDatabasesQueryOperation,
  NotionHttpMethod,
  NotionHttpOperation,
  NotionHttpRetryAttempt,
  NotionHttpRetryAttempts,
  NotionHttpRetryDelayMs,
  NotionHttpRoute,
  NotionHttpStatusCode,
  NotionPagesRetrieveOperation,
  NotionQuotaCost,
  NotionRateLimitPresent,
  NotionRateLimitRemaining,
  NotionRateLimitResetAfterMs,
  NotionRateLimitWaitMs,
} from '../notion-effect-client.contract.ts'
import type { BuildRequestOptions, NotionHttpRouteInfo, RateLimitInfo } from './http.ts'

// The per-method request span embeds the HTTP method in its NAME, so it has no stable single-signal
// registry projection and stays a LEGACY inline `OtelOperation.define` DYNAMIC-NAME bridge (SC-DQ5).
// Its attribute schema is REBUILT from the imported `notion.*` catalog attrs (identical encode).
const HttpSpanAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    spanLabel: OtelAttr.drop(Schema.NonEmptyString),
    method: NotionHttpMethod,
    route: NotionHttpRoute,
    operation: NotionHttpOperation,
  }),
)

// Annotate-only bundle stamped on the CURRENT (request) span; rebuilt from the imported catalog.
const HttpRateLimitAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    method: NotionHttpMethod,
    route: NotionHttpRoute,
    operation: NotionHttpOperation,
    status: Schema.optional(NotionHttpStatusCode),
    attempt: NotionHttpRetryAttempt,
    attempts: NotionHttpRetryAttempts,
    retryDelayMs: Schema.optional(NotionHttpRetryDelayMs),
    quotaCost: NotionQuotaCost,
    rateLimitPresent: NotionRateLimitPresent,
    rateLimitRemaining: Schema.optional(NotionRateLimitRemaining),
    rateLimitResetAfterMs: Schema.optional(NotionRateLimitResetAfterMs),
  }),
)

// Annotate-only throttle-wait bundle; rebuilt from the imported catalog.
const HttpRateLimitWaitAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    rateLimitWaitMs: NotionRateLimitWaitMs,
  }),
)

const NotionHttpSpan = (method: BuildRequestOptions['method']) =>
  OtelOperation.define({
    name: `NotionHttp.${method}`,
    attributes: HttpSpanAttrs,
    label: ({ spanLabel }) => spanLabel,
  })

// DERIVED static-name spans (re-pointed at the seam contract's `.operation` products).
const NotionDatabasesQuerySpan = NotionDatabasesQueryOperation.operation

const NotionPagesRetrieveSpan = NotionPagesRetrieveOperation.operation

const withOperation =
  <S extends Schema.Schema.AnyNoContext>({
    operation,
    attributes,
  }: {
    operation: OtelOperationDefinition<S>
    attributes: Schema.Schema.Type<S>
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      operation.with(attributes),
      Effect.catchTag('OtelAttrEncodeError', (error) => Effect.die(error)),
    )

const annotateAttrs = <S extends Schema.Schema.AnyNoContext>({
  attributes,
  value,
}: {
  attributes: OtelAttrs<S>
  value: Schema.Schema.Type<S>
}): Effect.Effect<void> =>
  OtelSpan.annotate({ attributes, value }).pipe(
    Effect.catchTag('OtelAttrEncodeError', (error) => Effect.die(error)),
  )

/** Wraps an HTTP effect in the per-method `NotionHttp.<method>` span, attaching route/operation attributes and the span label. */
export const withNotionHttpSpan =
  ({
    method,
    route,
  }: {
    readonly method: BuildRequestOptions['method']
    readonly route: NotionHttpRouteInfo
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    effect.pipe(
      withOperation({
        operation: NotionHttpSpan(method),
        attributes: {
          spanLabel: route.spanLabel,
          method,
          route: route.route,
          operation: route.operation,
        },
      }),
    )

/** Annotates the current span with retry/quota/rate-limit attributes for one Notion HTTP attempt (absent rate-limit headers set `present: false`). */
export const annotateNotionHttpRateLimitSpan = (input: {
  readonly method: BuildRequestOptions['method']
  readonly route: NotionHttpRouteInfo
  readonly status?: number
  readonly attempt: number
  readonly attempts: number
  readonly retryDelayMs?: number
  readonly rateLimit: Option.Option<RateLimitInfo>
}): Effect.Effect<void> => {
  const rateLimit = input.rateLimit
  const isSome = Option.isSome(rateLimit)
  return annotateAttrs({
    attributes: HttpRateLimitAttrs,
    value: {
      label: input.route.spanLabel,
      method: input.method,
      route: input.route.route,
      operation: input.route.operation,
      status: input.status,
      attempt: input.attempt,
      attempts: input.attempts,
      retryDelayMs: input.retryDelayMs,
      quotaCost: input.attempts,
      rateLimitPresent: isSome,
      rateLimitRemaining: isSome === true ? rateLimit.value.remaining : undefined,
      rateLimitResetAfterMs: isSome === true ? rateLimit.value.resetAfterSeconds * 1000 : undefined,
    },
  })
}

/**
 * Stamp the throttle-token wait (ms) on the CURRENT span — the surrounding
 * `NotionHttp.<METHOD>` span (decision 0017 Half 2). Called from the throttle
 * seam where no route is in scope, so it carries only the wait duration; the
 * method/operation slice already rides the request span's other attributes.
 */
export const annotateNotionRateLimitWaitSpan = (rateLimitWaitMs: number): Effect.Effect<void> =>
  annotateAttrs({ attributes: HttpRateLimitWaitAttrs, value: { rateLimitWaitMs } })

/** Wraps a data-source query effect in the `NotionDatabases.query` span, labeled by data source id. */
export const withNotionDatabasesQuerySpan = (dataSourceId: string) =>
  withOperation({ operation: NotionDatabasesQuerySpan, attributes: { dataSourceId } })

/** Wraps a page-retrieve effect in the `NotionPages.retrieve` span, labeled by page id. */
export const withNotionPagesRetrieveSpan = (pageId: string) =>
  withOperation({ operation: NotionPagesRetrieveSpan, attributes: { pageId } })
