/**
 * Test fixtures for TraceInspect stories
 *
 * Provides realistic span tree state factories and timeline builders for Storybook.
 */

import type { InspectAction, InspectState, ProcessedSpan } from '../schema.ts'

// =============================================================================
// Types
// =============================================================================

/** Options accepted by all Success state factories. */
export type StateOptions = {
  flat?: boolean
}

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
// Span Data
// =============================================================================

/** Root span for the simple trace. */
const simpleRootSpans: ReadonlyArray<ProcessedSpan> = [
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
]

/** Root span for the realistic trace with nested project spans. */
const realisticRootSpans: ReadonlyArray<ProcessedSpan> = [
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
]

/** Root span for the error-span trace. */
const errorSpanRootSpans: ReadonlyArray<ProcessedSpan> = [
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
]

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
export const simpleTraceState = (opts: StateOptions = {}): InspectState => ({
  _tag: 'Success',
  traceId: 'abc123def456abc123def456abc12345',
  totalSpanCount: 3,
  traceStartMs: 0,
  traceEndMs: 5000,
  traceDurationMs: 5000,
  flat: opts.flat ?? false,
  rootSpans: simpleRootSpans,
})

/** Realistic dt check:quick trace with nested project spans. */
export const realisticTraceState = (opts: StateOptions = {}): InspectState => ({
  _tag: 'Success',
  traceId: 'f47ac10b58cc4372a5670e02b2c3d479',
  totalSpanCount: 12,
  traceStartMs: 0,
  traceEndMs: 22000,
  traceDurationMs: 22000,
  flat: opts.flat ?? false,
  rootSpans: realisticRootSpans,
})

/** Trace with error spans (statusCode 2). */
export const errorSpanTraceState = (opts: StateOptions = {}): InspectState => ({
  _tag: 'Success',
  traceId: 'deadbeef12345678deadbeef12345678',
  totalSpanCount: 3,
  traceStartMs: 0,
  traceEndMs: 1500,
  traceDurationMs: 1500,
  flat: opts.flat ?? false,
  rootSpans: errorSpanRootSpans,
})

// =============================================================================
// Timeline Factories
// =============================================================================

/** Default step duration in ms for timeline events. */
const STEP_DURATION = 600

/**
 * Create a timeline that progressively reveals spans for the simple trace.
 *
 * loading -> partial tree (root + ts:check) -> full tree (all 3 spans)
 */
export const createSimpleTimeline = (
  opts: StateOptions = {},
): Array<{ at: number; action: InspectAction }> => {
  const flat = opts.flat ?? false

  return [
    // Step 1: Partial tree — root with first child only
    {
      at: STEP_DURATION,
      action: {
        _tag: 'SetTrace',
        traceId: 'abc123def456abc123def456abc12345',
        totalSpanCount: 2,
        traceStartMs: 0,
        traceEndMs: 3600,
        traceDurationMs: 3600,
        flat,
        rootSpans: [
          span({
            spanId: 'span-root',
            name: 'check:quick',
            serviceName: 'dt',
            startTimeMs: 0,
            durationMs: 3600,
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
            ],
          }),
        ],
      },
    },
    // Step 2: Full tree — all spans arrived
    {
      at: STEP_DURATION * 2,
      action: {
        _tag: 'SetTrace',
        traceId: 'abc123def456abc123def456abc12345',
        totalSpanCount: 3,
        traceStartMs: 0,
        traceEndMs: 5000,
        traceDurationMs: 5000,
        flat,
        rootSpans: simpleRootSpans,
      },
    },
  ]
}

/**
 * Create a timeline that progressively reveals spans for the realistic trace.
 *
 * loading -> partial (lint tasks) -> partial (ts:check children) -> full tree
 */
export const createRealisticTimeline = (
  opts: StateOptions = {},
): Array<{ at: number; action: InspectAction }> => {
  const flat = opts.flat ?? false

  return [
    // Step 1: Partial tree — root + lint tasks only
    {
      at: STEP_DURATION,
      action: {
        _tag: 'SetTrace',
        traceId: 'f47ac10b58cc4372a5670e02b2c3d479',
        totalSpanCount: 5,
        traceStartMs: 0,
        traceEndMs: 22000,
        traceDurationMs: 22000,
        flat,
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
            ],
          }),
        ],
      },
    },
    // Step 2: More spans — ts:check gets children, remaining lint tasks
    {
      at: STEP_DURATION * 2,
      action: {
        _tag: 'SetTrace',
        traceId: 'f47ac10b58cc4372a5670e02b2c3d479',
        totalSpanCount: 9,
        traceStartMs: 0,
        traceEndMs: 22000,
        traceDurationMs: 22000,
        flat,
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
            ],
          }),
        ],
      },
    },
    // Step 3: Full tree — all 12 spans
    {
      at: STEP_DURATION * 3,
      action: {
        _tag: 'SetTrace',
        traceId: 'f47ac10b58cc4372a5670e02b2c3d479',
        totalSpanCount: 12,
        traceStartMs: 0,
        traceEndMs: 22000,
        traceDurationMs: 22000,
        flat,
        rootSpans: realisticRootSpans,
      },
    },
  ]
}

/**
 * Create a timeline that progressively reveals spans for the error-span trace.
 *
 * loading -> partial (root + ts:check error) -> full tree
 */
export const createErrorSpanTimeline = (
  opts: StateOptions = {},
): Array<{ at: number; action: InspectAction }> => {
  const flat = opts.flat ?? false

  return [
    // Step 1: Partial — root + failing ts:check
    {
      at: STEP_DURATION,
      action: {
        _tag: 'SetTrace',
        traceId: 'deadbeef12345678deadbeef12345678',
        totalSpanCount: 2,
        traceStartMs: 0,
        traceEndMs: 1450,
        traceDurationMs: 1450,
        flat,
        rootSpans: [
          span({
            spanId: 'root',
            name: 'check:quick',
            serviceName: 'dt',
            startTimeMs: 0,
            durationMs: 1450,
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
            ],
          }),
        ],
      },
    },
    // Step 2: Full tree — all 3 spans including lint:check
    {
      at: STEP_DURATION * 2,
      action: {
        _tag: 'SetTrace',
        traceId: 'deadbeef12345678deadbeef12345678',
        totalSpanCount: 3,
        traceStartMs: 0,
        traceEndMs: 1500,
        traceDurationMs: 1500,
        flat,
        rootSpans: errorSpanRootSpans,
      },
    },
  ]
}
