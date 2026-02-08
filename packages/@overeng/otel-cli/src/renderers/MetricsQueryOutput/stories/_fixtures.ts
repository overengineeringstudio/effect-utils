/**
 * Test fixtures for MetricsQuery stories
 *
 * Provides deterministic, configurable state factories and timeline for Storybook.
 * Uses a seeded PRNG for consistent renders across sessions.
 */

import type { MetricSeries, QueryAction, QueryState } from '../schema.ts'

// =============================================================================
// Deterministic PRNG
// =============================================================================

/**
 * Mulberry32 seeded pseudo-random number generator.
 * Returns a function that produces deterministic values in [0, 1) for a given seed.
 */
const mulberry32 = (seed: number): (() => number) => {
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// =============================================================================
// Constants
// =============================================================================

/** Fixed reference time for deterministic stories (2025-01-15T12:00:00Z). */
const REFERENCE_TIME = 1736942400

/** Step duration between timeline events in milliseconds. */
const STEP_DURATION = 600

/** Range presets mapping range label to { durationSeconds, stepSeconds }. */
export const RANGE_PRESETS = {
  '1h': { durationSeconds: 3600, stepSeconds: 60 },
  '6h': { durationSeconds: 21600, stepSeconds: 120 },
  '24h': { durationSeconds: 86400, stepSeconds: 300 },
  '7d': { durationSeconds: 604800, stepSeconds: 1800 },
} as const

/** Valid range keys. */
export type RangeKey = keyof typeof RANGE_PRESETS

// =============================================================================
// Helpers
// =============================================================================

/**
 * Generate deterministic sample data points for a time range.
 * Uses the seeded PRNG instead of Math.random() for consistent renders.
 */
const generateSamples = (options: {
  readonly count: number
  readonly baseValue: number
  readonly variance: number
  readonly stepMs: number
  readonly seed: number
}): Array<{ timestampMs: number; value: number }> => {
  const endMs = REFERENCE_TIME * 1000
  const random = mulberry32(options.seed)
  const samples = []

  for (let i = 0; i < options.count; i++) {
    samples.push({
      timestampMs: endMs - (options.count - i) * options.stepMs,
      value: options.baseValue + (random() - 0.5) * 2 * options.variance,
    })
  }

  return samples
}

/**
 * Compute startTime, endTime, step, and sample count from range and step overrides.
 */
const computeTimeParams = (_: { range: RangeKey; step?: number | undefined }) => {
  const preset = RANGE_PRESETS[_.range]
  const stepSeconds = _.step ?? preset.stepSeconds
  const endTime = REFERENCE_TIME
  const startTime = endTime - preset.durationSeconds
  const count = Math.floor(preset.durationSeconds / stepSeconds)
  return { startTime, endTime, stepSeconds, count, stepMs: stepSeconds * 1000 }
}

// =============================================================================
// State Config
// =============================================================================

/** Configuration for creating a metrics query state from CLI flags. */
export interface StateConfig {
  /** --range flag: preset time range. */
  readonly range: RangeKey
  /** --step flag: query step in seconds (overrides range preset default). */
  readonly step?: number
  /** TraceQL query string. */
  readonly query: string
  /** Series data definition for generating samples. */
  readonly series: ReadonlyArray<{
    readonly name: string
    readonly labels: Record<string, string>
    readonly baseValue: number
    readonly variance: number
    readonly exemplarCount: number
    readonly seed: number
  }>
}

// =============================================================================
// Series Definitions
// =============================================================================

/** Single rate series. */
const rateSeries: StateConfig['series'] = [
  { name: 'rate', labels: {}, baseValue: 50, variance: 30, exemplarCount: 45, seed: 1001 },
]

/** Multi-series grouped by service. */
const groupedSeries: StateConfig['series'] = [
  {
    name: 'rate',
    labels: { 'service.name': 'dt' },
    baseValue: 100,
    variance: 50,
    exemplarCount: 120,
    seed: 2001,
  },
  {
    name: 'rate',
    labels: { 'service.name': 'genie' },
    baseValue: 30,
    variance: 15,
    exemplarCount: 45,
    seed: 2002,
  },
  {
    name: 'rate',
    labels: { 'service.name': 'megarepo' },
    baseValue: 10,
    variance: 5,
    exemplarCount: 12,
    seed: 2003,
  },
]

/** Histogram series with quantiles. */
const histogramSeries: StateConfig['series'] = [
  {
    name: 'histogram',
    labels: { 'service.name': 'dt', quantile: 'p50' },
    baseValue: 250,
    variance: 50,
    exemplarCount: 30,
    seed: 3001,
  },
  {
    name: 'histogram',
    labels: { 'service.name': 'dt', quantile: 'p95' },
    baseValue: 800,
    variance: 200,
    exemplarCount: 30,
    seed: 3002,
  },
  {
    name: 'histogram',
    labels: { 'service.name': 'dt', quantile: 'p99' },
    baseValue: 1500,
    variance: 500,
    exemplarCount: 30,
    seed: 3003,
  },
]

// =============================================================================
// Named Scenario Configs
// =============================================================================

/** Rate query config. */
export const rateQueryConfig: StateConfig = {
  range: '1h',
  query: '{} | rate()',
  series: rateSeries,
}

/** Grouped by service config. */
export const groupedQueryConfig: StateConfig = {
  range: '1h',
  query: '{} | rate() by (service.name)',
  series: groupedSeries,
}

/** Histogram query config. */
export const histogramQueryConfig: StateConfig = {
  range: '1h',
  query: '{service.name="dt"} | histogram_over_time(duration)',
  series: histogramSeries,
}

// =============================================================================
// State Factories
// =============================================================================

/** Loading state for interactive timeline start. */
export const loadingState = (): QueryState => ({
  _tag: 'Loading',
  message: 'Querying metrics...',
})

/**
 * Creates a success state from a config object.
 * Generates deterministic sample data based on range, step, and series definitions.
 * This ensures interactive and static modes use the same state configuration.
 */
export const createState = (config: StateConfig): QueryState => {
  const { startTime, endTime, stepSeconds, count, stepMs } = computeTimeParams({
    range: config.range,
    step: config.step,
  })

  const series: MetricSeries[] = config.series.map((s) => ({
    name: s.name,
    labels: s.labels,
    samples: generateSamples({
      count,
      baseValue: s.baseValue,
      variance: s.variance,
      stepMs,
      seed: s.seed,
    }),
    exemplarCount: s.exemplarCount,
  }))

  return {
    _tag: 'Success',
    series,
    query: config.query,
    startTime,
    endTime,
    step: stepSeconds,
  }
}

/** Error state - invalid query. */
export const createInvalidQueryError = (): QueryState => ({
  _tag: 'Error',
  error: 'InvalidQuery',
  message: 'parse error at line 1, col 5: syntax error: unexpected rate',
})

/** Error state - connection failure. */
export const createConnectionError = (): QueryState => ({
  _tag: 'Error',
  error: 'RequestFailed',
  message: 'Failed to connect to Tempo. Is the OTEL stack running?',
})

// =============================================================================
// Timeline Factory
// =============================================================================

/**
 * Creates a timeline that animates from loading to the final success state.
 *
 * The timeline dispatches a single SetResults action after a delay,
 * simulating the CLI fetching metrics data from the backend.
 */
export const createTimeline = (config: StateConfig): Array<{ at: number; action: QueryAction }> => {
  const { startTime, endTime, stepSeconds, count, stepMs } = computeTimeParams({
    range: config.range,
    step: config.step,
  })

  const series: MetricSeries[] = config.series.map((s) => ({
    name: s.name,
    labels: s.labels,
    samples: generateSamples({
      count,
      baseValue: s.baseValue,
      variance: s.variance,
      stepMs,
      seed: s.seed,
    }),
    exemplarCount: s.exemplarCount,
  }))

  return [
    {
      at: STEP_DURATION,
      action: {
        _tag: 'SetResults',
        series,
        query: config.query,
        startTime,
        endTime,
        step: stepSeconds,
      },
    },
  ]
}

/**
 * Creates a timeline that ends in an invalid query error.
 * Simulates the CLI attempting to query and receiving a parse error.
 */
export const createInvalidQueryErrorTimeline = (): Array<{ at: number; action: QueryAction }> => [
  {
    at: STEP_DURATION,
    action: {
      _tag: 'SetError',
      error: 'InvalidQuery',
      message: 'parse error at line 1, col 5: syntax error: unexpected rate',
    },
  },
]

/**
 * Creates a timeline that ends in a connection error.
 * Simulates the CLI failing to reach the Tempo backend.
 */
export const createConnectionErrorTimeline = (): Array<{ at: number; action: QueryAction }> => [
  {
    at: STEP_DURATION,
    action: {
      _tag: 'SetError',
      error: 'RequestFailed',
      message: 'Failed to connect to Tempo. Is the OTEL stack running?',
    },
  },
]
