import type { HttpClient } from '@effect/platform'
/**
 * Effect-native OTEL adapter layering on the core `onEvent` hook.
 *
 * Primary o11y path for Effect consumers (pixeltrail, forge, ...). Converts
 * {@link SyncEvent}s into Effect tracer spans using the ambient Effect
 * `Tracer` service. Consumers wire any `@effect/opentelemetry` exporter
 * layer at the top of their runtime — this adapter does not depend on
 * `@opentelemetry/*` directly.
 *
 * Design:
 *   - Emitted spans carry an explicit `service.name` attribute (default
 *     `'notion-react'`) so a consumer's Grafana datasource can query
 *     notion-react separately from the caller service, while trace context
 *     propagation still ties the two together.
 *   - A single root span (`notion-react.sync`) per sync invocation, with
 *     child spans per HTTP op (`notion-react.op.<kind>`).
 *   - Span correlation uses `OpIssued.id` as a Map key so out-of-order
 *     terminal events still resolve correctly.
 */
import { Cause, Context, Effect, Exit, Option } from 'effect'
import type { Tracer } from 'effect'
import type { ReactNode } from 'react'

import type { NotionConfig } from '@overeng/notion-effect-client'

import type { NotionCache } from '../cache/types.ts'
import type { NotionSyncError } from '../renderer/errors.ts'
import type { SyncResult } from '../renderer/render-to-notion.ts'
import { SyncEvent, type SyncEventHandler } from '../renderer/sync-events.ts'
import { sync, type ColdBaseline } from '../renderer/sync.ts'
import type { OnUploadIdRejected } from '../renderer/upload-id-retry.ts'

/** Default service name embedded on every emitted span. */
export const DEFAULT_SERVICE_NAME = 'notion-react'

/** Shorten a Notion uuid for span labels: first 8 hex chars. */
const shortId = (id: string): string => id.replaceAll('-', '').slice(0, 8)

/** Milliseconds → nanoseconds (bigint) for Tracer.Span APIs. */
const msToNs = (ms: number): bigint => BigInt(Math.trunc(ms * 1_000_000))

/** Build a successful / failed Exit for Span.end. */
const successExit: Exit.Exit<void, never> = Exit.void
const failureExit: Exit.Exit<void, string> = Exit.fail('notion-react.sync.failed')

/** Config for {@link makeEffectSpanHandler}. */
export interface EffectSpanHandlerConfig {
  /**
   * Service name embedded as a span attribute (`service.name`). Defaults to
   * `'notion-react'`. Override when the caller's dashboards need to
   * differentiate multiple notion-react consumers.
   */
  readonly serviceName?: string
  /** Effect tracer service used to mint spans. */
  readonly tracer: Tracer.Tracer
  /** Optional parent span for the `notion-react.sync` root span. */
  readonly parent?: Tracer.AnySpan
  /** Tracer context; defaults to `Context.empty()`. */
  readonly context?: Context.Context<never>
}

interface OpenSpan {
  readonly span: Tracer.Span
}

/**
 * Build a synchronous `SyncEventHandler` that opens/closes Effect tracer
 * spans in response to sync events. Each op span is correlated via its
 * `OpIssued.id`.
 */
export const makeEffectSpanHandler = (config: EffectSpanHandlerConfig): SyncEventHandler => {
  const serviceName = config.serviceName ?? DEFAULT_SERVICE_NAME
  const tracer = config.tracer
  const parentOption: Option.Option<Tracer.AnySpan> =
    config.parent !== undefined ? Option.some(config.parent) : Option.none()
  const ctx = config.context ?? Context.empty()
  let rootSpan: Tracer.Span | undefined
  const opSpans = new Map<number, OpenSpan>()

  const attrs = (extra: Record<string, unknown>): Record<string, unknown> => ({
    'service.name': serviceName,
    ...extra,
  })

  return (event: SyncEvent): void => {
    switch (event._tag) {
      case 'SyncStart': {
        rootSpan = tracer.span(
          'notion-react.sync',
          parentOption,
          ctx,
          [],
          msToNs(event.at),
          'internal',
        )
        for (const [k, v] of Object.entries(
          attrs({
            'span.label': shortId(event.pageId),
            'notion-react.page_id': event.pageId,
            'notion-react.root_block_count': event.rootBlockCount,
          }),
        )) {
          rootSpan.attribute(k, v)
        }
        break
      }
      case 'SyncEnd': {
        if (rootSpan === undefined) break
        rootSpan.attribute('notion-react.ok', event.ok)
        rootSpan.attribute('notion-react.op_count', event.opCount)
        rootSpan.attribute('notion-react.duration_ms', event.durationMs)
        if (event.fallbackReason !== undefined) {
          rootSpan.attribute('notion-react.fallback_reason', event.fallbackReason)
        }
        rootSpan.end(msToNs(event.at), event.ok ? successExit : failureExit)
        rootSpan = undefined
        // Flush any lingering op spans so none leak on error paths.
        for (const { span } of opSpans.values()) {
          span.end(msToNs(event.at), failureExit)
        }
        opSpans.clear()
        break
      }
      case 'OpIssued': {
        const parent: Option.Option<Tracer.AnySpan> =
          rootSpan !== undefined ? Option.some(rootSpan) : parentOption
        const span = tracer.span(
          `notion-react.op.${event.kind}`,
          parent,
          ctx,
          [],
          msToNs(event.at),
          'internal',
        )
        for (const [k, v] of Object.entries(
          attrs({
            'span.label': event.kind,
            'notion-react.op.id': event.id,
            'notion-react.op.kind': event.kind,
          }),
        )) {
          span.attribute(k, v)
        }
        opSpans.set(event.id, { span })
        break
      }
      case 'OpSucceeded': {
        const open = opSpans.get(event.id)
        if (open === undefined) break
        open.span.attribute('notion-react.op.duration_ms', event.durationMs)
        open.span.attribute('notion-react.op.result_count', event.resultCount)
        if (event.note !== undefined) {
          open.span.attribute('notion-react.op.note', event.note)
        }
        open.span.end(msToNs(event.at), successExit)
        opSpans.delete(event.id)
        break
      }
      case 'OpFailed': {
        const open = opSpans.get(event.id)
        if (open === undefined) break
        open.span.attribute('notion-react.op.duration_ms', event.durationMs)
        open.span.attribute('notion-react.op.error', event.error)
        open.span.end(msToNs(event.at), Exit.fail(event.error))
        opSpans.delete(event.id)
        break
      }
      case 'CacheOutcome': {
        if (rootSpan === undefined) break
        rootSpan.event(
          `cache:${event.kind}`,
          msToNs(event.at),
          attrs({ 'span.label': `cache:${event.kind}` }),
        )
        break
      }
      case 'FallbackTriggered': {
        if (rootSpan === undefined) break
        rootSpan.event(
          'fallback',
          msToNs(event.at),
          attrs({ 'notion-react.fallback_reason': event.reason }),
        )
        break
      }
      case 'BatchFlush': {
        if (rootSpan === undefined) break
        rootSpan.event(
          'batch-flush',
          msToNs(event.at),
          attrs({
            'notion-react.batch.issued': event.issued,
            'notion-react.batch.batched': event.batched,
          }),
        )
        break
      }
      case 'UpdateNoop': {
        if (rootSpan === undefined) break
        rootSpan.event(
          'update-noop',
          msToNs(event.at),
          attrs({
            'notion-react.block_id': event.blockId,
            'notion-react.noop_reason': event.reason,
          }),
        )
        break
      }
      case 'CheckpointWritten': {
        if (rootSpan === undefined) break
        rootSpan.event(
          'checkpoint-written',
          msToNs(event.at),
          attrs(event.bytes !== undefined ? { 'notion-react.checkpoint.bytes': event.bytes } : {}),
        )
        break
      }
    }
  }
}

/**
 * Convenience wrapper: `sync()` wired with the Effect span handler. Picks
 * up the ambient `Tracer.Tracer` service so consumers only need to provide
 * an `@effect/opentelemetry` exporter layer.
 *
 * @example
 * ```ts
 * import { instrumentedSync } from '@overeng/notion-react/o11y/effect'
 *
 * yield* instrumentedSync(<Page />, { pageId, cache, serviceName: 'pixeltrail-sync' })
 * ```
 */
export const instrumentedSync = (
  element: ReactNode,
  opts: {
    readonly pageId: string
    readonly cache: NotionCache
    readonly serviceName?: string
    readonly coldBaseline?: ColdBaseline
    /** Additional handler composed after the OTEL one (for counters / logging). */
    readonly onEvent?: SyncEventHandler
    readonly onUploadIdRejected?: OnUploadIdRejected
  },
): Effect.Effect<SyncResult, NotionSyncError, NotionConfig | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const tracer = yield* Effect.tracer
    const parent = yield* Effect.currentSpan.pipe(Effect.catchAll(() => Effect.succeed(undefined)))
    const otelHandler = makeEffectSpanHandler({
      tracer,
      ...(opts.serviceName !== undefined ? { serviceName: opts.serviceName } : {}),
      ...(parent !== undefined ? { parent } : {}),
    })
    const composed: SyncEventHandler =
      opts.onEvent === undefined
        ? otelHandler
        : (e) => {
            otelHandler(e)
            opts.onEvent!(e)
          }
    return yield* sync(element, {
      pageId: opts.pageId,
      cache: opts.cache,
      onEvent: composed,
      ...(opts.coldBaseline !== undefined ? { coldBaseline: opts.coldBaseline } : {}),
      ...(opts.onUploadIdRejected !== undefined
        ? { onUploadIdRejected: opts.onUploadIdRejected }
        : {}),
    }).pipe(emitSyncEndOnInterrupt({ pageId: opts.pageId, onEvent: composed }))
  })

/**
 * `sync()` only emits a failure `SyncEnd` via `tapError` on typed errors.
 * Interrupts flow as `Cause.Interrupt` and bypass that path, which leaves
 * the `notion-react.sync` root span open (orphaning all
 * `notion-react.op.*` children). This helper observes the exit directly
 * and emits a synthetic `SyncEnd` on interrupt so the span handler closes
 * the root.
 */
export const emitSyncEndOnInterrupt =
  (args: { readonly pageId: string; readonly onEvent: SyncEventHandler }) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const start = Date.now()
    return self.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isSuccess(exit)) return
          if (Cause.isInterruptedOnly(exit.cause) === false) return
          args.onEvent(
            SyncEvent.SyncEnd({
              pageId: args.pageId,
              durationMs: Date.now() - start,
              ok: false,
              opCount: 0,
              at: Date.now(),
            }),
          )
        }),
      ),
    )
  }
