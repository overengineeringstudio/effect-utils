import type { Sample, SeriesView } from './index.ts'

/** Internal streaming reduction shared by pure buckets and canvas bins. No bin arrays. */
export const scanBins = <TValue>(options: {
  readonly history: SeriesView<TValue>
  readonly endMs: number
  readonly spanMs: number
  readonly bins: number
  readonly mode: 'Gauge' | 'Event' | 'Counter'
  readonly value: (value: TValue) => number
  readonly saturate: boolean
  readonly visit: (
    bin: number,
    endMs: number,
    sample: Sample<TValue> | undefined,
    aggregate: number,
  ) => void
}): void => {
  const startMs = options.endMs - options.spanMs
  const binMs = options.spanMs / options.bins
  let index = 0
  let previous = options.history.at(0)
  let previousValue: number | undefined
  for (let bin = 0; bin < options.bins; bin++) {
    // Keep multiplication before division: changing this shifts floating boundaries.
    const endMs = startMs + ((bin + 1) * options.spanMs) / options.bins
    let aggregate = 0
    while (index < options.history.length) {
      const sample = options.history.at(index)
      if (sample === undefined || sample.atMs > endMs) break
      previous = sample
      if (sample._tag === 'Value') {
        const value = options.value(sample.value)
        const increment =
          options.mode === 'Counter'
            ? previousValue === undefined
              ? 0
              : Math.max(0, value - previousValue)
            : value
        if (sample.atMs > endMs - binMs) aggregate += increment
        if (options.saturate === true)
          aggregate = Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, aggregate))
        previousValue = value
      } else previousValue = undefined
      index++
    }
    options.visit(bin, endMs, previous, aggregate)
  }
}

/** Session-private publication of lifecycle revisions without manufacturing observations. */
export const publishRevision = Symbol('SeriesStore.publishRevision')
/** Session-owned UI publication, independent of acquisition revisions. */
export const subscribePresentation = Symbol('SeriesStore.subscribePresentation')

/** Deliver every committed-observation notification before surfacing defects. */
export const notifyListeners = (subscribers: ReadonlySet<() => void>): void => {
  let faults: unknown[] | undefined
  for (const notify of subscribers) {
    try {
      notify()
    } catch (cause) {
      ;(faults ??= []).push(cause)
    }
  }
  if (faults !== undefined) throw new AggregateError(faults, 'Series subscriber failed')
}
