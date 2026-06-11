import type { Effect } from 'effect'
import { Option, Schema } from 'effect'

import { OtelAttr, OtelAttrs, OtelSpan } from '@overeng/otel-contract'

import type { BuildRequestOptions, NotionHttpRouteInfo, RateLimitInfo } from './http.ts'

const Method = Schema.Literal('GET', 'POST', 'PATCH', 'DELETE')

const HttpSpanAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    method: Method.pipe(OtelAttr.key({ key: 'notion.http.method' })),
    route: Schema.String.pipe(OtelAttr.key({ key: 'notion.http.route' })),
    operation: Schema.String.pipe(OtelAttr.key({ key: 'notion.http.operation' })),
  }),
)

const HttpRateLimitAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    method: Method.pipe(OtelAttr.key({ key: 'notion.http.method' })),
    route: Schema.String.pipe(OtelAttr.key({ key: 'notion.http.route' })),
    operation: Schema.String.pipe(OtelAttr.key({ key: 'notion.http.operation' })),
    status: Schema.optional(Schema.Number.pipe(OtelAttr.key({ key: 'notion.http.status_code' }))),
    attempt: Schema.Number.pipe(OtelAttr.key({ key: 'notion.http.retry.attempt' })),
    attempts: Schema.Number.pipe(OtelAttr.key({ key: 'notion.http.retry.attempts' })),
    retryDelayMs: Schema.optional(
      Schema.Number.pipe(OtelAttr.key({ key: 'notion.http.retry.delay_ms' })),
    ),
    quotaCost: Schema.Number.pipe(OtelAttr.key({ key: 'notion.quota.cost' })),
    rateLimitPresent: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion.rate_limit.present' })),
    rateLimitRemaining: Schema.optional(
      Schema.Number.pipe(OtelAttr.key({ key: 'notion.rate_limit.remaining' })),
    ),
    rateLimitResetAfterMs: Schema.optional(
      Schema.Number.pipe(OtelAttr.key({ key: 'notion.rate_limit.reset_after_ms' })),
    ),
  }),
)

const DataSourceQueryAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    dataSourceId: Schema.String.pipe(OtelAttr.key({ key: 'notion.data_source_id' })),
  }),
)

const PageRetrieveAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion.page_id' })),
  }),
)

const NotionHttpSpan = (method: BuildRequestOptions['method']) =>
  OtelSpan.define({
    name: `NotionHttp.${method}`,
    attributes: HttpSpanAttrs,
  })

const NotionDatabasesQuerySpan = OtelSpan.define({
  name: 'NotionDatabases.query',
  attributes: DataSourceQueryAttrs,
})

const NotionPagesRetrieveSpan = OtelSpan.define({
  name: 'NotionPages.retrieve',
  attributes: PageRetrieveAttrs,
})

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
      OtelSpan.unsafeWith({
        span: NotionHttpSpan(method),
        attributes: {
          label: route.spanLabel,
          method,
          route: route.route,
          operation: route.operation,
        },
      }),
    )

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
  return OtelSpan.unsafeAnnotate({
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
      rateLimitRemaining: isSome ? rateLimit.value.remaining : undefined,
      rateLimitResetAfterMs: isSome ? rateLimit.value.resetAfterSeconds * 1000 : undefined,
    },
  })
}

export const withNotionDatabasesQuerySpan = (dataSourceId: string) =>
  OtelSpan.unsafeWith({
    span: NotionDatabasesQuerySpan,
    attributes: { label: dataSourceId, dataSourceId },
  })

export const withNotionPagesRetrieveSpan = (pageId: string) =>
  OtelSpan.unsafeWith({
    span: NotionPagesRetrieveSpan,
    attributes: { label: pageId, pageId },
  })
