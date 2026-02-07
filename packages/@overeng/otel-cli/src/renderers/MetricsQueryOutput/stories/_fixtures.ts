/**
 * Test fixtures for MetricsQuery stories
 *
 * Provides realistic TraceQL metrics query state factories for Storybook.
 */

import type { QueryState } from '../schema.ts'

// =============================================================================
// Helpers
// =============================================================================

/** Generate sample data points for a time range. */
const generateSamples = (options: {
  readonly count: number
  readonly baseValue: number
  readonly variance: number
}): Array<{ timestampMs: number; value: number }> => {
  const now = Date.now()
  const step = 60000 // 1 minute
  const samples = []

  for (let i = 0; i < options.count; i++) {
    samples.push({
      timestampMs: now - (options.count - i) * step,
      value: options.baseValue + (Math.random() - 0.5) * 2 * options.variance,
    })
  }

  return samples
}

// =============================================================================
// State Factories
// =============================================================================

/** Loading state. */
export const loadingState = (): QueryState => ({
  _tag: 'Loading',
  message: 'Querying metrics...',
})

/** Error state - invalid query. */
export const errorState = (): QueryState => ({
  _tag: 'Error',
  error: 'InvalidQuery',
  message: 'parse error at line 1, col 5: syntax error: unexpected rate',
})

/** Error state - request failed. */
export const connectionErrorState = (): QueryState => ({
  _tag: 'Error',
  error: 'RequestFailed',
  message: 'Failed to connect to Tempo. Is the OTEL stack running?',
})

/** Empty results. */
export const emptyState = (): QueryState => ({
  _tag: 'Success',
  series: [],
  query: '{service.name="nonexistent"} | rate()',
  startTime: Math.floor(Date.now() / 1000) - 3600,
  endTime: Math.floor(Date.now() / 1000),
  step: 60,
})

/** Single series rate query. */
export const rateQueryState = (): QueryState => ({
  _tag: 'Success',
  series: [
    {
      name: 'rate',
      labels: {},
      samples: generateSamples({ count: 60, baseValue: 50, variance: 30 }),
      exemplarCount: 45,
    },
  ],
  query: '{} | rate()',
  startTime: Math.floor(Date.now() / 1000) - 3600,
  endTime: Math.floor(Date.now() / 1000),
  step: 60,
})

/** Multi-series grouped by service. */
export const groupedQueryState = (): QueryState => ({
  _tag: 'Success',
  series: [
    {
      name: 'rate',
      labels: { 'service.name': 'dt' },
      samples: generateSamples({ count: 60, baseValue: 100, variance: 50 }),
      exemplarCount: 120,
    },
    {
      name: 'rate',
      labels: { 'service.name': 'genie' },
      samples: generateSamples({ count: 60, baseValue: 30, variance: 15 }),
      exemplarCount: 45,
    },
    {
      name: 'rate',
      labels: { 'service.name': 'megarepo' },
      samples: generateSamples({ count: 60, baseValue: 10, variance: 5 }),
      exemplarCount: 12,
    },
  ],
  query: '{} | rate() by (service.name)',
  startTime: Math.floor(Date.now() / 1000) - 3600,
  endTime: Math.floor(Date.now() / 1000),
  step: 60,
})

/** Histogram query with quantiles. */
export const histogramQueryState = (): QueryState => ({
  _tag: 'Success',
  series: [
    {
      name: 'histogram',
      labels: { 'service.name': 'dt', quantile: 'p50' },
      samples: generateSamples({ count: 60, baseValue: 250, variance: 50 }),
      exemplarCount: 30,
    },
    {
      name: 'histogram',
      labels: { 'service.name': 'dt', quantile: 'p95' },
      samples: generateSamples({ count: 60, baseValue: 800, variance: 200 }),
      exemplarCount: 30,
    },
    {
      name: 'histogram',
      labels: { 'service.name': 'dt', quantile: 'p99' },
      samples: generateSamples({ count: 60, baseValue: 1500, variance: 500 }),
      exemplarCount: 30,
    },
  ],
  query: '{service.name="dt"} | histogram_over_time(duration)',
  startTime: Math.floor(Date.now() / 1000) - 3600,
  endTime: Math.floor(Date.now() / 1000),
  step: 60,
})

/** Long time range (24h). */
export const longRangeState = (): QueryState => ({
  _tag: 'Success',
  series: [
    {
      name: 'rate',
      labels: {},
      samples: generateSamples({ count: 288, baseValue: 75, variance: 40 }), // 5-minute steps for 24h
      exemplarCount: 200,
    },
  ],
  query: '{} | rate()',
  startTime: Math.floor(Date.now() / 1000) - 86400,
  endTime: Math.floor(Date.now() / 1000),
  step: 300,
})
