/**
 * In-memory tail of finished spans plus live page vitals, for in-app perf panels. It records every
 * span, sampled or not (sampling only gates export). Pushes are O(1) into a fixed circular buffer;
 * the ordered snapshot is materialized lazily on read and stays identity-stable until the next
 * change (`useSyncExternalStore`-ready). Listeners are notified at most once per `notifyEveryMs`
 * so a panel never competes with the interactions it measures.
 */
import { Effect, Queue, Stream } from 'effect'

/** Finished span retained for an in-app performance panel. */
export interface RingSpan {
  readonly name: string
  readonly label: string
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId: string | undefined
  /** ms since `performance.timeOrigin`. */
  readonly startMs: number
  readonly durationMs: number
  readonly status: 'ok' | 'error' | 'interrupted'
  readonly sampled: boolean
  readonly attributes: Readonly<Record<string, unknown>>
}

/** Current page-level responsiveness and rendering measurements. */
export interface Vitals {
  /** Interaction to Next Paint so far (p98 of interactions, max below 50), ms. */
  readonly inpMs: number | undefined
  readonly lcpMs: number | undefined
  /** Cumulative Layout Shift: largest session window so far. */
  readonly cls: number
  readonly longFrames: number
  readonly longFrameMaxMs: number
}

/** Identity-stable view of retained spans and current vitals. */
export interface RingSnapshot {
  readonly spans: ReadonlyArray<RingSpan>
  readonly vitals: Vitals
}

/** Bounded span storage with throttled subscriptions. */
export interface SpanRing {
  readonly push: (span: RingSpan) => void
  readonly updateVitals: (patch: Partial<Vitals>) => void
  readonly getSnapshot: () => RingSnapshot
  readonly subscribe: (listener: () => void) => () => void
  /** Throttled snapshots as a Stream, for Effect consumers. */
  readonly changes: Stream.Stream<RingSnapshot>
}

/** Storage capacity and notification cadence. */
export interface RingOptions {
  readonly capacity?: number | undefined
  readonly notifyEveryMs?: number | undefined
}

/** Initial vitals before any browser observations arrive. */
export const emptyVitals: Vitals = {
  inpMs: undefined,
  lcpMs: undefined,
  cls: 0,
  longFrames: 0,
  longFrameMaxMs: 0,
}

/** Creates a fixed-capacity ring whose snapshots are materialized on demand. */
export const make = (options?: RingOptions): SpanRing => {
  const capacity = options?.capacity ?? 200
  const notifyEveryMs = options?.notifyEveryMs ?? 250
  const buffer: Array<RingSpan | undefined> = Array.from({ length: capacity })
  let next = 0
  let size = 0
  let vitals = emptyVitals
  let snapshot: RingSnapshot | undefined = { spans: [], vitals }
  const listeners = new Set<() => void>()
  let scheduled = false
  const changed = () => {
    snapshot = undefined
    if (scheduled === true) return
    scheduled = true
    setTimeout(() => {
      scheduled = false
      for (const listener of listeners) listener()
    }, notifyEveryMs)
  }
  const getSnapshot = () => {
    if (snapshot !== undefined) return snapshot
    const start = (next - size + capacity) % capacity
    const spans = Array.from({ length: size }, (_, index) => buffer[(start + index) % capacity]!)
    snapshot = { spans, vitals }
    return snapshot
  }
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  return {
    push: (span) => {
      buffer[next] = span
      next = (next + 1) % capacity
      size = Math.min(size + 1, capacity)
      changed()
    },
    updateVitals: (patch) => {
      vitals = { ...vitals, ...patch }
      changed()
    },
    getSnapshot,
    subscribe,
    changes: Stream.callback<RingSnapshot>(
      (queue) =>
        Effect.acquireRelease(
          Effect.sync(() => subscribe(() => Queue.offerUnsafe(queue, getSnapshot()))),
          (unsubscribe) => Effect.sync(unsubscribe),
        ),
      { bufferSize: 1, strategy: 'sliding' },
    ),
  }
}
