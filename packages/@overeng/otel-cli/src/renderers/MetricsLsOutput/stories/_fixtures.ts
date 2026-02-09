/**
 * Test fixtures for MetricsLs stories
 *
 * Provides realistic metrics listing state factories and timeline for Storybook.
 */

import type { LsAction, LsState, MetricSummary } from '../schema.ts'

// =============================================================================
// Metric Data Constants
// =============================================================================

/** Collector metrics — realistic OTEL collector metric summaries. */
export const COLLECTOR_METRICS: MetricSummary[] = [
  {
    name: 'otelcol_exporter_sent_spans_total',
    type: 'counter',
    value: 76432,
    labels: { exporter: 'otlp' },
    help: 'Number of spans successfully sent to destination',
  },
  {
    name: 'otelcol_exporter_send_failed_spans_total',
    type: 'counter',
    value: 0,
    labels: { exporter: 'otlp' },
    help: 'Number of spans in failed attempts to send',
  },
  {
    name: 'otelcol_exporter_queue_size',
    type: 'gauge',
    value: 0,
    labels: { data_type: 'traces', exporter: 'otlp' },
    help: 'Current size of the retry queue (in batches)',
  },
  {
    name: 'otelcol_exporter_queue_capacity',
    type: 'gauge',
    value: 1000,
    labels: { data_type: 'traces', exporter: 'otlp' },
    help: 'Fixed capacity of the retry queue',
  },
  {
    name: 'otelcol_process_memory_rss_bytes',
    type: 'gauge',
    value: 179597312,
    labels: {},
    help: 'Total physical memory (resident set size)',
  },
  {
    name: 'otelcol_process_cpu_seconds_total',
    type: 'counter',
    value: 1.23,
    labels: {},
    help: 'Total CPU user and system time in seconds',
  },
]

/** Collector metric names (sorted). */
export const COLLECTOR_METRIC_NAMES: string[] = [
  'otelcol_exporter_queue_capacity',
  'otelcol_exporter_queue_size',
  'otelcol_exporter_send_failed_spans_total',
  'otelcol_exporter_sent_spans_total',
  'otelcol_process_cpu_seconds_total',
  'otelcol_process_memory_rss_bytes',
]

/** Tempo tag metrics — realistic Tempo tag summaries. */
export const TEMPO_METRICS: MetricSummary[] = [
  { name: 'service.name', type: 'tag', value: 7, labels: {}, help: '7 unique values' },
  { name: 'exit.code', type: 'tag', value: 3, labels: {}, help: '3 unique values' },
  { name: 'devenv.root', type: 'tag', value: 2, labels: {}, help: '2 unique values' },
  { name: 'http.request.method', type: 'tag', value: 4, labels: {}, help: '4 unique values' },
  {
    name: 'http.response.status_code',
    type: 'tag',
    value: 12,
    labels: {},
    help: '12 unique values',
  },
]

/** Tempo metric names. */
export const TEMPO_METRIC_NAMES: string[] = [
  'service.name',
  'exit.code',
  'devenv.root',
  'http.request.method',
  'http.response.status_code',
]

// =============================================================================
// State Factories
// =============================================================================

/** Configuration for creating a success state. */
export interface LsStateConfig {
  filter?: string
  source: 'collector' | 'tempo'
  metrics: MetricSummary[]
  metricNames: string[]
}

/**
 * Create a success state from config.
 *
 * Applies filter to metrics/metricNames when provided.
 */
export const createState = (config: LsStateConfig): LsState => {
  const filteredMetrics = config.filter
    ? config.metrics.filter((m) => m.name.includes(config.filter!))
    : config.metrics
  const filteredNames = config.filter
    ? config.metricNames.filter((n) => n.includes(config.filter!))
    : config.metricNames

  return {
    _tag: 'Success',
    metrics: filteredMetrics,
    metricNames: filteredNames,
    ...(config.filter ? { filter: config.filter } : {}),
    source: config.source,
  }
}

/** Loading state. */
export const loadingState = (): LsState => ({
  _tag: 'Loading',
  message: 'Fetching metrics...',
})

/** Error state. */
export const errorState = (): LsState => ({
  _tag: 'Error',
  error: 'RequestFailed',
  message: 'Failed to connect to OTEL Collector. Is the OTEL stack running?',
})

// =============================================================================
// Timeline Factory
// =============================================================================

/** Step duration between timeline events in milliseconds. */
const STEP_DURATION = 600

/**
 * Create a timeline that animates through Loading, progressively adding
 * metrics, then arriving at the final state.
 *
 * Each step adds one more metric to the results, simulating progressive
 * metrics arriving from the source.
 */
export const createTimeline = (config: LsStateConfig): Array<{ at: number; action: LsAction }> => {
  const timeline: Array<{ at: number; action: LsAction }> = []

  const filteredMetrics = config.filter
    ? config.metrics.filter((m) => m.name.includes(config.filter!))
    : config.metrics
  const filteredNames = config.filter
    ? config.metricNames.filter((n) => n.includes(config.filter!))
    : config.metricNames

  for (let i = 0; i < filteredMetrics.length; i++) {
    timeline.push({
      at: (i + 1) * STEP_DURATION,
      action: {
        _tag: 'SetMetrics',
        metrics: filteredMetrics.slice(0, i + 1),
        metricNames: filteredNames.slice(0, i + 1),
        ...(config.filter ? { filter: config.filter } : {}),
        source: config.source,
      },
    })
  }

  return timeline
}

/**
 * Create a timeline that ends in an error state.
 *
 * Simulates the CLI attempting to fetch metrics and then failing with a
 * connection error.
 */
export const createErrorTimeline = (): Array<{ at: number; action: LsAction }> => [
  {
    at: STEP_DURATION,
    action: {
      _tag: 'SetError',
      error: 'RequestFailed',
      message: 'Failed to connect to OTEL Collector. Is the OTEL stack running?',
    },
  },
]
