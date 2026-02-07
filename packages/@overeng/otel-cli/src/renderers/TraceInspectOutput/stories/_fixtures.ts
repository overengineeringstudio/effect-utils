/**
 * Test fixtures for TraceInspect stories
 *
 * Provides realistic span tree state factories for Storybook.
 */

import type { InspectState, ProcessedSpan } from '../schema.ts'

// =============================================================================
// Span Builders
// =============================================================================

/** Create a span with sensible defaults. */
const span = (overrides: {
  spanId: string
  name: string
  serviceName?: string
  parentSpanId?: string
  startTimeMs: number
  durationMs: number
  depth?: number
  statusCode?: number
  children?: ReadonlyArray<ProcessedSpan>
}): ProcessedSpan => ({
  spanId: overrides.spanId,
  parentSpanId: overrides.parentSpanId,
  name: overrides.name,
  serviceName: overrides.serviceName ?? 'dt-task',
  startTimeMs: overrides.startTimeMs,
  endTimeMs: overrides.startTimeMs + overrides.durationMs,
  durationMs: overrides.durationMs,
  statusCode: overrides.statusCode ?? 1,
  statusMessage: undefined,
  attributes: [],
  depth: overrides.depth ?? 0,
  children: overrides.children ?? [],
})

// =============================================================================
// State Factories
// =============================================================================

/** Loading state. */
export const loadingState = (): InspectState => ({
  _tag: 'Loading',
  message: 'Fetching trace data...',
})

/** Error state. */
export const errorState = (options: { error?: string; message?: string } = {}): InspectState => ({
  _tag: 'Error',
  error: options.error ?? 'NotFound',
  message: options.message ?? 'Trace abc123 not found in Tempo',
})

/** Simple trace with 3 sequential spans. */
export const simpleTraceState = (): InspectState => ({
  _tag: 'Success',
  traceId: 'abc123def456abc123def456abc12345',
  totalSpanCount: 3,
  traceStartMs: 0,
  traceEndMs: 5000,
  traceDurationMs: 5000,
  flat: false,
  rootSpans: [
    span({
      spanId: 'span-root',
      name: 'check:quick',
      serviceName: 'dt',
      startTimeMs: 0,
      durationMs: 5000,
      depth: 0,
      children: [
        span({
          spanId: 'span-ts',
          parentSpanId: 'span-root',
          name: 'ts:check',
          serviceName: 'dt-task',
          startTimeMs: 100,
          durationMs: 3500,
          depth: 1,
        }),
        span({
          spanId: 'span-lint',
          parentSpanId: 'span-root',
          name: 'lint:check',
          serviceName: 'dt-task',
          startTimeMs: 200,
          durationMs: 2000,
          depth: 1,
        }),
      ],
    }),
  ],
})

/** Realistic dt check:quick trace with nested project spans. */
export const realisticTraceState = (): InspectState => ({
  _tag: 'Success',
  traceId: 'f47ac10b58cc4372a5670e02b2c3d479',
  totalSpanCount: 12,
  traceStartMs: 0,
  traceEndMs: 22000,
  traceDurationMs: 22000,
  flat: false,
  rootSpans: [
    span({
      spanId: 'root',
      name: 'check:quick',
      serviceName: 'dt',
      startTimeMs: 0,
      durationMs: 22000,
      depth: 0,
      children: [
        span({
          spanId: 'ts-check',
          parentSpanId: 'root',
          name: 'ts:check',
          serviceName: 'dt-task',
          startTimeMs: 50,
          durationMs: 14000,
          depth: 1,
          children: [
            span({
              spanId: 'tsc-genie',
              parentSpanId: 'ts-check',
              name: 'genie',
              serviceName: 'tsc-project',
              startTimeMs: 100,
              durationMs: 890,
              depth: 2,
            }),
            span({
              spanId: 'tsc-utils',
              parentSpanId: 'ts-check',
              name: 'utils',
              serviceName: 'tsc-project',
              startTimeMs: 1000,
              durationMs: 2200,
              depth: 2,
            }),
            span({
              spanId: 'tsc-tui-core',
              parentSpanId: 'ts-check',
              name: 'tui-core',
              serviceName: 'tsc-project',
              startTimeMs: 3300,
              durationMs: 3100,
              depth: 2,
            }),
            span({
              spanId: 'tsc-tui-react',
              parentSpanId: 'ts-check',
              name: 'tui-react',
              serviceName: 'tsc-project',
              startTimeMs: 6500,
              durationMs: 4500,
              depth: 2,
            }),
            span({
              spanId: 'tsc-megarepo',
              parentSpanId: 'ts-check',
              name: 'megarepo',
              serviceName: 'tsc-project',
              startTimeMs: 11100,
              durationMs: 2800,
              depth: 2,
            }),
          ],
        }),
        span({
          spanId: 'lint-oxlint',
          parentSpanId: 'root',
          name: 'lint:check:oxlint',
          serviceName: 'dt-task',
          startTimeMs: 100,
          durationMs: 5600,
          depth: 1,
        }),
        span({
          spanId: 'lint-format',
          parentSpanId: 'root',
          name: 'lint:check:format',
          serviceName: 'dt-task',
          startTimeMs: 100,
          durationMs: 1200,
          depth: 1,
        }),
        span({
          spanId: 'lint-genie',
          parentSpanId: 'root',
          name: 'lint:check:genie',
          serviceName: 'dt-task',
          startTimeMs: 50,
          durationMs: 800,
          depth: 1,
        }),
        span({
          spanId: 'megarepo-check',
          parentSpanId: 'root',
          name: 'megarepo:check',
          serviceName: 'dt-task',
          startTimeMs: 14100,
          durationMs: 400,
          depth: 1,
        }),
      ],
    }),
  ],
})

/** Flat view of the realistic trace. */
export const flatTraceState = (): InspectState => {
  const base = realisticTraceState()
  if (base._tag !== 'Success') return base
  return { ...base, flat: true }
}

/** Trace with an error span. */
export const errorSpanTraceState = (): InspectState => ({
  _tag: 'Success',
  traceId: 'deadbeef12345678deadbeef12345678',
  totalSpanCount: 3,
  traceStartMs: 0,
  traceEndMs: 1500,
  traceDurationMs: 1500,
  flat: false,
  rootSpans: [
    span({
      spanId: 'root',
      name: 'check:quick',
      serviceName: 'dt',
      startTimeMs: 0,
      durationMs: 1500,
      depth: 0,
      statusCode: 2,
      children: [
        span({
          spanId: 'ts-check',
          parentSpanId: 'root',
          name: 'ts:check',
          serviceName: 'dt-task',
          startTimeMs: 50,
          durationMs: 1400,
          depth: 1,
          statusCode: 2,
        }),
        span({
          spanId: 'lint',
          parentSpanId: 'root',
          name: 'lint:check',
          serviceName: 'dt-task',
          startTimeMs: 100,
          durationMs: 500,
          depth: 1,
          statusCode: 1,
        }),
      ],
    }),
  ],
})
