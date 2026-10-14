import { Effect } from 'effect'

import { validateId, type NumberValue, type Series } from '../series/index.ts'
import {
  instrumentIdentities,
  makeSource,
  type Source,
  type SourceEvidence,
} from '../session/source.ts'

const counterIdentity = Symbol('CounterToken')
const gaugeIdentity = Symbol('GaugeToken')
const registry = Symbol('Instrumentation.registry')
/** Opaque identity for a monotonic counter, distinct from a gauge. */
export interface CounterToken {
  readonly id: string
  readonly [counterIdentity]: true
}
/** Opaque identity for a finite current value. */
export interface GaugeToken {
  readonly id: string
  readonly [gaugeIdentity]: true
}
/** Monotonic non-destructive cumulative instrumentation. */
export interface Counter {
  readonly add: (options: { readonly by: number }) => void
  readonly read: () => number
}
/** Current-value instrumentation; decreases never masquerade as counters. */
export interface Gauge {
  readonly set: (options: { readonly value: number }) => void
  readonly read: () => number
}
interface Entry {
  value: number
  readonly listeners: Set<() => void>
}
/** Host-injected, explicitly declared instruments with no global transport. */
export interface Instrumentation {
  readonly counter: (options: { readonly token: CounterToken }) => Counter
  readonly gauge: (options: { readonly token: GaugeToken }) => Gauge
  readonly [registry]: {
    readonly counters: () => Readonly<Record<string, number>>
    readonly identities: readonly { readonly id: string; readonly identity: object }[]
    readonly subscribe: (options: {
      readonly token: CounterToken | GaugeToken
      readonly notify: () => void
    }) => () => void
  }
}
/** Declare a counter identity without registering resources. */
export const counterToken = (options: { readonly id: string }): CounterToken => {
  validateId(options.id)
  const token: CounterToken = { id: options.id, [counterIdentity]: true }
  return Object.freeze(token)
}
/** Declare a gauge identity without registering resources. */
export const gaugeToken = (options: { readonly id: string }): GaugeToken => {
  validateId(options.id)
  const token: GaugeToken = { id: options.id, [gaugeIdentity]: true }
  return Object.freeze(token)
}
const notify = (entry: Entry): void => {
  let faults: unknown[] | undefined
  for (const listener of entry.listeners) {
    try {
      listener()
    } catch (cause) {
      ;(faults ??= []).push(cause)
    }
  }
  if (faults !== undefined) throw new AggregateError(faults, 'Instrument subscriber failed')
}

/** Create an inert explicit registry; every declared instrument starts at real zero. */
export const makeInstrumentation = (options: {
  readonly counters: readonly CounterToken[]
  readonly gauges: readonly GaugeToken[]
}): Instrumentation => {
  const ids = new Set<string>()
  const counters = new Map<CounterToken, Entry>()
  const gauges = new Map<GaugeToken, Entry>()
  for (const token of options.counters) {
    if (ids.has(token.id) === true) throw new TypeError(`Duplicate instrument: ${token.id}`)
    ids.add(token.id)
    counters.set(token, { value: 0, listeners: new Set() })
  }
  for (const token of options.gauges) {
    if (ids.has(token.id) === true) throw new TypeError(`Duplicate instrument: ${token.id}`)
    ids.add(token.id)
    gauges.set(token, { value: 0, listeners: new Set() })
  }
  return {
    counter: ({ token }) => {
      const entry = counters.get(token)
      if (entry === undefined) throw new TypeError(`Undeclared counter: ${token.id}`)
      return {
        read: () => entry.value,
        add: ({ by }) => {
          if (
            Number.isFinite(by) === false ||
            by < 0 ||
            Number.isFinite(entry.value + by) === false
          )
            throw new TypeError('Counter increments must be finite and nonnegative')
          entry.value += by
          notify(entry)
        },
      }
    },
    gauge: ({ token }) => {
      const entry = gauges.get(token)
      if (entry === undefined) throw new TypeError(`Undeclared gauge: ${token.id}`)
      return {
        read: () => entry.value,
        set: ({ value }) => {
          if (Number.isFinite(value) === false) throw new TypeError('Gauge values must be finite')
          entry.value = value
          notify(entry)
        },
      }
    },
    [registry]: {
      identities: Object.freeze([
        ...Array.from(counters, ([token, entry]) =>
          Object.freeze({ id: token.id, identity: entry }),
        ),
        ...Array.from(gauges, ([token, entry]) => Object.freeze({ id: token.id, identity: entry })),
      ]),
      counters: () =>
        Object.freeze(
          Object.fromEntries(Array.from(counters, ([token, entry]) => [token.id, entry.value])),
        ),
      subscribe: ({ token, notify: listener }) => {
        const entry = counterIdentity in token ? counters.get(token) : gauges.get(token)
        if (entry === undefined) throw new TypeError(`Undeclared instrument: ${token.id}`)
        entry.listeners.add(listener)
        return () => {
          entry.listeners.delete(listener)
        }
      },
    },
  }
}

/** Bind a composed event source to the same cumulative registry and instrument identities. */
export const instrumentationEvidence = (options: {
  readonly instrumentation: Instrumentation
}): SourceEvidence => ({
  counters: options.instrumentation[registry].counters,
  [instrumentIdentities]: options.instrumentation[registry].identities,
})

/** Event acquisition binds the same cumulative registry used by headless brackets. */
export const counterSource = (options: {
  readonly id: string
  readonly series: Series<NumberValue>
  readonly instrumentation: Instrumentation
  readonly token: CounterToken
}): Source<NumberValue> =>
  makeSource({
    id: options.id,
    series: options.series,
    cadence: { _tag: 'Event' },
    evidence: instrumentationEvidence({ instrumentation: options.instrumentation }),
    start: ({ sink, clock }) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const counter = options.instrumentation.counter({ token: options.token })
          const emit = (): void =>
            sink.append({
              sample: {
                _tag: 'Value',
                atMs: clock.now(),
                value: { _tag: 'Number', value: counter.read() },
              },
            })
          emit()
          return options.instrumentation[registry].subscribe({ token: options.token, notify: emit })
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      ).pipe(Effect.asVoid),
  })
/** Event acquisition observes gauge changes without including them in counter deltas. */
export const gaugeSource = (options: {
  readonly id: string
  readonly series: Series<NumberValue>
  readonly instrumentation: Instrumentation
  readonly token: GaugeToken
}): Source<NumberValue> =>
  makeSource({
    id: options.id,
    series: options.series,
    cadence: { _tag: 'Event' },
    evidence: { [instrumentIdentities]: options.instrumentation[registry].identities },
    start: ({ sink, clock }) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const gauge = options.instrumentation.gauge({ token: options.token })
          const emit = (): void =>
            sink.append({
              sample: {
                _tag: 'Value',
                atMs: clock.now(),
                value: { _tag: 'Number', value: gauge.read() },
              },
            })
          emit()
          return options.instrumentation[registry].subscribe({ token: options.token, notify: emit })
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      ).pipe(Effect.asVoid),
  })
