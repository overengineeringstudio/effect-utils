/**
 * TUI Logger - Bridges Effect logging to TUI Static region
 *
 * Captures Effect.log() calls and makes them available to TUI components
 * for display in the Static region.
 *
 * @example
 * ```typescript
 * import { Effect } from 'effect'
 * import { useTuiLogs, TuiLoggerLayer, Static, Text } from '@overeng/tui-react'
 *
 * function LogView({ logsRef }) {
 *   const logs = useTuiLogs(logsRef)
 *   return (
 *     <Static items={logs}>
 *       {(log, i) => <Text key={i} dim>[{log.level}] {log.message}</Text>}
 *     </Static>
 *   )
 * }
 *
 * const program = Effect.gen(function* () {
 *   const { logsRef, layer } = yield* createTuiLogger({ maxEntries: 100 })
 *   // ... render LogView with logsRef
 *   yield* Effect.log("Starting...")
 *   yield* Effect.logDebug("Debug info")
 * }).pipe(Effect.provide(layer))
 * ```
 *
 * @module
 */

import type { Scope } from 'effect'
import {
  Context,
  Effect,
  FiberId,
  Layer,
  Logger,
  LogLevel,
  Stream,
  SubscriptionRef,
  Fiber,
  Runtime,
} from 'effect'
import { useSyncExternalStore } from 'react'

// =============================================================================
// Types
// =============================================================================

/**
 * A single log entry captured from Effect logging.
 */
export interface TuiLogEntry {
  /** Unique ID for React keys */
  readonly id: number
  /** Log level (DEBUG, INFO, WARNING, ERROR, etc.) */
  readonly level: string
  /** Log message */
  readonly message: string
  /** Timestamp when the log was created */
  readonly timestamp: Date
  /** Fiber ID that created the log */
  readonly fiberId: string
  /** Any annotations attached to the log */
  readonly annotations: Record<string, unknown>
  /** Span information if available */
  readonly span?: string
}

/**
 * Options for creating a TUI logger.
 */
export interface TuiLoggerOptions {
  /**
   * Maximum number of log entries to keep.
   * Older entries are discarded when this limit is reached.
   * @default 100
   */
  maxEntries?: number

  /**
   * Minimum log level to capture.
   * Logs below this level are not captured.
   * @default LogLevel.All
   */
  minLevel?: LogLevel.LogLevel

  /**
   * Whether to also log to console (combine with default logger).
   * @default true
   */
  logToConsole?: boolean
}

/**
 * Result of creating a TUI logger.
 */
export interface TuiLoggerResult {
  /** SubscriptionRef containing the log entries */
  readonly logsRef: SubscriptionRef.SubscriptionRef<readonly TuiLogEntry[]>

  /** Layer to provide that installs the TUI logger */
  readonly layer: Layer.Layer<never>

  /** Clear all log entries */
  readonly clear: Effect.Effect<void>
}

// =============================================================================
// Implementation
// =============================================================================

let logEntryId = 0

/**
 * Create a TUI logger that captures Effect logs to a SubscriptionRef.
 *
 * The logs can be accessed from React components using `useTuiLogs(logsRef)`.
 *
 * @param options - Logger configuration options
 * @returns Effect that yields the logger result with logsRef and layer
 *
 * @example
 * ```typescript
 * const program = Effect.gen(function* () {
 *   const { logsRef, layer } = yield* createTuiLogger({ maxEntries: 50 })
 *
 *   // Create app with logsRef in state
 *   const LoggingApp = createTuiApp({
 *     stateSchema: AppState,
 *     actionSchema: AppAction,
 *     initial: { logsRef, otherState: "..." },
 *     reducer: appReducer,
 *   })
 *
 *   const tui = yield* LoggingApp.run(<LoggingView />)
 *
 *   // These logs will appear in the TUI (with logger layer provided)
 *   yield* Effect.log("Hello!").pipe(Effect.provide(layer))
 *   yield* Effect.logDebug("Debug message").pipe(Effect.provide(layer))
 * })
 * ```
 */
export const createTuiLogger = (
  options: TuiLoggerOptions = {},
): Effect.Effect<TuiLoggerResult, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { maxEntries = 100, minLevel = LogLevel.All, logToConsole = true } = options

    // Create the logs SubscriptionRef
    const logsRef = yield* SubscriptionRef.make<readonly TuiLogEntry[]>([])

    // Helper to append a log entry
    const appendLog = (entry: TuiLogEntry) =>
      SubscriptionRef.update(logsRef, (logs) => {
        const newLogs = [...logs, entry]
        // Trim to maxEntries
        return newLogs.length > maxEntries ? newLogs.slice(-maxEntries) : newLogs
      })

    const runtime = yield* Effect.runtime<never>()

    // Create the TUI logger
    const tuiLogger = Logger.make<unknown, void>(
      ({ logLevel, message, date, fiberId, annotations, spans }) => {
        // Check minimum level
        if (LogLevel.greaterThanEqual(logLevel, minLevel) === true) {
          const spanLabel = spans._tag === 'Cons' ? spans.head.label : undefined
          const entry: TuiLogEntry = {
            id: ++logEntryId,
            level: logLevel.label,
            message: String(message),
            timestamp: date,
            fiberId: FiberId.threadName(fiberId),
            annotations: Object.fromEntries(annotations),
            ...(spanLabel !== undefined ? { span: spanLabel } : {}),
          }

          // Fire and forget - we don't want logging to block
          Runtime.runFork(runtime)(appendLog(entry))
        }
      },
    )

    // Create the layer - either TUI only or combined with console
    const layer =
      logToConsole === true
        ? Layer.merge(
            Logger.replace(Logger.defaultLogger, Logger.zip(Logger.defaultLogger, tuiLogger)),
            Logger.minimumLogLevel(minLevel),
          )
        : Layer.merge(
            Logger.replace(Logger.defaultLogger, tuiLogger),
            Logger.minimumLogLevel(minLevel),
          )

    // Clear function
    const clear = SubscriptionRef.set(logsRef, [])

    return { logsRef, layer, clear }
  })

// =============================================================================
// React Hook
// =============================================================================

/**
 * Subscribe to TUI log entries from a React component.
 *
 * Uses useSyncExternalStore for proper concurrent mode support.
 *
 * @param logsRef - The SubscriptionRef from createTuiLogger
 * @returns Current array of log entries
 *
 * @example
 * ```tsx
 * function LogPanel({ logsRef }) {
 *   const logs = useTuiLogs(logsRef)
 *
 *   return (
 *     <Static items={logs}>
 *       {(log) => (
 *         <Text key={log.id} dim>
 *           [{log.level}] {log.message}
 *         </Text>
 *       )}
 *     </Static>
 *   )
 * }
 * ```
 */
export const useTuiLogs = (
  logsRef: SubscriptionRef.SubscriptionRef<readonly TuiLogEntry[]>,
): readonly TuiLogEntry[] => {
  // Get current value synchronously
  const getSnapshot = (): readonly TuiLogEntry[] => {
    let value: readonly TuiLogEntry[] = []
    Effect.runSync(
      SubscriptionRef.get(logsRef).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            value = v
          }),
        ),
      ),
    )
    return value
  }

  // Subscribe to changes
  const subscribe = (onStoreChange: () => void): (() => void) => {
    const fiber = Effect.runFork(
      logsRef.changes.pipe(
        Stream.runForEach(() =>
          Effect.sync(() => {
            onStoreChange()
          }),
        ),
      ),
    )

    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// =============================================================================
// Service Tag (for dependency injection)
// =============================================================================

/**
 * Service tag for TUI Logger result.
 * Use this when you want to inject the logger via the Effect context.
 */
export class TuiLoggerService extends Context.Tag('TuiLogger')<
  TuiLoggerService,
  TuiLoggerResult
>() {}

/**
 * Create a layer that provides TuiLoggerService.
 *
 * @example
 * ```typescript
 * const program = Effect.gen(function* () {
 *   const { logsRef, clear } = yield* TuiLoggerService
 *   yield* Effect.log("Hello!")
 * }).pipe(Effect.provide(TuiLoggerServiceLayer({ maxEntries: 50 })))
 * ```
 */
export const TuiLoggerServiceLayer = (
  options: TuiLoggerOptions = {},
): Layer.Layer<TuiLoggerService> => Layer.scoped(TuiLoggerService, createTuiLogger(options))

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Format a log entry for display.
 *
 * @param entry - Log entry to format
 * @param options - Formatting options
 * @returns Formatted string
 */
export const formatLogEntry = ({
  entry,
  options = {},
}: {
  entry: TuiLogEntry
  options?: {
    showTimestamp?: boolean
    showLevel?: boolean
    showFiber?: boolean
    timestampFormat?: 'time' | 'datetime' | 'iso'
  }
}): string => {
  const {
    showTimestamp = true,
    showLevel = true,
    showFiber = false,
    timestampFormat = 'time',
  } = options

  const parts: string[] = []

  if (showTimestamp === true) {
    const ts =
      timestampFormat === 'iso'
        ? entry.timestamp.toISOString()
        : timestampFormat === 'datetime'
          ? entry.timestamp.toLocaleString()
          : entry.timestamp.toLocaleTimeString()
    parts.push(`[${ts}]`)
  }

  if (showLevel === true) {
    parts.push(`[${entry.level}]`)
  }

  if (showFiber === true) {
    parts.push(`[${entry.fiberId}]`)
  }

  parts.push(entry.message)

  return parts.join(' ')
}

/**
 * Get log level color for TUI display.
 */
export const getLogLevelColor = (level: string): string | undefined => {
  switch (level.toUpperCase()) {
    case 'DEBUG':
    case 'TRACE':
      return 'gray'
    case 'INFO':
      return 'cyan'
    case 'WARNING':
    case 'WARN':
      return 'yellow'
    case 'ERROR':
      return 'red'
    case 'FATAL':
      return 'magenta'
    default:
      return undefined
  }
}
