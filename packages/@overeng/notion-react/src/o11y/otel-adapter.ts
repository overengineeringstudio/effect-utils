/**
 * Raw `@opentelemetry/api` adapter for the core `onEvent` hook.
 *
 * Secondary o11y path for non-Effect consumers. Most of the codebase is
 * Effect-native and should reach for `@overeng/notion-react/o11y/effect`
 * instead — which routes through the Effect tracer and integrates with
 * `@effect/opentelemetry` exporter layers.
 *
 * This adapter accepts a plain `Tracer` from `@opentelemetry/api` and
 * emits spans/events directly. `@opentelemetry/api` is declared as a
 * peer dep so the adapter doesn't force the SDK on every consumer.
 */
import { context, trace } from '@opentelemetry/api'
import type { Attributes, Span, SpanStatusCode, Tracer } from '@opentelemetry/api'
import { Schema } from 'effect'

import { OtelAttr, OtelAttrs } from '@overeng/otel-contract'

import type { SyncEvent, SyncEventHandler } from '../renderer/sync-events.ts'

/** Default service name attribute attached to every emitted span. */
export const DEFAULT_SERVICE_NAME = 'notion-react'

const shortId = (id: string): string => id.replaceAll('-', '').slice(0, 8)

/** Numeric values for `SpanStatusCode` — avoids importing the const enum. */
const STATUS_OK = 1 as SpanStatusCode
const STATUS_ERROR = 2 as SpanStatusCode

const OpKind = Schema.Literal('append', 'update', 'delete', 'retrieve')
const SyncFallbackReasonSchema = Schema.String

const SyncStartAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    serviceName: Schema.NonEmptyString.pipe(OtelAttr.key({ key: 'service.name' })),
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
    pageId: Schema.String.pipe(OtelAttr.key({ key: 'notion-react.page_id' })),
    rootBlockCount: Schema.NonNegativeInt.pipe(
      OtelAttr.key({ key: 'notion-react.root_block_count' }),
    ),
  }),
)

const SyncEndAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    ok: Schema.Boolean.pipe(OtelAttr.key({ key: 'notion-react.ok' })),
    opCount: Schema.NonNegativeInt.pipe(OtelAttr.key({ key: 'notion-react.op_count' })),
    durationMs: Schema.Number.pipe(OtelAttr.key({ key: 'notion-react.duration_ms' })),
    fallbackReason: Schema.optional(
      SyncFallbackReasonSchema.pipe(OtelAttr.key({ key: 'notion-react.fallback_reason' })),
    ),
  }),
)

const OpStartAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    serviceName: Schema.NonEmptyString.pipe(OtelAttr.key({ key: 'service.name' })),
    label: OpKind.pipe(OtelAttr.spanLabel()),
    id: Schema.NonNegativeInt.pipe(OtelAttr.key({ key: 'notion-react.op.id' })),
    kind: OpKind.pipe(OtelAttr.key({ key: 'notion-react.op.kind' })),
  }),
)

const OpSucceededAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    durationMs: Schema.Number.pipe(OtelAttr.key({ key: 'notion-react.op.duration_ms' })),
    resultCount: Schema.NonNegativeInt.pipe(OtelAttr.key({ key: 'notion-react.op.result_count' })),
    note: Schema.optional(
      Schema.Literal('already-archived').pipe(OtelAttr.key({ key: 'notion-react.op.note' })),
    ),
  }),
)

const OpFailedAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    durationMs: Schema.Number.pipe(OtelAttr.key({ key: 'notion-react.op.duration_ms' })),
    error: Schema.String.pipe(OtelAttr.key({ key: 'notion-react.op.error' })),
  }),
)

const CacheEventAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    serviceName: Schema.NonEmptyString.pipe(OtelAttr.key({ key: 'service.name' })),
    label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()),
  }),
)

const FallbackEventAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    serviceName: Schema.NonEmptyString.pipe(OtelAttr.key({ key: 'service.name' })),
    reason: SyncFallbackReasonSchema.pipe(OtelAttr.key({ key: 'notion-react.fallback_reason' })),
  }),
)

const BatchFlushEventAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    serviceName: Schema.NonEmptyString.pipe(OtelAttr.key({ key: 'service.name' })),
    issued: Schema.NonNegativeInt.pipe(OtelAttr.key({ key: 'notion-react.batch.issued' })),
    batched: Schema.NonNegativeInt.pipe(OtelAttr.key({ key: 'notion-react.batch.batched' })),
  }),
)

const UpdateNoopEventAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    serviceName: Schema.NonEmptyString.pipe(OtelAttr.key({ key: 'service.name' })),
    blockId: Schema.String.pipe(OtelAttr.key({ key: 'notion-react.block_id' })),
    reason: Schema.Literal('hash-equal', 'other').pipe(
      OtelAttr.key({ key: 'notion-react.noop_reason' }),
    ),
  }),
)

const CheckpointWrittenEventAttrs = OtelAttrs.defineSync(
  Schema.Struct({
    serviceName: Schema.NonEmptyString.pipe(OtelAttr.key({ key: 'service.name' })),
    bytes: Schema.optional(
      Schema.NonNegativeInt.pipe(OtelAttr.key({ key: 'notion-react.checkpoint.bytes' })),
    ),
  }),
)

/** Config for {@link createOtelEventHandler}. */
export interface OtelEventHandlerConfig {
  readonly tracer: Tracer
  /** Embedded as `service.name` span attribute; defaults to `'notion-react'`. */
  readonly serviceName?: string
}

/**
 * Convert {@link SyncEvent}s to OpenTelemetry spans + span events.
 *
 * Span catalogue:
 *   - `notion-react.sync` — root span per sync invocation
 *   - `notion-react.op.<kind>` — one child span per HTTP op
 *
 * Span events on the root: `cache:<kind>`, `fallback`, `batch-flush`,
 * `update-noop`, `checkpoint-written`.
 *
 * Re-entrant: a single handler instance tracks one sync at a time via
 * closure state. For concurrent syncs, create one handler per sync.
 */
export const createOtelEventHandler = (config: OtelEventHandlerConfig): SyncEventHandler => {
  const tracer = config.tracer
  const serviceName = config.serviceName ?? DEFAULT_SERVICE_NAME
  let rootSpan: Span | undefined
  const opSpans = new Map<number, Span>()

  const cacheEventAttrs = (kind: 'hit' | 'miss' | 'drift' | 'page-id-drift'): Attributes =>
    CacheEventAttrs.encodeSync({ serviceName, label: `cache:${kind}` })

  return (event: SyncEvent): void => {
    switch (event._tag) {
      case 'SyncStart': {
        rootSpan = tracer.startSpan('notion-react.sync', {
          startTime: event.at,
          attributes: SyncStartAttrs.encodeSync({
            serviceName,
            label: shortId(event.pageId),
            pageId: event.pageId,
            rootBlockCount: event.rootBlockCount,
          }),
        })
        break
      }
      case 'SyncEnd': {
        if (rootSpan === undefined) break
        rootSpan.setAttributes(
          SyncEndAttrs.encodeSync({
            ok: event.ok,
            opCount: event.opCount,
            durationMs: event.durationMs,
            ...(event.fallbackReason === undefined ? {} : { fallbackReason: event.fallbackReason }),
          }),
        )
        rootSpan.setStatus({ code: event.ok ? STATUS_OK : STATUS_ERROR })
        rootSpan.end(event.at)
        rootSpan = undefined
        for (const span of opSpans.values()) {
          span.setStatus({ code: STATUS_ERROR })
          span.end(event.at)
        }
        opSpans.clear()
        break
      }
      case 'OpIssued': {
        // Parent op spans to the sync root via an explicit context so
        // traced environments preserve the `notion-react.sync` → op span
        // hierarchy instead of attaching op spans to the ambient context.
        const parentCtx =
          rootSpan !== undefined ? trace.setSpan(context.active(), rootSpan) : context.active()
        const span = tracer.startSpan(
          `notion-react.op.${event.kind}`,
          {
            startTime: event.at,
            attributes: OpStartAttrs.encodeSync({
              serviceName,
              label: event.kind,
              id: event.id,
              kind: event.kind,
            }),
          },
          parentCtx,
        )
        opSpans.set(event.id, span)
        break
      }
      case 'OpSucceeded': {
        const span = opSpans.get(event.id)
        if (span === undefined) break
        span.setAttributes(
          OpSucceededAttrs.encodeSync({
            durationMs: event.durationMs,
            resultCount: event.resultCount,
            ...(event.note === undefined ? {} : { note: event.note }),
          }),
        )
        span.setStatus({ code: STATUS_OK })
        span.end(event.at)
        opSpans.delete(event.id)
        break
      }
      case 'OpFailed': {
        const span = opSpans.get(event.id)
        if (span === undefined) break
        span.setAttributes(
          OpFailedAttrs.encodeSync({ durationMs: event.durationMs, error: event.error }),
        )
        span.setStatus({ code: STATUS_ERROR, message: event.error })
        span.end(event.at)
        opSpans.delete(event.id)
        break
      }
      case 'CacheOutcome': {
        if (rootSpan === undefined) break
        rootSpan.addEvent(`cache:${event.kind}`, cacheEventAttrs(event.kind), event.at)
        break
      }
      case 'FallbackTriggered': {
        if (rootSpan === undefined) break
        rootSpan.addEvent(
          'fallback',
          FallbackEventAttrs.encodeSync({ serviceName, reason: event.reason }),
          event.at,
        )
        break
      }
      case 'BatchFlush': {
        if (rootSpan === undefined) break
        rootSpan.addEvent(
          'batch-flush',
          BatchFlushEventAttrs.encodeSync({
            serviceName,
            issued: event.issued,
            batched: event.batched,
          }),
          event.at,
        )
        break
      }
      case 'UpdateNoop': {
        if (rootSpan === undefined) break
        rootSpan.addEvent(
          'update-noop',
          UpdateNoopEventAttrs.encodeSync({
            serviceName,
            blockId: event.blockId,
            reason: event.reason,
          }),
          event.at,
        )
        break
      }
      case 'CheckpointWritten': {
        if (rootSpan === undefined) break
        rootSpan.addEvent(
          'checkpoint-written',
          CheckpointWrittenEventAttrs.encodeSync({
            serviceName,
            ...(event.bytes === undefined ? {} : { bytes: event.bytes }),
          }),
          event.at,
        )
        break
      }
    }
  }
}
