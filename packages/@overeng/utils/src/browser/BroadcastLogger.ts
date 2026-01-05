/**
 * BroadcastChannel-based logger for bridging logs from SharedWorkers to tabs.
 *
 * SharedWorkers run in a headless context without access to DevTools.
 * This module provides a way to broadcast logs from a SharedWorker to
 * connected tabs where they can be displayed in the console.
 *
 * Architecture:
 * ```
 * ┌──────────────────┐     BroadcastChannel      ┌─────────────┐
 * │  SharedWorker    │ ───────────────────────▶  │   Tab       │
 * │  (source)        │    'effect-debug-logs'    │  (viewer)   │
 * │                  │                           │             │
 * │  Effect.log(...) │                           │  console/UI │
 * └──────────────────┘                           └─────────────┘
 * ```
 *
 * @example
 * ```ts
 * // ═══════════════════════════════════════════════════════════════════════════
 * // SharedWorker side (sync-worker.ts)
 * // ═══════════════════════════════════════════════════════════════════════════
 * import { Effect } from 'effect'
 * import { BroadcastLoggerLive } from '@overeng/utils/browser'
 *
 * const workerProgram = Effect.gen(function* () {
 *   yield* Effect.log('Sync worker initialized')
 *   yield* Effect.logDebug('Connecting to database...')
 *
 *   yield* Effect.gen(function* () {
 *     yield* Effect.log('Syncing records')
 *   }).pipe(Effect.withSpan('sync-operation'))
 *
 *   yield* Effect.logError('Connection failed', { retries: 3 })
 * }).pipe(
 *   // All Effect.log calls broadcast to connected tabs
 *   Effect.provide(BroadcastLoggerLive('sync-worker'))
 * )
 *
 * // ═══════════════════════════════════════════════════════════════════════════
 * // Tab side (main.ts) - Option 1: Effect-native bridge (recommended)
 * // ═══════════════════════════════════════════════════════════════════════════
 * import { Effect } from 'effect'
 * import { makeLogBridgeLive } from '@overeng/utils/browser'
 *
 * const app = Effect.gen(function* () {
 *   yield* Effect.log('App started')
 *   // Worker logs appear through Effect's logger with annotations
 * }).pipe(
 *   Effect.provide(makeLogBridgeLive()),
 *   Effect.scoped,
 * )
 *
 * // ═══════════════════════════════════════════════════════════════════════════
 * // Tab side - Option 2: Stream-based processing
 * // ═══════════════════════════════════════════════════════════════════════════
 * import { Effect, Stream } from 'effect'
 * import { logStream, formatLogEntry } from '@overeng/utils/browser'
 *
 * const logViewer = logStream.pipe(
 *   Stream.filter((entry) => entry.source === 'sync-worker'),
 *   Stream.runForEach((entry) =>
 *     Effect.sync(() => console.log(formatLogEntry(entry)))
 *   ),
 * )
 * ```
 *
 * @module
 */
import {
  Cause,
  Effect,
  FiberId,
  HashMap,
  Layer,
  Logger,
  LogLevel,
  Schema,
  Scope,
  Stream,
} from 'effect'

/** Channel name for broadcasting logs */
export const BROADCAST_CHANNEL_NAME = 'effect-debug-logs'

/** Schema for log entries broadcast over BroadcastChannel */
export class BroadcastLogEntry extends Schema.Class<BroadcastLogEntry>('BroadcastLogEntry')({
  _tag: Schema.Literal('BroadcastLogEntry'),
  timestamp: Schema.Number,
  level: Schema.String,
  message: Schema.Array(Schema.Unknown),
  fiberId: Schema.String,
  spans: Schema.Array(Schema.String),
  annotations: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  cause: Schema.UndefinedOr(Schema.String),
  /** Identifies the source (e.g., SharedWorker name or tab ID) */
  source: Schema.UndefinedOr(Schema.String),
}) {}

const encodeBroadcastLogEntry = Schema.encodeSync(BroadcastLogEntry)
const decodeBroadcastLogEntry = Schema.decodeUnknownOption(BroadcastLogEntry)

/**
 * Creates a Logger that broadcasts log entries over a BroadcastChannel.
 *
 * Use this in a SharedWorker to send logs to connected tabs.
 */
export const makeBroadcastLogger = (source?: string) => {
  const channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME)

  return Logger.make<unknown, void>(
    ({ annotations, cause, date, fiberId, logLevel, message, spans }) => {
      const entry = new BroadcastLogEntry({
        _tag: 'BroadcastLogEntry',
        timestamp: date.getTime(),
        level: logLevel.label,
        message: Array.isArray(message) ? message : [message],
        fiberId: FiberId.threadName(fiberId),
        spans: [...spans].map((span) => span.label),
        annotations: Object.fromEntries(HashMap.toEntries(annotations)),
        cause: Cause.isEmpty(cause) ? undefined : Cause.pretty(cause),
        source,
      })

      // BroadcastChannel.postMessage doesn't need targetOrigin (unlike window.postMessage)
      // oxlint-disable-next-line eslint-plugin-unicorn(require-post-message-target-origin)
      channel.postMessage(encodeBroadcastLogEntry(entry))
    },
  )
}

/**
 * Layer that replaces the default logger with a broadcast logger.
 *
 * @param source - Optional identifier for the log source (e.g., worker name)
 */
export const BroadcastLoggerLive = (source?: string) =>
  Logger.replace(Logger.defaultLogger, makeBroadcastLogger(source))

/**
 * Stream of broadcast log entries from all sources.
 *
 * Use this in a tab/window to receive logs from SharedWorkers.
 *
 * @example
 * ```ts
 * // Filter and process logs
 * yield* logStream.pipe(
 *   Stream.filter((entry) => entry.level === 'ERROR'),
 *   Stream.runForEach((entry) =>
 *     Effect.log('Worker error', { source: entry.source, message: entry.message })
 *   ),
 * )
 *
 * // Or filter by source
 * yield* logStream.pipe(
 *   Stream.filter((entry) => entry.source === 'my-worker'),
 *   Stream.runForEach((entry) => Effect.sync(() => console.log(formatLogEntry(entry)))),
 * )
 * ```
 */
export const logStream: Stream.Stream<BroadcastLogEntry, never, Scope.Scope> =
  Stream.asyncScoped<BroadcastLogEntry>((emit) =>
    Effect.gen(function* () {
      const channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME)
      const scope = yield* Effect.scope

      const handler = (event: MessageEvent<unknown>) => {
        const decoded = decodeBroadcastLogEntry(event.data)
        if (decoded._tag === 'Some') {
          emit.single(decoded.value)
        }
      }

      channel.addEventListener('message', handler)

      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          channel.removeEventListener('message', handler)
          channel.close()
        }),
      )
    }),
  )

/** Options for creating a log bridge layer. */
export interface LogBridgeOptions {
  /** Only bridge logs from these sources. If empty/undefined, bridges all sources. */
  readonly sources?: readonly string[]
}

/**
 * Creates a Layer that bridges broadcast logs to Effect's logger.
 *
 * Listens for broadcast log entries and re-emits them through Effect.log
 * with appropriate log level, preserving source information as annotations.
 *
 * @example
 * ```ts
 * // Bridge all worker logs
 * const program = myApp.pipe(
 *   Effect.provide(makeLogBridgeLive()),
 *   Effect.scoped,
 * )
 *
 * // Bridge only specific workers
 * const program = myApp.pipe(
 *   Effect.provide(makeLogBridgeLive({ sources: ['sync-worker', 'db-worker'] })),
 *   Effect.scoped,
 * )
 * ```
 *
 * Example log output (with default Effect logger):
 * ```
 * timestamp=2024-01-15T10:30:45.123Z level=INFO fiber=#0 message="Sync worker initialized" broadcastSource=sync-worker broadcastFiberId=#5
 * timestamp=2024-01-15T10:30:45.456Z level=DEBUG fiber=#0 message="Connecting to database..." broadcastSource=sync-worker broadcastFiberId=#5
 * timestamp=2024-01-15T10:30:45.789Z level=INFO fiber=#0 message="Syncing records" broadcastSource=sync-worker broadcastFiberId=#5 broadcastSpans="sync-operation"
 * ```
 */
export const makeLogBridgeLive = (
  options?: LogBridgeOptions,
): Layer.Layer<never, never, Scope.Scope> =>
  Layer.scopedDiscard(
    logStream.pipe(
      Stream.filter((entry) => {
        if (options?.sources && options.sources.length > 0) {
          return entry.source !== undefined && options.sources.includes(entry.source)
        }
        return true
      }),
      Stream.runForEach((entry) => {
        const msg = entry.message.join(' ')

        return Effect.logWithLevel(
          entry.level === 'FATAL'
            ? LogLevel.Fatal
            : entry.level === 'ERROR'
              ? LogLevel.Error
              : entry.level === 'WARNING'
                ? LogLevel.Warning
                : entry.level === 'DEBUG'
                  ? LogLevel.Debug
                  : entry.level === 'TRACE'
                    ? LogLevel.Trace
                    : LogLevel.Info,
          msg,
        ).pipe(
          Effect.annotateLogs({
            broadcastSource: entry.source ?? 'unknown',
            broadcastFiberId: entry.fiberId,
            ...(entry.spans.length > 0 ? { broadcastSpans: entry.spans.join(' > ') } : {}),
            ...entry.annotations,
            ...(entry.cause ? { broadcastCause: entry.cause } : {}),
          }),
        )
      }),
    ),
  )

/**
 * Formats a log entry for display.
 *
 * @example
 * ```ts
 * const formatted = formatLogEntry(entry)
 * // "[my-worker] 14:23:45.123 INFO (fiber-0) my-span: Hello world"
 * ```
 */
export const formatLogEntry = (entry: BroadcastLogEntry): string => {
  const date = new Date(entry.timestamp)
  const time = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}.${date.getMilliseconds().toString().padStart(3, '0')}`

  const source = entry.source ? `[${entry.source}] ` : ''
  const spans = entry.spans.length > 0 ? ` ${entry.spans.join(' > ')}:` : ''
  const msg = entry.message.join(' ')

  return `${source}${time} ${entry.level} (${entry.fiberId})${spans} ${msg}`
}
