import { notifyListeners, publishRevision, scanBins, subscribePresentation } from './internal.ts'

/** Cadence belongs to acquisition, independently of reader publication. */
export type Cadence =
  | { readonly _tag: 'PerFrame' }
  | { readonly _tag: 'Interval'; readonly everyMs: number }
  | { readonly _tag: 'Event' }
/** Explicit reasons why a measurement is not a value. */
export type UnavailableReason =
  | 'Unsupported'
  | 'NotConfigured'
  | 'NotIsolated'
  | 'PermissionDenied'
  | 'MeasurementFailed'
  | 'NoSamples'
  | 'Hidden'
  | 'HistoryLost'
  | 'CalibrationInvalid'
  | 'Stopped'
  | 'Stale'
  | 'Disconnected'
/** A session-local observation, never a sentinel number. */
export type Sample<TValue> =
  | { readonly _tag: 'Value'; readonly atMs: number; readonly value: TValue }
  | {
      readonly _tag: 'Unavailable'
      readonly atMs: number
      readonly reason: UnavailableReason
      readonly lastKnown?: { readonly atMs: number; readonly value: TValue }
    }
  | {
      readonly _tag: 'Gap'
      readonly atMs: number
      readonly durationMs: number
      readonly reason: 'MissedFrame' | 'Hidden' | 'Overflow'
    }
/** Units supported by ordinary meter presentations. */
export type Unit = 'fps' | 'ms' | 's' | 'bytes' | 'count' | 'count/s' | 'status'
/** A finite scalar observation. */
export interface NumberValue {
  readonly _tag: 'Number'
  readonly value: number
}
/** A host-owned connection or synchronization state. */
export interface StatusValue {
  readonly _tag: 'Status'
  readonly state:
    | 'Connecting'
    | 'Connected'
    | 'Disconnected'
    | 'Reconnecting'
    | 'Syncing'
    | 'Synced'
    | 'Error'
  readonly label: string
}

const binding = Symbol('Series.binding')
const payload = Symbol('Series.payload')
/** Opaque invariant payload identity, minted by makeSeries. */
export interface Series<TValue> {
  readonly id: string
  readonly label: string
  readonly unit: Unit
  readonly capacity: number
  readonly [payload]: (value: TValue) => TValue
  readonly [binding]: (owner: object) => Ring<TValue>
}
/** The actual retained range and cumulative overwrite evidence. */
export interface Retention {
  readonly capacity: number
  readonly length: number
  readonly oldestAtMs: number | undefined
  readonly newestAtMs: number | undefined
  readonly overflowCount: number
  readonly firstRetainedSequence: number
  readonly nextSequence: number
}
/** A synchronous live cursor; not an immutable historical snapshot. */
export interface SeriesView<TValue> extends Retention {
  readonly revision: number
  readonly latest: Sample<TValue> | undefined
  readonly at: (index: number) => Sample<TValue> | undefined
}

/**
 * Chronological buckets ending at endMs. Gauge holds; Event sums; Counter sums
 * positive deltas, resetting after non-values. A partially observed bucket uses
 * its actual observations; missing history and a latest non-value stay undefined.
 * Aggregates saturate at finite extrema. The returned array is allocated per call.
 */
export const bucketSeries = <TValue>(options: {
  readonly history: SeriesView<TValue>
  readonly endMs: number
  readonly bucketMs: number
  readonly buckets: number
  readonly mode: 'Gauge' | 'Event' | 'Counter'
  readonly value: (value: TValue) => number
}): readonly (number | undefined)[] => {
  const spanMs = options.bucketMs * options.buckets
  if (
    Number.isFinite(options.endMs) === false ||
    Number.isFinite(options.bucketMs) === false ||
    options.bucketMs <= 0 ||
    Number.isInteger(options.buckets) === false ||
    options.buckets <= 0 ||
    Number.isFinite(spanMs) === false ||
    Number.isFinite(options.endMs - spanMs) === false ||
    // The shared scan deliberately multiplies before dividing for legacy boundaries.
    Number.isFinite(options.buckets * spanMs) === false
  )
    throw new TypeError(
      'Buckets require a finite derived window, positive duration and positive integer count',
    )
  const result: (number | undefined)[] = []
  scanBins({
    history: options.history,
    endMs: options.endMs,
    spanMs,
    bins: options.buckets,
    mode: options.mode,
    value: options.value,
    saturate: true,
    // oxlint-disable-next-line overeng/named-args -- Streaming visitor avoids allocating one object per bin.
    visit: (_bin, endMs, sample, aggregate) => {
      if (sample?._tag !== 'Value' || sample.atMs > endMs) {
        result.push(undefined)
        return
      }
      const value = options.mode === 'Gauge' ? options.value(sample.value) : aggregate
      result.push(Number.isFinite(value) === true ? value : undefined)
    },
  })
  return result
}
/** An immutable, revision-stable copy materialized only on explicit reads. */
export interface SeriesSnapshot<TValue> extends Retention {
  readonly id: string
  readonly label: string
  readonly unit: Unit
  readonly revision: number
  readonly samples: readonly Sample<TValue>[]
}
/** A source's typed append capability. */
export interface SeriesWriter<TValue> {
  readonly append: (options: { readonly sample: Sample<TValue> }) => void
}
/** Shared non-destructive histories with independent notifications. */
export interface SeriesStore {
  readonly register: <TValue>(options: {
    readonly series: Series<TValue>
    /** Source adapter hook after commit, before shared reader publication. */
    readonly onAppend?: () => void
  }) => SeriesWriter<TValue>
  readonly read: <TValue>(options: { readonly series: Series<TValue> }) => SeriesView<TValue>
  readonly snapshotSeries: <TValue>(options: {
    readonly series: Series<TValue>
  }) => SeriesSnapshot<TValue>
  readonly subscribe: (options: { readonly notify: () => void }) => () => void
  readonly getRevision: () => number
  readonly [publishRevision]: () => void
  readonly [subscribePresentation]: (notify: () => void) => () => void
}
/** Validate repository-local, case-sensitive identifiers. */
export const validateId = (id: string): void => {
  if (id.length === 0 || /[\s\p{Cc}]/u.test(id) === true)
    throw new TypeError(`Invalid meter identifier: ${id}`)
}

class RingView<TValue> implements SeriesView<TValue> {
  readonly at: SeriesView<TValue>['at']
  private readonly ring: Ring<TValue>
  constructor(ring: Ring<TValue>) {
    this.ring = ring
    this.at = ring.at
  }
  get capacity() {
    return this.ring.series.capacity
  }
  get length() {
    return this.ring.length
  }
  get oldestAtMs() {
    return this.ring.at(0)?.atMs
  }
  get newestAtMs() {
    return this.ring.at(this.ring.length - 1)?.atMs
  }
  get overflowCount() {
    return this.ring.overflowCount
  }
  get firstRetainedSequence() {
    return this.ring.nextSequence - this.ring.length
  }
  get nextSequence() {
    return this.ring.nextSequence
  }
  get revision() {
    return this.ring.nextSequence
  }
  get latest() {
    return this.ring.at(this.ring.length - 1)
  }
}

class Ring<TValue> {
  readonly slots: (Sample<TValue> | undefined)[]
  nextSequence = 0
  length = 0
  cached: SeriesSnapshot<TValue> | undefined
  at = (index: number): Sample<TValue> | undefined =>
    Number.isInteger(index) === true && index >= 0 && index < this.length
      ? this.slots[(this.nextSequence - this.length + index) % this.series.capacity]
      : undefined
  readonly series: {
    readonly id: string
    readonly label: string
    readonly unit: Unit
    readonly capacity: number
  }
  constructor(series: Ring<TValue>['series']) {
    this.series = series
    this.slots = Array.from<Sample<TValue> | undefined>({ length: series.capacity })
    this.view = new RingView(this)
  }
  overflowCount = 0
  readonly view: SeriesView<TValue>
  snapshot = (): SeriesSnapshot<TValue> => {
    if (this.cached?.revision === this.nextSequence) return this.cached
    const samples: Sample<TValue>[] = []
    for (let index = 0; index < this.length; index++) {
      const sample = this.at(index)
      if (sample !== undefined) samples.push(sample)
    }
    this.cached = Object.freeze({
      ...this.series,
      ...this.retention(),
      revision: this.nextSequence,
      samples: Object.freeze(samples),
    })
    return this.cached
  }
  retention = (): Retention => ({
    capacity: this.series.capacity,
    length: this.length,
    oldestAtMs: this.at(0)?.atMs,
    newestAtMs: this.at(this.length - 1)?.atMs,
    overflowCount: this.overflowCount,
    firstRetainedSequence: this.nextSequence - this.length,
    nextSequence: this.nextSequence,
  })
}

/** Mint a payload-specific identity without allocating a history or touching the platform. */
export const makeSeries = <TValue>(options: {
  readonly id: string
  readonly label: string
  readonly unit: Unit
  readonly capacity: number
}): Series<TValue> => {
  validateId(options.id)
  if (Number.isInteger(options.capacity) === false || options.capacity <= 0)
    throw new TypeError('Series capacity must be a positive integer')
  const rings = new WeakMap<object, Ring<TValue>>()
  const definition = Object.freeze({ ...options })
  return Object.freeze({
    ...definition,
    [payload]: (value: TValue) => value,
    [binding]: (owner: object) => {
      let ring = rings.get(owner)
      if (ring === undefined) {
        ring = new Ring<TValue>(definition)
        rings.set(owner, ring)
      }
      return ring
    },
  })
}

/** Construct an inert store with constant-time fixed-slot appends. */
export const makeSeriesStore = (options?: {
  /** Session-supplied cadence; installed only while presentation readers subscribe. */
  readonly subscribePublication: (publish: () => void) => () => void
}): SeriesStore => {
  const owner = {}
  const identities = new Map<string, object>()
  const listeners = new Set<() => void>()
  const presentationListeners = new Set<() => void>()
  let stopPublication: (() => void) | undefined
  let revision = 0
  const publish = (): void => {
    revision++
    notifyListeners(listeners)
    if (options === undefined) notifyListeners(presentationListeners)
  }
  const seen = new Set<object>()
  const prepareValue = (value: unknown): void => {
    if (typeof value === 'number' && Number.isFinite(value) === false)
      throw new TypeError('Numeric observations must be finite')
    if (typeof value !== 'object' || value === null || seen.has(value) === true) return
    seen.add(value)
    for (const key in value) {
      if (Object.hasOwn(value, key) === true) prepareValue(Reflect.get(value, key))
    }
    Object.freeze(value)
  }
  const ringFor = <TValue>(series: Series<TValue>): Ring<TValue> => {
    if (identities.get(series.id) !== series)
      throw new TypeError(`Unregistered series: ${series.id}`)
    return series[binding](owner)
  }
  return {
    register: ({ series, onAppend }) => {
      const previous = identities.get(series.id)
      if (previous !== undefined && previous !== series)
        throw new TypeError(`Duplicate series: ${series.id}`)
      identities.set(series.id, series)
      const ring = series[binding](owner)
      return {
        append: ({ sample }) => {
          if (
            Number.isFinite(sample.atMs) === false ||
            sample.atMs < 0 ||
            sample.atMs < (ring.view.newestAtMs ?? 0)
          )
            throw new TypeError('Observation timestamps must be finite and nondecreasing')
          if (
            sample._tag === 'Gap' &&
            (Number.isFinite(sample.durationMs) === false || sample.durationMs < 0)
          )
            throw new TypeError('Gap duration must be finite and nonnegative')
          if (sample._tag === 'Unavailable' && sample.lastKnown !== undefined) {
            if (
              Number.isFinite(sample.lastKnown.atMs) === false ||
              sample.lastKnown.atMs < 0 ||
              sample.lastKnown.atMs > sample.atMs
            )
              throw new TypeError('Last-known timestamp must precede unavailable evidence')
            try {
              prepareValue(sample.lastKnown)
            } finally {
              seen.clear()
            }
          }
          if (sample._tag === 'Value') {
            try {
              prepareValue(sample.value)
            } finally {
              seen.clear()
            }
          }
          ring.slots[ring.nextSequence % series.capacity] = Object.freeze(sample)
          ring.nextSequence++
          if (ring.length === series.capacity) ring.overflowCount++
          else ring.length++
          let faults: unknown[] | undefined
          try {
            onAppend?.()
          } catch (cause) {
            faults = [cause]
          }
          try {
            publish()
          } catch (cause) {
            ;(faults ??= []).push(cause)
          }
          if (faults !== undefined)
            throw new AggregateError(faults, 'Series append notification failed')
        },
      }
    },
    read: ({ series }) => ringFor(series).view,
    snapshotSeries: ({ series }) => ringFor(series).snapshot(),
    subscribe: ({ notify }) => {
      listeners.add(notify)
      return () => {
        listeners.delete(notify)
      }
    },
    getRevision: () => revision,
    [publishRevision]: () => {
      try {
        publish()
      } finally {
        // Lifecycle changes publish immediately; observations wait for session cadence.
        if (options !== undefined) notifyListeners(presentationListeners)
      }
    },
    [subscribePresentation]: (notify) => {
      presentationListeners.add(notify)
      if (stopPublication === undefined)
        stopPublication = options?.subscribePublication(() =>
          notifyListeners(presentationListeners),
        )
      return () => {
        presentationListeners.delete(notify)
        if (presentationListeners.size === 0) {
          stopPublication?.()
          stopPublication = undefined
        }
      }
    },
  }
}
