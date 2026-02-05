/**
 * MetricsQuery TUI view
 *
 * Renders TraceQL metrics query results with sparklines.
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { DataPoint, MetricSeries, QueryState } from './schema.ts'

// =============================================================================
// Props
// =============================================================================

/** Props for the QueryView component. */
export interface QueryViewProps {
  /** State atom from the TUI app. */
  readonly stateAtom: Atom.Atom<QueryState>
}

// =============================================================================
// Main View
// =============================================================================

/** Root view for metrics query results. */
export const QueryView = ({ stateAtom }: QueryViewProps) => {
  const state = useTuiAtomValue(stateAtom)
  const symbols = useSymbols()

  if (state._tag === 'Loading') {
    return (
      <Box flexDirection="row">
        <Text color="blue">{symbols.status.circle}</Text>
        <Text> {state.message}</Text>
      </Box>
    )
  }

  if (state._tag === 'Error') {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color="red">{symbols.status.cross}</Text>
          <Text color="red" bold>
            {' '}
            Error: {state.error}
          </Text>
        </Box>
        <Text color="gray">{state.message}</Text>
      </Box>
    )
  }

  if (state.series.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No data returned</Text>
        <Text color="gray">Query: {state.query}</Text>
      </Box>
    )
  }

  const timeRange = formatTimeRange({ start: state.startTime, end: state.endTime })

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="cyan" bold>
          Metrics Query Results
        </Text>
        <Text color="gray">
          {' '}
          ({String(state.series.length)} series, {timeRange})
        </Text>
      </Box>
      <Text color="gray">Query: {state.query}</Text>
      <Text> </Text>
      {state.series.map((series, idx) => (
        <SeriesView key={`${series.name}-${String(idx)}`} series={series} />
      ))}
    </Box>
  )
}

// =============================================================================
// Internal Components
// =============================================================================

const SeriesView = ({ series }: { readonly series: MetricSeries }) => {
  const labelStr = Object.entries(series.labels)
    .filter(([k]) => k !== '__name__')
    .map(([k, v]) => `${k}=${v}`)
    .join(', ')

  const stats = computeStats(series.samples)
  const sparkline = generateSparkline({ samples: series.samples, width: 30 })

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row">
        <Text color="yellow" bold>
          {series.name}
        </Text>
        {labelStr ? <Text color="gray"> {`{${labelStr}}`}</Text> : null}
      </Box>
      <Box flexDirection="row">
        <Text color="gray"> min: </Text>
        <Text color="white">{formatValue(stats.min)}</Text>
        <Text color="gray"> max: </Text>
        <Text color="white">{formatValue(stats.max)}</Text>
        <Text color="gray"> avg: </Text>
        <Text color="white">{formatValue(stats.avg)}</Text>
        <Text color="gray"> current: </Text>
        <Text color="cyan">{formatValue(stats.current)}</Text>
      </Box>
      <Box flexDirection="row">
        <Text color="gray"> </Text>
        <Text color="green">{sparkline}</Text>
        <Text color="gray"> ({String(series.samples.length)} samples)</Text>
      </Box>
    </Box>
  )
}

// =============================================================================
// Helpers
// =============================================================================

interface Stats {
  min: number
  max: number
  avg: number
  current: number
}

const computeStats = (samples: ReadonlyArray<DataPoint>): Stats => {
  if (samples.length === 0) {
    return { min: 0, max: 0, avg: 0, current: 0 }
  }

  let min = Infinity
  let max = -Infinity
  let sum = 0

  for (const s of samples) {
    if (s.value < min) min = s.value
    if (s.value > max) max = s.value
    sum += s.value
  }

  return {
    min,
    max,
    avg: sum / samples.length,
    current: samples[samples.length - 1]?.value ?? 0,
  }
}

/** Generate a sparkline from samples. */
const generateSparkline = (options: {
  readonly samples: ReadonlyArray<DataPoint>
  readonly width: number
}): string => {
  if (options.samples.length === 0) return ''

  const chars = '▁▂▃▄▅▆▇█'
  const values = options.samples.map((s) => s.value)

  // Downsample if needed
  const step = Math.max(1, Math.floor(values.length / options.width))
  const downsampled: number[] = []
  for (let i = 0; i < values.length; i += step) {
    const slice = values.slice(i, i + step)
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length
    downsampled.push(avg)
  }

  const min = Math.min(...downsampled)
  const max = Math.max(...downsampled)
  const range = max - min || 1

  return downsampled
    .slice(0, options.width)
    .map((v) => {
      const normalized = (v - min) / range
      const idx = Math.min(chars.length - 1, Math.floor(normalized * (chars.length - 1)))
      return chars[idx]
    })
    .join('')
}

/** Format a metric value for display. */
const formatValue = (value: number): string => {
  if (!Number.isFinite(value)) return 'N/A'
  if (value === 0) return '0'
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(2)}K`
  if (Math.abs(value) < 0.01) return value.toExponential(2)
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(2)
}

/** Format a time range for display. */
const formatTimeRange = (options: { readonly start: number; readonly end: number }): string => {
  const duration = options.end - options.start
  if (duration < 3600) return `${Math.round(duration / 60)}m`
  if (duration < 86400) return `${(duration / 3600).toFixed(1)}h`
  return `${(duration / 86400).toFixed(1)}d`
}
