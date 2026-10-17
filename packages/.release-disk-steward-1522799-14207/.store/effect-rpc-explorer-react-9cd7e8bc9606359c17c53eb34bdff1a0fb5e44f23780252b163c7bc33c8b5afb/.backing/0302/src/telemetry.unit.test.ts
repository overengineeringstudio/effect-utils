import { Effect, Metric, Tracer } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  type ExplorerNormalizationHistogramMeasurement,
  type ExplorerNormalizationHistogramRegistration,
  type ExplorerRetainedCounts,
  type ExplorerRetainedGaugeRegistration,
  type ExplorerTelemetry,
  ExplorerTelemetryRegistrationError,
  makeExplorerTelemetry,
} from './telemetry.ts'

const isolatedMetrics = <TValue, TError>(effect: Effect.Effect<TValue, TError, never>) =>
  Effect.provideService(effect, Metric.MetricRegistry, new Map())

const unsafeTelemetry = (telemetry: ExplorerTelemetry) =>
  telemetry as unknown as {
    readonly event: (input: unknown) => Effect.Effect<void>
    readonly drop: (input: unknown) => Effect.Effect<void>
    readonly activeDelta: (input: unknown) => Effect.Effect<void>
    readonly normalizationDuration: (input: unknown) => Effect.Effect<void>
    readonly subscriberReset: (input: unknown) => Effect.Effect<void>
    readonly invariantFault: (input: unknown) => Effect.Effect<void>
  }

describe('explorer telemetry', () => {
  it('emits four Effect instruments and registers exact host-only instruments', async () => {
    let registration: ExplorerRetainedGaugeRegistration | undefined
    let histogramRegistration: ExplorerNormalizationHistogramRegistration | undefined
    const normalizationMeasurements: Array<ExplorerNormalizationHistogramMeasurement> = []
    let unregistered = false
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        spans.push(span)
        return span
      },
    })

    const snapshots = await Effect.runPromise(
      isolatedMetrics(
        Effect.scoped(
          Effect.gen(function* () {
            const telemetry = yield* makeExplorerTelemetry({
              readRetainedCounts: () => ({ active: 2, completed: 3 }),
              registerRetainedGauge: (candidate) => {
                registration = candidate
                return () => {
                  unregistered = true
                }
              },
              registerNormalizationHistogram: (candidate) => {
                histogramRegistration = candidate
                return (measurement) => {
                  normalizationMeasurements.push(measurement)
                }
              },
            })
            yield* telemetry.event({
              eventKind: 'RequestObserved',
              observerSide: 'server',
              direction: 'clientToServer',
            })
            yield* telemetry.drop({ reason: 'policyOmitted', captureChannel: 'headers' })
            yield* telemetry.activeDelta({
              observerSide: 'client',
              direction: 'serverToClient',
              delta: -1,
            })
            yield* telemetry.normalizationDuration({
              outcome: 'success',
              captureChannel: 'streamElement',
              durationSeconds: 0.025,
            })
            yield* telemetry.subscriberReset({ reason: 'overflow' })
            return yield* Metric.snapshot
          }),
        ).pipe(Effect.provideService(Tracer.Tracer, tracer)),
      ),
    )

    expect(unregistered).toBe(true)
    expect(spans).toEqual([])
    expect(registration?.name).toBe('rpc.explorer.retained')
    expect(registration?.instrument).toBe('observableGauge')
    expect(registration?.observe()).toEqual([
      {
        value: 2,
        attributes: { 'rpc.explorer.record.kind': 'active' },
      },
      {
        value: 3,
        attributes: { 'rpc.explorer.record.kind': 'completed' },
      },
    ])
    expect(histogramRegistration).toEqual({
      name: 'rpc.explorer.normalization.duration',
      instrument: 'histogram',
      unit: 's',
      description: 'Explorer normalization duration in seconds after raw content is discarded.',
      boundaries: [0.00001, 0.00005, 0.0001, 0.0005, 0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
    })
    expect(normalizationMeasurements).toEqual([
      {
        value: 0.025,
        attributes: {
          'rpc.explorer.capture.channel': 'streamElement',
          'rpc.explorer.normalization.outcome': 'success',
        },
      },
    ])

    const emitted = snapshots
      .map((snapshot) => ({
        id: snapshot.id,
        type: snapshot.type,
        attributes: snapshot.attributes,
        state: snapshot.state,
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id))

    expect(emitted).toEqual([
      {
        id: 'rpc.explorer.active',
        type: 'Counter',
        attributes: {
          'rpc.explorer.direction': 'serverToClient',
          'rpc.explorer.observer.side': 'client',
        },
        state: { count: -1, incremental: false },
      },
      {
        id: 'rpc.explorer.dropped',
        type: 'Counter',
        attributes: {
          'rpc.explorer.capture.channel': 'headers',
          'rpc.explorer.drop.reason': 'policyOmitted',
        },
        state: { count: 1, incremental: true },
      },
      {
        id: 'rpc.explorer.events',
        type: 'Counter',
        attributes: {
          'rpc.explorer.direction': 'clientToServer',
          'rpc.explorer.event.kind': 'RequestObserved',
          'rpc.explorer.observer.side': 'server',
        },
        state: { count: 1, incremental: true },
      },
      {
        id: 'rpc.explorer.subscriber.resets',
        type: 'Counter',
        attributes: { 'rpc.explorer.reset.reason': 'overflow' },
        state: { count: 1, incremental: true },
      },
    ])
  })

  it('rejects unknown keys and enum values without leaking attacker-controlled labels', async () => {
    const secret = 'sentinel-secret-label'
    let registration: ExplorerRetainedGaugeRegistration | undefined
    const normalizationMeasurements: Array<ExplorerNormalizationHistogramMeasurement> = []
    const snapshots = await Effect.runPromise(
      isolatedMetrics(
        Effect.scoped(
          Effect.gen(function* () {
            const telemetry = yield* makeExplorerTelemetry({
              readRetainedCounts: () =>
                ({ active: 1, completed: 1, path: secret }) as ExplorerRetainedCounts,
              registerRetainedGauge: (candidate) => {
                registration = candidate
                return () => {}
              },
              registerNormalizationHistogram: () => (measurement) => {
                normalizationMeasurements.push(measurement)
              },
            })
            const unsafe = unsafeTelemetry(telemetry)
            yield* unsafe.event({
              eventKind: 'RequestObserved',
              observerSide: 'client',
              direction: 'clientToServer',
              rpcTag: secret,
            })
            yield* unsafe.drop({ reason: secret, captureChannel: 'headers' })
            yield* unsafe.activeDelta({
              observerSide: 'client',
              direction: secret,
              delta: 1,
            })
            yield* unsafe.normalizationDuration({
              outcome: 'failure',
              captureChannel: secret,
              durationSeconds: 1,
            })
            yield* unsafe.subscriberReset({ reason: secret })
            yield* unsafe.invariantFault({
              faultKind: 'store',
              observerSide: 'server',
              eventKind: 'TerminalObserved',
              errorMessage: secret,
            })
            return yield* Metric.snapshot
          }),
        ),
      ),
    )

    expect(snapshots).toEqual([])
    expect(normalizationMeasurements).toEqual([])
    expect(registration?.observe()).toEqual([])
    expect(JSON.stringify({ snapshots, observations: registration?.observe() })).not.toContain(
      secret,
    )
  })

  it('surfaces host registration failures but keeps recorder defects out of application effects', async () => {
    const secret = 'host-adapter-secret'
    const retainedFailure = await Effect.runPromise(
      Effect.scoped(
        Effect.result(
          makeExplorerTelemetry({
            readRetainedCounts: () => ({ active: 0, completed: 0 }),
            registerRetainedGauge: () => {
              throw new Error(secret)
            },
            registerNormalizationHistogram: () => () => {},
          }),
        ),
      ),
    )
    expect(retainedFailure).toMatchObject({
      _tag: 'Failure',
      failure: new ExplorerTelemetryRegistrationError({ instrument: 'retained' }),
    })

    let unregistered = false
    const histogramFailure = await Effect.runPromise(
      Effect.scoped(
        Effect.result(
          makeExplorerTelemetry({
            readRetainedCounts: () => ({ active: 0, completed: 0 }),
            registerRetainedGauge: () => () => {
              unregistered = true
            },
            registerNormalizationHistogram: () => {
              throw new Error(secret)
            },
          }),
        ),
      ),
    )
    expect(histogramFailure).toMatchObject({
      _tag: 'Failure',
      failure: new ExplorerTelemetryRegistrationError({ instrument: 'normalizationDuration' }),
    })
    expect(unregistered).toBe(true)

    await expect(
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const telemetry = yield* makeExplorerTelemetry({
              readRetainedCounts: () => ({ active: 0, completed: 0 }),
              registerRetainedGauge: () => () => {},
              registerNormalizationHistogram: () => () => {
                throw new Error(secret)
              },
            })
            yield* telemetry.normalizationDuration({
              outcome: 'failure',
              captureChannel: 'defect',
              durationSeconds: 0.1,
            })
          }),
        ),
      ),
    ).resolves.toBeUndefined()
  })

  it('creates only a linked root span for a valid invariant fault', async () => {
    const created: Array<{
      readonly options: Parameters<Tracer.Tracer['span']>[0]
      readonly span: Tracer.NativeSpan
    }> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        created.push({ options, span })
        return span
      },
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const telemetry = yield* makeExplorerTelemetry({
            readRetainedCounts: () => ({ active: 0, completed: 0 }),
            registerRetainedGauge: () => () => {},
            registerNormalizationHistogram: () => () => {},
          })
          yield* telemetry.invariantFault({
            faultKind: 'store',
            observerSide: 'server',
            eventKind: 'TerminalObserved',
            trace: {
              traceId: '0123456789abcdef0123456789abcdef',
              spanId: '0123456789abcdef',
              sampled: false,
            },
          })
        }).pipe(Effect.provideService(Tracer.Tracer, tracer)),
      ),
    )

    expect(created).toHaveLength(1)
    expect(created[0]?.options.root).toBe(true)
    expect(created[0]?.span.name).toBe('rpc.explorer.pipeline.fault')
    expect(Object.fromEntries(created[0]?.span.attributes ?? [])).toEqual({
      'span.label': 'rpc explorer fault',
      'rpc.explorer.fault.kind': 'store',
      'rpc.explorer.observer.side': 'server',
      'rpc.explorer.event.kind': 'TerminalObserved',
    })
    expect(created[0]?.span.links).toEqual([
      {
        attributes: {},
        span: expect.objectContaining({
          _tag: 'ExternalSpan',
          traceId: '0123456789abcdef0123456789abcdef',
          spanId: '0123456789abcdef',
          sampled: false,
        }),
      },
    ])
  })

  it('discards an invalid trace link and swallows tracer defects', async () => {
    const secret = 'not-a-trace-id-secret'
    const created: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options)
        created.push(span)
        return span
      },
    })

    await expect(
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const telemetry = yield* makeExplorerTelemetry({
              readRetainedCounts: () => ({ active: 0, completed: 0 }),
              registerRetainedGauge: () => () => {},
              registerNormalizationHistogram: () => () => {},
            })
            yield* unsafeTelemetry(telemetry).invariantFault({
              faultKind: 'observer',
              observerSide: 'client',
              eventKind: 'ConnectionFault',
              trace: { traceId: secret, spanId: '0123456789abcdef' },
            })
          }).pipe(Effect.provideService(Tracer.Tracer, tracer)),
        ),
      ),
    ).resolves.toBeUndefined()
    expect(created).toHaveLength(1)
    expect(created[0]?.links).toEqual([])
    expect(JSON.stringify(Object.fromEntries(created[0]?.attributes ?? []))).not.toContain(secret)

    const defectiveTracer = Tracer.make({
      span: () => {
        throw new Error(secret)
      },
    })
    await expect(
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const telemetry = yield* makeExplorerTelemetry({
              readRetainedCounts: () => ({ active: 0, completed: 0 }),
              registerRetainedGauge: () => () => {},
              registerNormalizationHistogram: () => () => {},
            })
            yield* telemetry.invariantFault({
              faultKind: 'subscriber',
              observerSide: 'client',
              eventKind: 'LateEvent',
            })
          }).pipe(Effect.provideService(Tracer.Tracer, defectiveTracer)),
        ),
      ),
    ).resolves.toBeUndefined()
  })
})
