/**
 * Enhanced Vitest utilities for Effect-based testing.
 *
 * Provides:
 * - `makeWithTestCtx` / `withTestCtx` - wraps effects with OTEL, layers, timeouts, logging
 * - `asProp` - enhanced property-based testing with shrinking visibility
 * - `DEBUGGER_ACTIVE` / `IS_CI` - environment detection
 *
 * @module
 */

import * as inspector from 'node:inspector'

import { OtlpSerialization, OtlpTracer } from '@effect/opentelemetry'
import { FetchHttpClient } from '@effect/platform'
import type * as Vitest from '@effect/vitest'
import type { Duration } from 'effect'
import {
  type Cause,
  Effect,
  type FastCheck as FC,
  identity,
  Layer,
  Predicate,
  type Schema,
  type Scope,
} from 'effect'

// oxlint-disable-next-line oxc(no-barrel-file) -- intentionally re-exports @effect/vitest for unified API
export * from '@effect/vitest'

// ============================================================================
// Environment Detection
// ============================================================================

/** True when running under a debugger (Node inspector or DEBUGGER_ACTIVE env var). */
export const DEBUGGER_ACTIVE = Boolean(process.env.DEBUGGER_ACTIVE ?? inspector.url() !== undefined)

/** True when running in CI environment. */
export const IS_CI = process.env.CI === 'true'

// ============================================================================
// OTEL Layer for Vitest
// ============================================================================

/** Configuration for Vitest OTEL layer. */
export interface OtelVitestConfig {
  /** Service name for OTEL traces. @default 'vitest' */
  serviceName?: string
  /** Environment variable containing the OTLP endpoint URL. @default 'OTEL_EXPORTER_OTLP_ENDPOINT' */
  endpointEnvVar?: string
  /** Tracer export interval in milliseconds. @default 250 */
  exportInterval?: number
}

/**
 * Creates an OTEL layer for Vitest tests.
 *
 * Returns `Layer.empty` if no OTEL endpoint is configured.
 * Use `DEBUGGER_ACTIVE` or `forceOtel` to enable OTEL in local dev.
 */
export const makeOtelVitestLayer = (
  config: OtelVitestConfig & { rootSpanName: string },
): Layer.Layer<never> => {
  const {
    serviceName = 'vitest',
    endpointEnvVar = 'OTEL_EXPORTER_OTLP_ENDPOINT',
    exportInterval = 250,
    rootSpanName,
  } = config

  return Layer.unwrapEffect(
    Effect.sync(() => {
      const endpoint = process.env[endpointEnvVar]
      if (endpoint === undefined) {
        return Layer.span(rootSpanName)
      }

      const exporterLive = OtlpTracer.layer({
        url: endpoint,
        resource: { serviceName },
        exportInterval,
      }).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(OtlpSerialization.layerJson),
      )

      return Layer.mergeAll(Layer.span(rootSpanName), exporterLive)
    }),
  )
}

/** Dummy OTEL layer that does nothing (for when OTEL is disabled). */
export const OtelVitestDummy: Layer.Layer<never> = Layer.empty

// ============================================================================
// withTestCtx - Test Context Wrapper
// ============================================================================

/** Configuration for `makeWithTestCtx`. */
export type WithTestCtxParams<ROut, E1, RIn> = {
  /** Suffix to append to test name in span/logs. */
  suffix?: string
  /** Factory to create a layer for the test. */
  makeLayer?: (testContext: Vitest.TestContext) => Layer.Layer<ROut, E1, RIn | Scope.Scope>
  /** Test timeout. @default 60_000ms in CI, 10_000ms locally */
  timeout?: Duration.DurationInput
  /** Force OTEL tracing even when not in debugger. @default false */
  forceOtel?: boolean
}

/**
 * Creates a test context wrapper factory with configurable layers, timeouts, and OTEL integration.
 *
 * @example
 * ```typescript
 * const withTestCtx = makeWithTestCtx({
 *   timeout: Duration.minutes(2),
 *   makeLayer: (testContext) => Layer.mergeAll(
 *     NodeContext.layer,
 *     MyService.layer,
 *   ),
 * })
 *
 * Vitest.scopedLive('test name', (test) =>
 *   Effect.gen(function* () {
 *     // test body
 *   }).pipe(withTestCtx()(test))
 * )
 * ```
 */
export const makeWithTestCtx: <ROut = never, E1 = never, RIn = never>(
  ctxParams: WithTestCtxParams<ROut, E1, RIn>,
) => (testContext: Vitest.TestContext) => <A, E, R>(
  self: Effect.Effect<A, E, R>,
) => Effect.Effect<
  A,
  E | E1 | Cause.TimeoutException,
  // Exclude dependencies provided by `withTestCtx` from the layer dependencies
  | Exclude<RIn, Scope.Scope>
  // Exclude dependencies provided by `withTestCtx` **and** dependencies produced
  // by the layer from the effect dependencies
  | Exclude<R, ROut | Scope.Scope>
> = (ctxParams) => (testContext: Vitest.TestContext) => withTestCtx(testContext, ctxParams)

/**
 * Internal implementation of withTestCtx.
 */
export const withTestCtx =
  // oxlint-disable-next-line overeng/named-args -- API matches @effect/vitest patterns
  <ROut = never, E1 = never, RIn = never>(
    testContext: Vitest.TestContext,
    {
      suffix,
      makeLayer,
      timeout = IS_CI ? 60_000 : 10_000,
      forceOtel = false,
    }: WithTestCtxParams<ROut, E1, RIn> = {},
  ) =>
    <A, E, R>(
      self: Effect.Effect<A, E, R>,
    ): Effect.Effect<
      A,
      E | E1 | Cause.TimeoutException,
      // Exclude dependencies provided internally from the provided layer's dependencies
      | Exclude<RIn, Scope.Scope>
      // Exclude dependencies provided internally **and** dependencies produced by the
      // provided layer from the effect dependencies
      | Exclude<R, ROut | Scope.Scope>
    > => {
      const spanName = `${testContext.task.suite?.name}:${testContext.task.name}${suffix ? `:${suffix}` : ''}`
      const layer = makeLayer?.(testContext) ?? Layer.empty

      const otelLayer =
        DEBUGGER_ACTIVE || forceOtel
          ? makeOtelVitestLayer({ rootSpanName: spanName, serviceName: 'vitest-runner' })
          : OtelVitestDummy

      const combinedLayer = layer.pipe(Layer.provideMerge(otelLayer))

      return self.pipe(
        DEBUGGER_ACTIVE ? identity : Effect.timeout(timeout),
        Effect.provide(combinedLayer),
        Effect.scoped, // We need to scope the effect manually here because otherwise the span is not closed
        Effect.annotateLogs({ suffix }),
      ) as any
    }

// ============================================================================
// Enhanced Property-Based Testing
// ============================================================================

/**
 * Shared properties for all enhanced test context phases.
 */
export interface EnhancedTestContextBase {
  /** Configured number of runs for the property test. */
  numRuns: number
  /** 0-based index of the current run. */
  runIndex: number
  /** Total number of executions including initial runs and shrinking attempts. */
  totalExecutions: number
}

/**
 * Enhanced context for property-based tests that includes shrinking phase information.
 *
 * This solves the confusion where tests show "Run 26/6" when FastCheck's shrinking
 * algorithm is active by clearly distinguishing between initial runs and shrinking.
 */
export type EnhancedTestContext =
  | (EnhancedTestContextBase & {
      _tag: 'initial'
    })
  | (EnhancedTestContextBase & {
      _tag: 'shrinking'
      /** Number of shrinking attempts. */
      shrinkAttempt: number
    })

/**
 * Normalizes propOptions to ensure @effect/vitest receives correct fastCheck structure.
 */
const normalizePropOptions = <Arbs extends Vitest.Vitest.Arbitraries>(
  propOptions:
    | number
    | (Vitest.TestOptions & {
        fastCheck?: FC.Parameters<{
          [K in keyof Arbs]: Arbs[K] extends FC.Arbitrary<infer T> ? T : Schema.Schema.Type<Arbs[K]>
        }>
      }),
): Vitest.TestOptions & {
  fastCheck?: FC.Parameters<{
    [K in keyof Arbs]: Arbs[K] extends FC.Arbitrary<infer T> ? T : Schema.Schema.Type<Arbs[K]>
  }>
} => {
  // If it's a number, treat as timeout and add our default fastCheck
  if (!Predicate.isObject(propOptions)) {
    return {
      timeout: propOptions,
      fastCheck: { numRuns: 100 },
    }
  }

  // If no fastCheck property, add it with our default numRuns
  if (!propOptions.fastCheck) {
    return {
      ...propOptions,
      fastCheck: { numRuns: 100 },
    }
  }

  // If fastCheck exists but no numRuns, add our default
  if (propOptions.fastCheck && !propOptions.fastCheck.numRuns) {
    return {
      ...propOptions,
      fastCheck: {
        ...propOptions.fastCheck,
        numRuns: 100,
      },
    }
  }

  // If everything is properly structured, pass through
  return propOptions
}

/**
 * Enhanced property-based testing with shrinking progress visibility.
 *
 * This function enhances the standard property-based testing by providing clear information about
 * whether FastCheck is in the initial testing phase or the shrinking phase, solving the confusion
 * where tests show "Run 26/6" when FastCheck's shrinking algorithm is active.
 *
 * @example
 * ```typescript
 * const StorageType = Schema.Literal('memory', 'fs')
 * const Count = Schema.Int.pipe(Schema.between(1, 100))
 *
 * Vitest.asProp(
 *   Vitest.scopedLive,
 *   'syncs data between clients',
 *   { storageType: StorageType, count: Count },
 *   ({ storageType, count }, test, enhanced) =>
 *     Effect.gen(function* () {
 *       yield* Effect.log(
 *         enhanced._tag === 'initial'
 *           ? `Run ${enhanced.runIndex + 1}/${enhanced.numRuns}`
 *           : `Shrink #${enhanced.shrinkAttempt}`
 *       )
 *       // test body
 *     }).pipe(withTestCtx()(test)),
 *   { fastCheck: { numRuns: 10 } }
 * )
 * ```
 */
// oxlint-disable-next-line overeng/named-args -- API matches @effect/vitest patterns
export const asProp = <Arbs extends Vitest.Vitest.Arbitraries, A, E, R>(
  api: Vitest.Vitest.Tester<R>,
  name: string,
  arbitraries: Arbs,
  test: Vitest.Vitest.TestFunction<
    A,
    E,
    R,
    [
      {
        [K in keyof Arbs]: Arbs[K] extends FC.Arbitrary<infer T> ? T : Schema.Schema.Type<Arbs[K]>
      },
      Vitest.TestContext,
      EnhancedTestContext,
    ]
  >,
  propOptions:
    | number
    | (Vitest.TestOptions & {
        fastCheck?: FC.Parameters<{
          [K in keyof Arbs]: Arbs[K] extends FC.Arbitrary<infer T> ? T : Schema.Schema.Type<Arbs[K]>
        }>
      }),
) => {
  const normalizedPropOptions = normalizePropOptions(propOptions)
  const numRuns = normalizedPropOptions.fastCheck?.numRuns ?? 100
  let runIndex = 0
  let shrinkAttempts = 0
  let totalExecutions = 0

  return api.prop(
    name,
    arbitraries,
    (properties, ctx) => {
      if (ctx.signal.aborted) {
        return ctx.skip('Test aborted')
      }

      totalExecutions++
      const isInShrinkingPhase = runIndex >= numRuns

      if (isInShrinkingPhase) {
        shrinkAttempts++
      }

      const enhancedContext: EnhancedTestContext = isInShrinkingPhase
        ? {
            _tag: 'shrinking',
            numRuns,
            runIndex: runIndex++,
            shrinkAttempt: shrinkAttempts,
            totalExecutions,
          }
        : {
            _tag: 'initial',
            numRuns,
            runIndex: runIndex++,
            totalExecutions,
          }

      return test(properties, ctx, enhancedContext)
    },
    normalizedPropOptions,
  )
}
