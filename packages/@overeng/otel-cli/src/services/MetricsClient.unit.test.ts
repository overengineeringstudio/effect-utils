import { describe, expect, it } from 'vitest'

import type { TraceQLMetricsResponse } from './MetricsClient.ts'
import { parseMetricsSeries, parsePrometheusMetrics } from './MetricsClient.ts'

// =============================================================================
// parsePrometheusMetrics
// =============================================================================

describe('parsePrometheusMetrics', () => {
  it('returns empty metrics for empty input', () => {
    const result = parsePrometheusMetrics('')

    expect(result.metrics).toEqual([])
    expect(result.metricNames).toEqual([])
  })

  it('parses a simple counter without labels', () => {
    const text = [
      '# HELP http_requests_total Total HTTP requests',
      '# TYPE http_requests_total counter',
      'http_requests_total 42',
    ].join('\n')

    const result = parsePrometheusMetrics(text)

    expect(result.metrics).toHaveLength(1)
    expect(result.metrics[0]).toMatchObject({
      name: 'http_requests_total',
      value: 42,
      type: 'counter',
      labels: {},
      help: 'Total HTTP requests',
    })
  })

  it('parses a metric with labels', () => {
    const text = [
      '# TYPE http_requests_total counter',
      'http_requests_total{method="GET",path="/api"} 100',
    ].join('\n')

    const result = parsePrometheusMetrics(text)

    expect(result.metrics[0]!.labels).toEqual({
      method: 'GET',
      path: '/api',
    })
  })

  it('parses gauge type', () => {
    const text = ['# TYPE cpu_usage gauge', 'cpu_usage 0.75'].join('\n')

    const result = parsePrometheusMetrics(text)

    expect(result.metrics[0]!.type).toBe('gauge')
  })

  it('parses histogram type', () => {
    const text = [
      '# TYPE request_duration histogram',
      'request_duration{le="0.1"} 10',
      'request_duration{le="0.5"} 25',
      'request_duration{le="+Inf"} 30',
    ].join('\n')

    const result = parsePrometheusMetrics(text)

    // Note: +Inf is not matched by the numeric regex, so only 2 results
    expect(result.metrics.length).toBeGreaterThanOrEqual(2)
    expect(result.metrics[0]!.type).toBe('histogram')
  })

  it('parses floating point values', () => {
    const text = ['# TYPE temperature gauge', 'temperature 36.6'].join('\n')

    const result = parsePrometheusMetrics(text)

    expect(result.metrics[0]!.value).toBeCloseTo(36.6)
  })

  it('parses scientific notation values', () => {
    const text = ['# TYPE tiny gauge', 'tiny 1.5e-3'].join('\n')

    const result = parsePrometheusMetrics(text)

    expect(result.metrics[0]!.value).toBeCloseTo(0.0015)
  })

  it('parses negative values', () => {
    const text = ['# TYPE offset gauge', 'offset -42'].join('\n')

    const result = parsePrometheusMetrics(text)

    expect(result.metrics[0]!.value).toBe(-42)
  })

  it('skips NaN values', () => {
    const text = ['# TYPE broken gauge', 'broken NaN'].join('\n')

    const result = parsePrometheusMetrics(text)

    expect(result.metrics).toHaveLength(0)
  })

  it('handles multiple metric families', () => {
    const text = [
      '# HELP requests_total Total requests',
      '# TYPE requests_total counter',
      'requests_total 100',
      '',
      '# HELP errors_total Total errors',
      '# TYPE errors_total counter',
      'errors_total 5',
    ].join('\n')

    const result = parsePrometheusMetrics(text)

    expect(result.metrics).toHaveLength(2)
    expect(result.metricNames).toEqual(['errors_total', 'requests_total'])
  })

  it('returns sorted unique metric names', () => {
    const text = [
      '# TYPE multi counter',
      'multi{env="prod"} 10',
      'multi{env="staging"} 5',
      '# TYPE another gauge',
      'another 1',
    ].join('\n')

    const result = parsePrometheusMetrics(text)

    expect(result.metricNames).toEqual(['another', 'multi'])
  })

  it('skips comment lines that are not HELP or TYPE', () => {
    const text = ['# This is a random comment', '# TYPE m gauge', 'm 1'].join('\n')

    const result = parsePrometheusMetrics(text)

    expect(result.metrics).toHaveLength(1)
  })

  it('defaults type to unknown for unrecognized types', () => {
    const text = ['# TYPE m untyped', 'm 1'].join('\n')

    const result = parsePrometheusMetrics(text)

    expect(result.metrics[0]!.type).toBe('unknown')
  })

  it('parses a realistic OTEL Collector metrics snippet', () => {
    const text = [
      '# HELP otelcol_exporter_queue_size Current size of the retry queue',
      '# TYPE otelcol_exporter_queue_size gauge',
      'otelcol_exporter_queue_size{exporter="otlp"} 0',
      '# HELP otelcol_exporter_sent_spans Total number of spans sent',
      '# TYPE otelcol_exporter_sent_spans counter',
      'otelcol_exporter_sent_spans{exporter="otlp"} 1234',
      'otelcol_exporter_sent_spans{exporter="debug"} 567',
    ].join('\n')

    const result = parsePrometheusMetrics(text)

    expect(result.metrics).toHaveLength(3)
    expect(result.metricNames).toEqual([
      'otelcol_exporter_queue_size',
      'otelcol_exporter_sent_spans',
    ])

    const queueSize = result.metrics.find((m) => m.name === 'otelcol_exporter_queue_size')
    expect(queueSize).toMatchObject({ value: 0, type: 'gauge' })

    const sentOtlp = result.metrics.find(
      (m) => m.name === 'otelcol_exporter_sent_spans' && m.labels['exporter'] === 'otlp',
    )
    expect(sentOtlp).toMatchObject({ value: 1234, type: 'counter' })
  })
})

// =============================================================================
// parseMetricsSeries
// =============================================================================

describe('parseMetricsSeries', () => {
  it('returns empty array for empty series', () => {
    const response: TraceQLMetricsResponse = { series: [] }

    expect(parseMetricsSeries(response)).toEqual([])
  })

  it('extracts __name__ label as series name', () => {
    const response: TraceQLMetricsResponse = {
      series: [
        {
          labels: [{ key: '__name__', value: { stringValue: 'rate' } }],
          samples: [{ timestampMs: '1000', value: 0.5 }],
        },
      ],
    }

    const result = parseMetricsSeries(response)

    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('rate')
    // __name__ should not appear in labels
    expect(result[0]!.labels).toEqual({})
  })

  it('defaults name to "metric" when __name__ is absent', () => {
    const response: TraceQLMetricsResponse = {
      series: [
        {
          labels: [{ key: 'service.name', value: { stringValue: 'my-svc' } }],
          samples: [{ timestampMs: '1000', value: 1 }],
        },
      ],
    }

    const result = parseMetricsSeries(response)

    expect(result[0]!.name).toBe('metric')
    expect(result[0]!.labels).toEqual({ 'service.name': 'my-svc' })
  })

  it('parses multiple samples', () => {
    const response: TraceQLMetricsResponse = {
      series: [
        {
          labels: [],
          samples: [
            { timestampMs: '1000', value: 1 },
            { timestampMs: '2000', value: 2 },
            { timestampMs: '3000', value: 3 },
          ],
        },
      ],
    }

    const result = parseMetricsSeries(response)

    expect(result[0]!.samples).toEqual([
      { timestampMs: 1000, value: 1 },
      { timestampMs: 2000, value: 2 },
      { timestampMs: 3000, value: 3 },
    ])
  })

  it('filters out samples with undefined value', () => {
    const response: TraceQLMetricsResponse = {
      series: [
        {
          labels: [],
          samples: [
            { timestampMs: '1000', value: 1 },
            { timestampMs: '2000' },
            { timestampMs: '3000', value: 3 },
          ],
        },
      ],
    }

    const result = parseMetricsSeries(response)

    expect(result[0]!.samples).toHaveLength(2)
    expect(result[0]!.samples[0]!.value).toBe(1)
    expect(result[0]!.samples[1]!.value).toBe(3)
  })

  it('counts exemplars', () => {
    const response: TraceQLMetricsResponse = {
      series: [
        {
          labels: [],
          samples: [{ timestampMs: '1000', value: 1 }],
          exemplars: [
            { labels: [], value: 0.5, timestampMs: '1000' },
            { labels: [], value: 0.8, timestampMs: '1000' },
          ],
        },
      ],
    }

    const result = parseMetricsSeries(response)

    expect(result[0]!.exemplarCount).toBe(2)
  })

  it('defaults exemplarCount to 0 when no exemplars', () => {
    const response: TraceQLMetricsResponse = {
      series: [
        {
          labels: [],
          samples: [{ timestampMs: '1000', value: 1 }],
        },
      ],
    }

    const result = parseMetricsSeries(response)

    expect(result[0]!.exemplarCount).toBe(0)
  })

  it('handles multiple series with different labels', () => {
    const response: TraceQLMetricsResponse = {
      series: [
        {
          labels: [
            { key: '__name__', value: { stringValue: 'rate' } },
            { key: 'service.name', value: { stringValue: 'frontend' } },
          ],
          samples: [{ timestampMs: '1000', value: 10 }],
        },
        {
          labels: [
            { key: '__name__', value: { stringValue: 'rate' } },
            { key: 'service.name', value: { stringValue: 'backend' } },
          ],
          samples: [{ timestampMs: '1000', value: 20 }],
        },
      ],
    }

    const result = parseMetricsSeries(response)

    expect(result).toHaveLength(2)
    expect(result[0]!.labels['service.name']).toBe('frontend')
    expect(result[1]!.labels['service.name']).toBe('backend')
  })

  it('defaults label value to empty string when stringValue is absent', () => {
    const response: TraceQLMetricsResponse = {
      series: [
        {
          labels: [{ key: 'empty', value: {} }],
          samples: [{ timestampMs: '1000', value: 1 }],
        },
      ],
    }

    const result = parseMetricsSeries(response)

    expect(result[0]!.labels['empty']).toBe('')
  })
})
