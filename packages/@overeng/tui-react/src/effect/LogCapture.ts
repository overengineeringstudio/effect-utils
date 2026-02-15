/**
 * LogCapture - Automatic log capture for progressive-visual TUI modes.
 *
 * Prevents accidental `console.log`/`Effect.log` calls from corrupting
 * TUI terminal output by capturing them into a SubscriptionRef. Captured
 * logs are accessible to React components via `useCapturedLogs()`.
 *
 * This module is integrated into `outputModeLayer()` for progressive modes
 * (tty, ci, ci-plain, alt-screen). No manual setup required.
 *
 * @example
 * ```tsx
 * import { useCapturedLogs, Static, Text } from '@overeng/tui-react'
 *
 * function MyView() {
 *   const logs = useCapturedLogs()
 *   return (
 *     <>
 *       <Static items={logs}>
 *         {(log) => (
 *           <Text key={log.id} dim>[{log.level}] {log.message}</Text>
 *         )}
 *       </Static>
 *       <Text>Dynamic content here</Text>
 *     </>
 *   )
 * }
 * ```
 *
 * @module
 */

import type { Layer, Scope } from 'effect'
import {
  Effect,
  Fiber,
  FiberId,
  Inspectable,
  Logger,
  Runtime,
  Stream,
  SubscriptionRef,
} from 'effect'
import React, { createContext, type ReactNode } from 'react'

import { useContext, useSyncExternalStore } from './hooks.tsx'
import type { TuiLogEntry } from './TuiLogger.ts'

// =============================================================================
// Types
// =============================================================================

/**
 * Handle to captured log entries.
 * Threaded through OutputMode and React context.
 */
export interface LogCaptureHandle {
  readonly logsRef: SubscriptionRef.SubscriptionRef<readonly TuiLogEntry[]>
}

/**
 * Result of creating log capture.
 */
export interface LogCaptureResult {
  /** Handle containing the logsRef */
  readonly handle: LogCaptureHandle
  /** Layer that replaces the default Effect logger with the capturing logger */
  readonly loggerLayer: Layer.Layer<never>
}

// =============================================================================
// React Context & Hook
// =============================================================================

const CapturedLogsContext = createContext<LogCaptureHandle | null>(null)

/**
 * Provider for captured logs. Used internally by TuiApp.
 */
export const CapturedLogsProvider: React.FC<{
  handle: LogCaptureHandle
  children: ReactNode
}> = ({ handle, children }) =>
  React.createElement(CapturedLogsContext.Provider, { value: handle }, children)

const emptyLogs: readonly TuiLogEntry[] = []

// Stable references for the empty (no-capture) case, hoisted to avoid
// recreating on every render.
const getSnapshotEmpty = (): readonly TuiLogEntry[] => emptyLogs
const subscribeEmpty =
  (_onStoreChange: () => void): (() => void) =>
  () => {}

/**
 * Hook to access captured log entries from a TUI component.
 *
 * Returns an empty array if no log capture is active (e.g., in JSON modes
 * or when running without the automatic capture layer).
 *
 * Uses `useSyncExternalStore` for proper React 18+ concurrent mode support.
 *
 * @example
 * ```tsx
 * function LogPanel() {
 *   const logs = useCapturedLogs()
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
export const useCapturedLogs = (): readonly TuiLogEntry[] => {
  const handle = useContext(CapturedLogsContext)

  const getSnapshotActive = (): readonly TuiLogEntry[] => {
    if (handle === null) return emptyLogs
    let value: readonly TuiLogEntry[] = emptyLogs
    Effect.runSync(
      SubscriptionRef.get(handle.logsRef).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            value = v
          }),
        ),
      ),
    )
    return value
  }

  const subscribeActive = (onStoreChange: () => void): (() => void) => {
    if (handle === null) return () => {}
    const fiber = Effect.runFork(
      handle.logsRef.changes.pipe(Stream.runForEach(() => Effect.sync(() => onStoreChange()))),
    )
    return () => {
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }

  return useSyncExternalStore(
    handle !== null ? subscribeActive : subscribeEmpty,
    handle !== null ? getSnapshotActive : getSnapshotEmpty,
    handle !== null ? getSnapshotActive : getSnapshotEmpty,
  )
}

// =============================================================================
// Implementation
// =============================================================================

let logCaptureEntryId = 0

/**
 * Create log capture as a scoped Effect.
 *
 * - Replaces the Effect default logger with one that captures to a SubscriptionRef
 * - Overrides console.log/error/warn/info/debug to capture to the same ref
 * - Restores console methods on scope finalization
 *
 * **Assumes a single active capture per process.** Overlapping or nested
 * captures are not supported — the first scope to close will restore the
 * original console methods, which may break a still-active capture.
 *
 * @param options.maxEntries - Maximum log entries to keep (default: 500)
 * @returns Scoped effect yielding LogCaptureResult
 */
export const createLogCapture = (options?: {
  maxEntries?: number
}): Effect.Effect<LogCaptureResult, never, Scope.Scope> =>
  Effect.gen(function* () {
    const maxEntries = options?.maxEntries ?? 500

    // Create the SubscriptionRef for log entries
    const logsRef = yield* SubscriptionRef.make<readonly TuiLogEntry[]>([])

    const runtime = yield* Effect.runtime<never>()

    // Helper to append a log entry (fire and forget)
    const appendLog = (entry: TuiLogEntry) =>
      SubscriptionRef.update(logsRef, (logs) => {
        const newLogs = [...logs, entry]
        return newLogs.length > maxEntries ? newLogs.slice(-maxEntries) : newLogs
      })

    const appendLogSync = (entry: TuiLogEntry): void => {
      Runtime.runFork(runtime)(appendLog(entry))
    }

    // Create Effect Logger that captures instead of printing
    const capturingLogger = Logger.make<unknown, void>(
      ({ logLevel, message, date, fiberId, annotations, spans }) => {
        const spanLabel = spans._tag === 'Cons' ? spans.head.label : undefined
        const entry: TuiLogEntry = {
          id: ++logCaptureEntryId,
          level: logLevel.label,
          message: String(message),
          timestamp: date,
          fiberId: FiberId.threadName(fiberId),
          annotations: Object.fromEntries(annotations),
          ...(spanLabel !== undefined ? { span: spanLabel } : {}),
        }
        appendLogSync(entry)
      },
    )

    const loggerLayer = Logger.replace(Logger.defaultLogger, capturingLogger)

    // Override console methods
    const originalLog = console.log
    const originalError = console.error
    const originalWarn = console.warn
    const originalInfo = console.info
    const originalDebug = console.debug

    const makeCapture =
      (level: string) =>
      (...args: unknown[]): void => {
        const entry: TuiLogEntry = {
          id: ++logCaptureEntryId,
          level,
          message: args.map((a) => Inspectable.toStringUnknown(a)).join(' '),
          timestamp: new Date(),
          fiberId: 'console',
          annotations: {},
        }
        appendLogSync(entry)
      }

    console.log = makeCapture('INFO')
    console.error = makeCapture('ERROR')
    console.warn = makeCapture('WARNING')
    console.info = makeCapture('INFO')
    console.debug = makeCapture('DEBUG')

    // Restore console methods on scope finalization
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        console.log = originalLog
        console.error = originalError
        console.warn = originalWarn
        console.info = originalInfo
        console.debug = originalDebug
      }),
    )

    return {
      handle: { logsRef },
      loggerLayer,
    }
  })
