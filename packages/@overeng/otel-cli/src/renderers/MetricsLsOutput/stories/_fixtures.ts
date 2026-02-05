/**
 * Test fixtures for MetricsLs stories
 *
 * Provides realistic metrics listing state factories for Storybook.
 */

import type { LsState } from '../schema.ts'

// =============================================================================
// State Factories
// =============================================================================

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

/** Empty results. */
export const emptyState = (): LsState => ({
  _tag: 'Success',
  metrics: [],
  metricNames: [],
  source: 'collector',
})

/** Collector metrics listing. */
export const collectorState = (): LsState => ({
  _tag: 'Success',
  metrics: [
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
  ],
  metricNames: [
    'otelcol_exporter_queue_capacity',
    'otelcol_exporter_queue_size',
    'otelcol_exporter_send_failed_spans_total',
    'otelcol_exporter_sent_spans_total',
    'otelcol_process_cpu_seconds_total',
    'otelcol_process_memory_rss_bytes',
  ],
  source: 'collector',
})

/** Tempo tags listing. */
export const tempoTagsState = (): LsState => ({
  _tag: 'Success',
  metrics: [
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
  ],
  metricNames: [
    'service.name',
    'exit.code',
    'devenv.root',
    'http.request.method',
    'http.response.status_code',
  ],
  source: 'tempo',
})

/** Filtered collector metrics. */
export const filteredState = (): LsState => ({
  _tag: 'Success',
  metrics: [
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
  ],
  metricNames: ['otelcol_exporter_sent_spans_total', 'otelcol_exporter_send_failed_spans_total'],
  filter: 'exporter',
  source: 'collector',
})
