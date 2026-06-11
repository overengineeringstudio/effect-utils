import { OtlpSerialization, OtlpTracer } from '@effect/opentelemetry'
import { FetchHttpClient } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { Effect, Layer, type Scope } from 'effect'

import { otlpTracesUrl } from '../node-vitest/Vitest.ts'
import type { OteliteCliError, OteliteDecodeError, OteliteSpawnError } from './errors.ts'
import { Otelite } from './Otelite.ts'
import type { CaptureHandle, CaptureOptions } from './Otelite.ts'
import type { SpanRow } from './schema.ts'
import { expectTrace, type TraceExpect } from './trace-expect.ts'
import { flushCaptureSpans } from './vitest-bridge.ts'

export interface OteliteTestHarnessOptions extends CaptureOptions {
  readonly serviceName: string
  readonly rootSpanName?: string
  readonly rootSpanLabel?: string
  readonly exportInterval?: number
}

export interface OteliteEnvOptions {
  readonly endpointVar?: string
  readonly serviceNameVar?: string
  readonly extra?: Readonly<Record<string, string | undefined>>
}

export interface TraceInspectOptions {
  readonly service?: string
  readonly name?: string
  readonly attrs?: Readonly<Record<string, string>>
}

export interface OteliteTraceOptions {
  readonly inspect?: TraceInspectOptions
  readonly spanLabelPolicy?: 'required' | 'off'
}

export interface OteliteTestHandle {
  readonly capture: CaptureHandle
  readonly inProcessLayer: Layer.Layer<never>
  readonly endpointEnv: Readonly<Record<string, string>>
  readonly flush: Effect.Effect<void>
  readonly inspect: CaptureHandle['inspect']
  readonly inspectTraces: (
    options?: TraceInspectOptions,
  ) => Effect.Effect<
    ReadonlyArray<SpanRow>,
    OteliteSpawnError | OteliteCliError | OteliteDecodeError
  >
  readonly trace: (
    options?: OteliteTraceOptions,
  ) => Effect.Effect<TraceExpect, OteliteSpawnError | OteliteCliError | OteliteDecodeError>
  readonly runInProcess: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly runInProcessTrace: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options?: OteliteTraceOptions,
  ) => Effect.Effect<TraceExpect, E | OteliteSpawnError | OteliteCliError | OteliteDecodeError, R>
  readonly provideInProcess: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly withEnv: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    options?: OteliteEnvOptions,
  ) => Effect.Effect<A, E, R>
  readonly withEnvTrace: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    envOptions?: OteliteEnvOptions,
    traceOptions?: OteliteTraceOptions,
  ) => Effect.Effect<TraceExpect, E | OteliteSpawnError | OteliteCliError | OteliteDecodeError, R>
}

const envSemaphore = Effect.unsafeMakeSemaphore(1)

const scopedEnv = (
  values: Readonly<Record<string, string | undefined>>,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous: Record<string, string | undefined> = {}
      for (const key of Object.keys(values)) {
        previous[key] = process.env[key]
        const value = values[key]
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      return previous
    }),
    (previous) =>
      Effect.sync(() => {
        for (const key of Object.keys(previous)) {
          const value = previous[key]
          if (value === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = value
          }
        }
      }),
  ).pipe(Effect.asVoid)

const makeInProcessLayer = (
  handle: CaptureHandle,
  options: Required<Pick<OteliteTestHarnessOptions, 'serviceName' | 'exportInterval'>>,
): Layer.Layer<never> => {
  return OtlpTracer.layer({
    url: otlpTracesUrl(handle.endpoints.http),
    resource: { serviceName: options.serviceName },
    exportInterval: options.exportInterval,
  }).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(OtlpSerialization.layerJson),
  )
}

const endpointEnvValue = (handle: CaptureHandle, endpointVar?: string): string => {
  if (endpointVar === 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT') {
    return otlpTracesUrl(handle.endpoints.http)
  }
  return handle.endpoints.http
}

export class OteliteTestHarness extends Effect.Service<OteliteTestHarness>()(
  '@overeng/utils-dev/otelite/OteliteTestHarness',
  {
    accessors: true,
    effect: Effect.gen(function* () {
      const otelite = yield* Otelite

      const capture = (
        options: OteliteTestHarnessOptions,
      ): Effect.Effect<
        OteliteTestHandle,
        OteliteSpawnError | OteliteCliError | OteliteDecodeError,
        Scope.Scope
      > =>
        Effect.gen(function* () {
          const exportInterval = options.exportInterval ?? 100
          const rootSpanName = options.rootSpanName ?? `${options.serviceName}.test`
          const rootSpanLabel = options.rootSpanLabel ?? options.serviceName
          const captureHandle = yield* otelite.capture(options)
          const inProcessLayer = makeInProcessLayer(captureHandle, {
            serviceName: options.serviceName,
            exportInterval,
          })
          const endpointEnv = {
            OTEL_EXPORTER_OTLP_ENDPOINT: captureHandle.endpoints.http,
            OTEL_SERVICE_NAME: options.serviceName,
          } as const

          const inspect = captureHandle.inspect

          const inspectTraces = (inspectOptions: TraceInspectOptions = {}) =>
            inspect({ ...inspectOptions, signal: 'traces' })

          const trace = (traceOptions: OteliteTraceOptions = {}) =>
            Effect.gen(function* () {
              const spans = yield* inspectTraces({
                service: options.serviceName,
                ...traceOptions.inspect,
              })
              const traceExpect = expectTrace(spans)
              if ((traceOptions.spanLabelPolicy ?? 'required') === 'required') {
                traceExpect.expectSpanLabels()
              }
              return traceExpect
            })

          const withEnv = <A, E, R>(
            effect: Effect.Effect<A, E, R>,
            envOptions: OteliteEnvOptions = {},
          ): Effect.Effect<A, E, R> =>
            envSemaphore.withPermits(1)(
              Effect.scoped(
                scopedEnv({
                  [envOptions.endpointVar ?? 'OTEL_EXPORTER_OTLP_ENDPOINT']: endpointEnvValue(
                    captureHandle,
                    envOptions.endpointVar,
                  ),
                  [envOptions.serviceNameVar ?? 'OTEL_SERVICE_NAME']: options.serviceName,
                  ...envOptions.extra,
                }).pipe(Effect.zipRight(effect)),
              ),
            )

          const runInProcess = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
            effect.pipe(
              Effect.withSpan(rootSpanName, {
                root: true,
                attributes: { 'span.label': rootSpanLabel },
              }),
              Effect.provide(inProcessLayer),
            )

          const runInProcessTrace = <A, E, R>(
            effect: Effect.Effect<A, E, R>,
            traceOptions?: OteliteTraceOptions,
          ): Effect.Effect<
            TraceExpect,
            E | OteliteSpawnError | OteliteCliError | OteliteDecodeError,
            R
          > =>
            runInProcess(effect).pipe(
              Effect.zipRight(flushCaptureSpans({ exportInterval })),
              Effect.zipRight(trace(traceOptions)),
            )

          const withEnvTrace = <A, E, R>(
            effect: Effect.Effect<A, E, R>,
            envOptions?: OteliteEnvOptions,
            traceOptions?: OteliteTraceOptions,
          ): Effect.Effect<
            TraceExpect,
            E | OteliteSpawnError | OteliteCliError | OteliteDecodeError,
            R
          > =>
            withEnv(effect, envOptions).pipe(
              Effect.zipRight(flushCaptureSpans({ exportInterval })),
              Effect.zipRight(trace(traceOptions)),
            )

          return {
            capture: captureHandle,
            inProcessLayer,
            endpointEnv,
            flush: flushCaptureSpans({ exportInterval }),
            inspect,
            inspectTraces,
            trace,
            runInProcess,
            runInProcessTrace,
            provideInProcess: runInProcess,
            withEnv,
            withEnvTrace,
          } satisfies OteliteTestHandle
        }).pipe(Effect.withSpan('otelite.test-harness.capture'))

      return { capture } as const
    }),
    dependencies: [Otelite.Default.pipe(Layer.provide(NodeContext.layer))],
  },
) {}

export const captureTest = (
  options: OteliteTestHarnessOptions,
): Effect.Effect<
  OteliteTestHandle,
  OteliteSpawnError | OteliteCliError | OteliteDecodeError,
  Scope.Scope
> => OteliteTestHarness.capture(options).pipe(Effect.provide(OteliteTestHarness.Default))

export const captureInProcessTrace = <A, E, R>(
  options: OteliteTestHarnessOptions,
  effect: Effect.Effect<A, E, R>,
  traceOptions?: OteliteTraceOptions,
): Effect.Effect<TraceExpect, E | OteliteSpawnError | OteliteCliError | OteliteDecodeError, R> =>
  Effect.scoped(
    captureTest(options).pipe(
      Effect.flatMap((otel) => otel.runInProcessTrace(effect, traceOptions)),
    ),
  )

export const captureEnvTrace = <A, E, R>(
  options: OteliteTestHarnessOptions,
  effect: Effect.Effect<A, E, R>,
  envOptions?: OteliteEnvOptions,
  traceOptions?: OteliteTraceOptions,
): Effect.Effect<TraceExpect, E | OteliteSpawnError | OteliteCliError | OteliteDecodeError, R> =>
  Effect.scoped(
    captureTest(options).pipe(
      Effect.flatMap((otel) => otel.withEnvTrace(effect, envOptions, traceOptions)),
    ),
  )
