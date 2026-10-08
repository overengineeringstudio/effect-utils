import { Clock, Effect, Queue } from 'effect'

import type { ProtocolSink, RequestIdentity } from '@overeng/effect-rpc-observer'
import { makeSeries, makeSource } from '@overeng/meters'
import type { Sample, Source } from '@overeng/meters'
import { validateId } from '@overeng/meters/series'

/** Explicitly selected RPC lifecycle projections. */
export type RpcMetric = 'requestsPerSecond' | 'inFlight' | 'errorsPerSecond' | 'durationP95'
/** Host-owned bounds for RPC evidence and retained samples. */
export interface RpcMetersConfig {
  readonly id: string
  readonly metrics: readonly RpcMetric[]
  readonly windowMillis: number
  readonly maxCompletions: number
  readonly historyCapacity: number
}
/** One metadata sink and one typed source for each selected projection. */
export interface RpcSource {
  readonly sink: ProtocolSink
  readonly sources: readonly Source<number>[]
}
const identityKey = (identity: RequestIdentity): string =>
  JSON.stringify([
    identity.observerSide,
    identity.connectionId,
    identity.direction,
    identity.requestId._tag,
    identity.requestId.value,
  ])
type Completion = {
  readonly at: number
  readonly duration: number | undefined
  readonly error: boolean
}

const knownMetrics: Record<RpcMetric, true> = {
  requestsPerSecond: true,
  inFlight: true,
  errorsPerSecond: true,
  durationP95: true,
}

/** Acquires a bounded reducer; publication begins only on source acquisition. */
export const makeRpcSource = Effect.fn('RpcDevtools.makeSource')(function* (
  config: RpcMetersConfig,
) {
  yield* Effect.sync(() => validateId(config.id))
  if (
    Number.isFinite(config.windowMillis) === false ||
    config.windowMillis <= 0 ||
    Number.isSafeInteger(config.maxCompletions) === false ||
    config.maxCompletions <= 0 ||
    Number.isSafeInteger(config.historyCapacity) === false ||
    config.historyCapacity <= 0
  )
    return yield* Effect.die(new TypeError('RPC meter bounds must be finite and positive'))
  if (
    config.metrics.some((metric) => Object.hasOwn(knownMetrics, metric) === false) === true ||
    new Set(config.metrics).size !== config.metrics.length
  )
    return yield* Effect.die(new TypeError('RPC metrics must be known and unique'))
  const effectClock = yield* Clock.Clock
  const now = () => Number(effectClock.currentTimeNanosUnsafe()) / 1e6
  const active = new Map<string, boolean>()
  const requests: number[] = []
  const completions: Completion[] = []
  let requestLostUntil = -Infinity
  let errorLostUntil = -Infinity
  let latencyLostUntil = -Infinity
  let loss = 0
  let enabled = true
  let completedCount = 0
  let errorCount = 0
  const listeners = new Set<() => void>()
  const notify = () => {
    for (const listener of listeners) listener()
  }
  const expire = (at: number) => {
    const cutoff = at - config.windowMillis
    while (requests.length > 0 && requests[0]! <= cutoff) requests.shift()
    while (completions.length > 0 && completions[0]!.at <= cutoff) completions.shift()
  }
  const appendRequest = (at: number) => {
    if (requests.length === config.maxCompletions) {
      requestLostUntil = requests.shift()! + config.windowMillis
      loss++
    }
    requests.push(at)
  }
  const sink: ProtocolSink = {
    onRequest: (event) => {
      if (enabled === false || config.metrics.length === 0) return
      const key = identityKey(event.identity)
      if (active.has(key) === true) return
      active.set(key, event.notification)
      const at = Number(event.at.monotonicNanos) / 1e6
      expire(at)
      appendRequest(at)
      notify()
    },
    onChunk: () => {},
    onTerminal: (event) => {
      if (enabled === false) return
      const key = identityKey(event.identity)
      const notification = active.get(key)
      if (notification === undefined) return
      active.delete(key)
      const at = Number(event.at.monotonicNanos) / 1e6
      expire(at)
      if (completions.length === config.maxCompletions) {
        const removed = completions.shift()!
        if (removed.error === true) errorLostUntil = removed.at + config.windowMillis
        if (removed.duration !== undefined) latencyLostUntil = removed.at + config.windowMillis
        loss++
      }
      const error =
        event.outcome === 'typedFailure' ||
        event.outcome === 'defect' ||
        event.outcome === 'transportFailure'
      completedCount++
      if (error === true) errorCount++
      completions.push({
        at,
        error,
        duration:
          event.outcome === 'success' && notification === false ? event.durationSeconds : undefined,
      })
      notify()
    },
    onFault: () => {
      if (enabled === false || config.metrics.length === 0) return
      loss++
      notify()
    },
  }
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      enabled = false
      listeners.clear()
      active.clear()
      requests.length = 0
      completions.length = 0
    }),
  )
  const sample = ({
    metric,
    atMs,
  }: {
    readonly metric: RpcMetric
    readonly atMs: number
  }): Sample<number> => {
    const at = now()
    expire(at)
    if (
      (metric === 'requestsPerSecond' && at < requestLostUntil) ||
      (metric === 'errorsPerSecond' && at < errorLostUntil) ||
      (metric === 'durationP95' && at < latencyLostUntil)
    )
      return { _tag: 'Unavailable', atMs, reason: 'HistoryLost' }
    let value: number
    switch (metric) {
      case 'inFlight':
        value = active.size
        break
      case 'requestsPerSecond':
        value = (requests.length * 1000) / config.windowMillis
        break
      case 'errorsPerSecond':
        value =
          (completions.filter((entry) => entry.error === true).length * 1000) / config.windowMillis
        break
      case 'durationP95': {
        const durations = completions
          .flatMap((entry) => (entry.duration === undefined ? [] : [entry.duration]))
          .toSorted((a, b) => a - b)
        if (durations.length === 0) return { _tag: 'Unavailable', atMs, reason: 'NoSamples' }
        value = durations[Math.ceil(0.95 * durations.length) - 1]!
        break
      }
    }
    return { _tag: 'Value', atMs, value }
  }
  const sources = config.metrics.map((metric) => {
    const id = `${config.id}.${metric}`
    const series = makeSeries<number>({
      id,
      label: metric,
      unit: metric === 'durationP95' ? 's' : metric === 'inFlight' ? 'count' : 'count/s',
      capacity: config.historyCapacity,
    })
    return makeSource({
      id,
      series,
      cadence: { _tag: 'Event' },
      evidence: {
        loss: () => loss,
        counters: () => ({
          [`${config.id}.completions`]: completedCount,
          [`${config.id}.errors`]: errorCount,
        }),
      },
      start: ({ sink: writer, clock }) =>
        Effect.gen(function* () {
          if (metric === 'inFlight') {
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const listener = () =>
                  writer.append({ sample: sample({ metric, atMs: clock.now() }) })
                listeners.add(listener)
                listener()
                return listener
              }),
              (listener) =>
                Effect.sync(() => {
                  listeners.delete(listener)
                }),
            )
            return
          }
          const wake = yield* Queue.dropping<void>(1)
          const publish = () => writer.append({ sample: sample({ metric, atMs: clock.now() }) })
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const listener = () => {
                publish()
                Queue.offerUnsafe(wake, undefined)
              }
              listeners.add(listener)
              publish()
              return listener
            }),
            (listener) =>
              Effect.sync(() => {
                listeners.delete(listener)
              }),
          )
          yield* Effect.gen(function* () {
            while (true) {
              const at = now()
              expire(at)
              const next = Math.min(
                requests[0] ?? Infinity,
                completions[0]?.at ?? Infinity,
                requestLostUntil > at ? requestLostUntil - config.windowMillis : Infinity,
                errorLostUntil > at ? errorLostUntil - config.windowMillis : Infinity,
                latencyLostUntil > at ? latencyLostUntil - config.windowMillis : Infinity,
              )
              if (next === Infinity) yield* Queue.take(wake)
              else {
                const expired = yield* Effect.race(
                  Queue.take(wake).pipe(Effect.as(false)),
                  Effect.sleep(Math.max(1, next + config.windowMillis - at)).pipe(Effect.as(true)),
                )
                if (expired === true) publish()
              }
            }
          }).pipe(Effect.forkScoped)
        }),
    })
  })
  return { sink, sources } satisfies RpcSource
})
