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

import type { SyncEvent, SyncEventHandler } from '../renderer/sync-events.ts'

/** Default service name attribute attached to every emitted span. */
export const DEFAULT_SERVICE_NAME = 'notion-react'

const shortId = (id: string): string => id.replaceAll('-', '').slice(0, 8)

/** Numeric values for `SpanStatusCode` — avoids importing the const enum. */
const STATUS_OK = 1 as SpanStatusCode
const STATUS_ERROR = 2 as SpanStatusCode

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

  const withService = (extra: Attributes): Attributes => ({ 'service.name': serviceName, ...extra })

  return (event: SyncEvent): void => {
    switch (event._tag) {
      case 'SyncStart': {
        rootSpan = tracer.startSpan('notion-react.sync', {
          startTime: event.at,
          attributes: withService({
            'span.label': shortId(event.pageId),
            'notion-react.page_id': event.pageId,
            'notion-react.root_block_count': event.rootBlockCount,
          }),
        })
        break
      }
      case 'SyncEnd': {
        if (rootSpan === undefined) break
        rootSpan.setAttributes({
          'notion-react.ok': event.ok,
          'notion-react.op_count': event.opCount,
          'notion-react.duration_ms': event.durationMs,
          ...(event.fallbackReason !== undefined
            ? { 'notion-react.fallback_reason': event.fallbackReason }
            : {}),
        })
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
            attributes: withService({
              'span.label': event.kind,
              'notion-react.op.id': event.id,
              'notion-react.op.kind': event.kind,
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
        span.setAttributes({
          'notion-react.op.duration_ms': event.durationMs,
          'notion-react.op.result_count': event.resultCount,
          ...(event.note !== undefined ? { 'notion-react.op.note': event.note } : {}),
        })
        span.setStatus({ code: STATUS_OK })
        span.end(event.at)
        opSpans.delete(event.id)
        break
      }
      case 'OpFailed': {
        const span = opSpans.get(event.id)
        if (span === undefined) break
        span.setAttributes({
          'notion-react.op.duration_ms': event.durationMs,
          'notion-react.op.error': event.error,
        })
        span.setStatus({ code: STATUS_ERROR, message: event.error })
        span.end(event.at)
        opSpans.delete(event.id)
        break
      }
      case 'CacheOutcome': {
        if (rootSpan === undefined) break
        rootSpan.addEvent(
          `cache:${event.kind}`,
          withService({ 'span.label': `cache:${event.kind}` }),
          event.at,
        )
        break
      }
      case 'FallbackTriggered': {
        if (rootSpan === undefined) break
        rootSpan.addEvent(
          'fallback',
          withService({ 'notion-react.fallback_reason': event.reason }),
          event.at,
        )
        break
      }
      case 'BatchFlush': {
        if (rootSpan === undefined) break
        rootSpan.addEvent(
          'batch-flush',
          withService({
            'notion-react.batch.issued': event.issued,
            'notion-react.batch.batched': event.batched,
          }),
          event.at,
        )
        break
      }
      case 'UpdateNoop': {
        if (rootSpan === undefined) break
        rootSpan.addEvent(
          'update-noop',
          withService({
            'notion-react.block_id': event.blockId,
            'notion-react.noop_reason': event.reason,
          }),
          event.at,
        )
        break
      }
      case 'CheckpointWritten': {
        if (rootSpan === undefined) break
        rootSpan.addEvent(
          'checkpoint-written',
          withService(
            event.bytes !== undefined ? { 'notion-react.checkpoint.bytes': event.bytes } : {},
          ),
          event.at,
        )
        break
      }
    }
  }
}
