/**
 * Generic Progress UI Factory
 *
 * Creates a UI renderer that subscribes to a progress service and displays
 * live updates.
 *
 * @example
 * ```ts
 * const { Progress, ops, layer } = createProgressService<MyResult>('my-op')
 * const ui = createProgressUI(Progress, ops)
 *
 * // In your command:
 * const handle = yield* ui.start({ title: 'My Operation', subtitle: '/path' })
 * // ... run operations with ops.markActive, ops.markSuccess, etc ...
 * yield* ops.complete()
 * yield* ui.finish(handle)
 * ```
 */

import { Effect, Fiber, Stream } from 'effect'

import {
  isTTY,
  write,
  writeLine,
  hideCursor,
  showCursor,
  cursorUp,
  cursorToStart,
  clearToEOL,
  formatElapsed,
  styled,
  symbols,
  spinner,
} from '@overeng/cli-ui'

import type { ProgressState, ProgressItem, ProgressItemStatus } from './service.ts'

// =============================================================================
// Types
// =============================================================================

/** Options for the progress UI */
export type ProgressUIOptions<TData = unknown> = {
  /** Format an item for display (optional, defaults to label + message) */
  formatItem?: (item: ProgressItem<TData>) => {
    label: string
    message?: string | undefined
  }
  /** Whether to show the summary line (default: true) */
  showSummary?: boolean
  /** Spinner interval in ms (default: 80) */
  spinnerInterval?: number
  /** Custom summary formatter */
  formatSummary?: (args: { state: ProgressState<TData>; elapsed: number }) => string
}

/** Header options for starting the UI */
export type ProgressUIHeader = {
  /** Main title (e.g., workspace name) */
  title: string
  /** Subtitle (e.g., root path) */
  subtitle?: string
  /** Mode indicators (e.g., ['dry run', 'frozen']) */
  modes?: string[]
}

/** Handle for controlling the UI */
export type ProgressUIHandle = {
  /** Fiber running the UI update loop */
  fiber: Fiber.RuntimeFiber<void, never>
  /** Stop the spinner */
  stopSpinner: () => void
  /** Mutable render state */
  renderState: {
    frame: number
    renderedLines: number
    lastState: ProgressState<unknown> | null
  }
}

// =============================================================================
// Status Formatting
// =============================================================================

/** Get status icon for an item */
const getStatusIcon = ({
  status,
  frame,
}: {
  status: ProgressItemStatus
  frame: number
}): string => {
  switch (status) {
    case 'pending':
      return styled.dim(symbols.circle)
    case 'active':
      return styled.cyan(spinner(frame))
    case 'success':
      return styled.green(symbols.check)
    case 'error':
      return styled.red(symbols.cross)
    case 'skipped':
      return styled.dim(symbols.separator)
  }
}

/** Format an item line */
const formatItemLine = <TData>({
  item,
  frame,
  formatItem,
}: {
  item: ProgressItem<TData>
  frame: number
  formatItem?: (item: ProgressItem<TData>) => {
    label: string
    message?: string | undefined
  }
}): string => {
  const icon = getStatusIcon({ status: item.status, frame })
  const formatted = formatItem ? formatItem(item) : { label: item.label, message: item.message }

  let label: string
  switch (item.status) {
    case 'pending':
    case 'skipped':
      label = styled.dim(formatted.label)
      break
    default:
      label = formatted.label
  }

  const msg = formatted.message ? styled.dim(` ${formatted.message}`) : ''
  return `${icon} ${label}${msg}`
}

/** Format the summary line */
const formatSummaryLine = <TData>({
  state,
  elapsed,
  customFormat,
}: {
  state: ProgressState<TData>
  elapsed: number
  customFormat?: (args: { state: ProgressState<TData>; elapsed: number }) => string
}): string => {
  if (customFormat) {
    return customFormat({ state, elapsed })
  }

  const counts = { success: 0, error: 0, skipped: 0, pending: 0, active: 0 }
  for (const item of state.items.values()) {
    counts[item.status]++
  }

  const total = state.items.size
  const completed = counts.success + counts.error + counts.skipped

  const parts: string[] = [`${completed}/${total}`]
  if (counts.error > 0) {
    parts.push(styled.red(`${counts.error} error${counts.error > 1 ? 's' : ''}`))
  }
  parts.push(formatElapsed(elapsed))

  return styled.dim(parts.join(' \u00b7 '))
}

// =============================================================================
// Rendering
// =============================================================================

/** Render all items */
const renderItems = <TData>({
  state,
  frame,
  formatItem,
}: {
  state: ProgressState<TData>
  frame: number
  formatItem?: (item: ProgressItem<TData>) => {
    label: string
    message?: string | undefined
  }
}): string[] => {
  const lines: string[] = []
  for (const item of state.items.values()) {
    lines.push(formatItemLine({ item, frame, formatItem }))
  }
  return lines
}

/** Re-render the display */
const rerender = <TData>({
  state,
  renderState,
  options,
}: {
  state: ProgressState<TData>
  renderState: ProgressUIHandle['renderState']
  options: {
    formatItem?: (item: ProgressItem<TData>) => {
      label: string
      message?: string | undefined
    }
    showSummary: boolean
    formatSummary?: (args: { state: ProgressState<TData>; elapsed: number }) => string
  }
}): void => {
  const { formatItem, showSummary, formatSummary } = options

  // Move cursor up
  if (renderState.renderedLines > 0) {
    write(cursorUp(renderState.renderedLines))
  }

  // Re-render lines
  const lines = renderItems({ state, frame: renderState.frame, formatItem })
  for (const line of lines) {
    write(cursorToStart + clearToEOL + line + '\n')
  }

  if (showSummary) {
    const elapsed = Date.now() - state.startTime
    write(
      cursorToStart +
        clearToEOL +
        formatSummaryLine({ state, elapsed, customFormat: formatSummary }) +
        '\n',
    )
    write(cursorToStart + clearToEOL + '\n')
    renderState.renderedLines = lines.length + 2
  } else {
    renderState.renderedLines = lines.length
  }

  renderState.lastState = state as ProgressState<unknown>
}

// =============================================================================
// Factory
// =============================================================================

/** Operations interface (subset of what createProgressService returns) */
type ProgressOps<TData, TProgress> = {
  get: () => Effect.Effect<ProgressState<TData>, never, TProgress>
  changes: () => Effect.Effect<Stream.Stream<ProgressState<TData>>, never, TProgress>
}

/**
 * Create a progress UI for a given progress service.
 *
 * @param ops - The progress service operations
 * @param options - UI options
 */
export const createProgressUI = <TData, TProgress>({
  ops,
  options = {} as ProgressUIOptions<TData>,
}: {
  ops: ProgressOps<TData, TProgress>
  options?: ProgressUIOptions<TData>
}) => {
  const { formatItem, showSummary = true, spinnerInterval = 80, formatSummary } = options

  const renderOptions: {
    formatItem?: (item: ProgressItem<TData>) => {
      label: string
      message?: string | undefined
    }
    showSummary: boolean
    formatSummary?: (args: { state: ProgressState<TData>; elapsed: number }) => string
  } = {
    showSummary,
    ...(formatItem ? { formatItem } : {}),
    ...(formatSummary ? { formatSummary } : {}),
  }

  const start = (header: ProgressUIHeader): Effect.Effect<ProgressUIHandle, never, TProgress> =>
    Effect.gen(function* () {
      // Mutable render state
      const renderState: ProgressUIHandle['renderState'] = {
        frame: 0,
        renderedLines: 0,
        lastState: null,
      }

      // If not TTY, return a no-op handle
      if (!isTTY()) {
        return {
          fiber: yield* Effect.fork(Effect.void),
          stopSpinner: () => {},
          renderState,
        } satisfies ProgressUIHandle
      }

      // Print header
      console.log(styled.bold(header.title))
      if (header.subtitle) {
        console.log(styled.dim(`  ${header.subtitle}`))
      }
      if (header.modes && header.modes.length > 0) {
        console.log(styled.dim(`  mode: ${header.modes.join(', ')}`))
      }
      console.log('')

      // Hide cursor
      write(hideCursor)

      // Get initial state for first render
      const initialState = yield* ops.get()

      // Initial render
      const lines = renderItems({ state: initialState, frame: renderState.frame, formatItem })
      for (const line of lines) {
        writeLine(line)
      }
      if (showSummary) {
        writeLine('') // Summary placeholder
        writeLine('') // Extra spacing
        renderState.renderedLines = lines.length + 2
      } else {
        renderState.renderedLines = lines.length
      }
      renderState.lastState = initialState as ProgressState<unknown>

      // Subscribe to changes and re-render on each update
      const changes = yield* ops.changes()

      const subscriberFiber = yield* changes.pipe(
        Stream.tap((state) =>
          Effect.sync(() => {
            rerender({ state, renderState, options: renderOptions })
          }),
        ),
        Stream.takeUntil((state) => state.isComplete),
        Stream.runDrain,
        Effect.fork,
      )

      // Start spinner interval for animation
      let spinnerHandle: ReturnType<typeof setInterval> | null = null

      spinnerHandle = setInterval(() => {
        renderState.frame++
        if (renderState.lastState) {
          rerender({
            state: renderState.lastState as ProgressState<TData>,
            renderState,
            options: renderOptions,
          })
        }
      }, spinnerInterval)

      const stopSpinner = (): void => {
        if (spinnerHandle) {
          clearInterval(spinnerHandle)
          spinnerHandle = null
        }
      }

      return {
        fiber: subscriberFiber,
        stopSpinner,
        renderState,
      } satisfies ProgressUIHandle
    })

  const finish = (handle: ProgressUIHandle): Effect.Effect<void, never, TProgress> =>
    Effect.gen(function* () {
      // Stop spinner
      handle.stopSpinner()

      // Wait for subscriber
      yield* Fiber.join(handle.fiber)

      if (!isTTY()) return

      // Final render
      const state = yield* ops.get()
      handle.renderState.frame = 0 // Reset frame for static final render
      rerender({ state, renderState: handle.renderState, options: renderOptions })

      // Show cursor
      write(showCursor)
    })

  return {
    start,
    finish,
    isTTY,
  }
}
