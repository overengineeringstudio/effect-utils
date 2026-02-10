/**
 * Test fixtures for TraceLs stories
 *
 * Provides configurable state factories and timeline for Storybook.
 * Trace data is kept as constants to avoid regeneration.
 */

import { DateTime } from 'effect'

import type { LsAction, LsState, TraceSummary } from '../schema.ts'

// =============================================================================
// Example Trace Data
// =============================================================================

/** Realistic trace summaries for default stories (sorted most recent first). */
export const exampleTraces: TraceSummary[] = [
  {
    traceId: 'f47ac10b58cc4372a5670e02b2c3d479',
    serviceName: 'dt',
    spanName: 'check:quick',
    durationMs: 22000,
    startTime: DateTime.unsafeMake(Date.now() - 2 * 60_000),
  },
  {
    traceId: 'abc123def456789012345678abcdef01',
    serviceName: 'dt',
    spanName: 'check:quick',
    durationMs: 18500,
    startTime: DateTime.unsafeMake(Date.now() - 5 * 60_000),
  },
  {
    traceId: 'deadbeef12345678deadbeef12345678',
    serviceName: 'dt',
    spanName: 'ts:check',
    durationMs: 14200,
    startTime: DateTime.unsafeMake(Date.now() - 12 * 60_000),
  },
  {
    traceId: '0123456789abcdef0123456789abcdef',
    serviceName: 'dt',
    spanName: 'check:all',
    durationMs: 45600,
    startTime: DateTime.unsafeMake(Date.now() - 30 * 60_000),
  },
  {
    traceId: 'cafebabe00112233cafebabe00112233',
    serviceName: 'dt',
    spanName: 'check:quick',
    durationMs: 19800,
    startTime: DateTime.unsafeMake(Date.now() - 55 * 60_000),
  },
]

// =============================================================================
// State Config
// =============================================================================

/** Configuration for creating a success state from CLI flags. */
export interface StateConfig {
  /** --query flag: optional TraceQL query filter. */
  readonly query?: string | undefined
  /** --limit flag: max traces to return. */
  readonly limit: number
  /** --all flag: include internal Tempo traces. */
  readonly all: boolean
  /** Traces to display. */
  readonly traces: TraceSummary[]
}

// =============================================================================
// State Factories
// =============================================================================

/** Loading state for interactive timeline start. */
export const loadingState = (): LsState => ({
  _tag: 'Loading',
  message: 'Searching traces...',
})

/**
 * Creates a success state from a config object.
 * This ensures interactive and static modes use the same state configuration.
 */
export const createState = (config: StateConfig): LsState => ({
  _tag: 'Success',
  traces: config.traces,
  ...(config.query !== undefined ? { query: config.query } : {}),
  limit: config.limit,
})

/** Error state for connection failures. */
export const createErrorState = (): LsState => ({
  _tag: 'Error',
  error: 'Unreachable',
  message: 'Failed to connect to Grafana. Is the OTEL stack running?',
})

// =============================================================================
// Timeline Factory
// =============================================================================

/** Step duration in milliseconds for timeline animations. */
const STEP_DURATION = 600

/**
 * Creates a timeline that progressively adds traces.
 * This ensures interactive mode shows the same end result as static mode.
 */
export const createTimeline = (config: StateConfig): Array<{ at: number; action: LsAction }> => {
  const timeline: Array<{ at: number; action: LsAction }> = []

  // Progressively add traces one at a time
  for (let i = 0; i < config.traces.length; i++) {
    timeline.push({
      at: (i + 1) * STEP_DURATION,
      action: {
        _tag: 'SetTraces',
        traces: config.traces.slice(0, i + 1),
        ...(config.query !== undefined ? { query: config.query } : {}),
        limit: config.limit,
      },
    })
  }

  // If no traces, push a single empty result
  if (config.traces.length === 0) {
    timeline.push({
      at: STEP_DURATION,
      action: {
        _tag: 'SetTraces',
        traces: [],
        ...(config.query !== undefined ? { query: config.query } : {}),
        limit: config.limit,
      },
    })
  }

  return timeline
}
