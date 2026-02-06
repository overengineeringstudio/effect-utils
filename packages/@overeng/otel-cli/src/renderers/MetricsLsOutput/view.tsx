/**
 * MetricsLs TUI view
 *
 * Renders a list of available metrics from the OTEL collector or Tempo.
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { LsState, MetricSummary } from './schema.ts'

// =============================================================================
// Props
// =============================================================================

/** Props for the LsView component. */
export interface LsViewProps {
  /** State atom from the TUI app. */
  readonly stateAtom: Atom.Atom<LsState>
}

// =============================================================================
// Main View
// =============================================================================

/** Root view for metrics listing. */
export const LsView = ({ stateAtom }: LsViewProps) => {
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

  if (state.metrics.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No metrics found</Text>
        {state.filter !== undefined ? <Text color="gray">Filter: {state.filter}</Text> : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="cyan" bold>
          {state.source === 'collector' ? 'Collector Metrics' : 'Tempo Tags'}
        </Text>
        <Text color="gray">
          {' '}
          ({String(state.metrics.length)} metrics
          {state.filter !== undefined ? `, filter: ${state.filter}` : ''})
        </Text>
      </Box>
      <Text> </Text>
      {/* Header row */}
      <Box flexDirection="row">
        <Text color="gray" bold>
          {'NAME'.padEnd(METRIC_NAME_COLUMN_WIDTH)}
        </Text>
        <Text color="gray" bold>
          {'TYPE'.padEnd(METRIC_TYPE_COLUMN_WIDTH)}
        </Text>
        <Text color="gray" bold>
          {'VALUE'.padStart(METRIC_VALUE_COLUMN_WIDTH)}
        </Text>
      </Box>
      {/* Data rows */}
      {state.metrics.slice(0, MAX_METRICS_DISPLAY).map((metric: MetricSummary, idx: number) => (
        <MetricRow key={`${metric.name}-${String(idx)}`} metric={metric} />
      ))}
      {state.metrics.length > MAX_METRICS_DISPLAY ? (
        <Text color="gray">... and {String(state.metrics.length - MAX_METRICS_DISPLAY)} more</Text>
      ) : null}
    </Box>
  )
}

// =============================================================================
// Constants
// =============================================================================

// Column widths for table layout
const METRIC_NAME_COLUMN_WIDTH = 50
const METRIC_TYPE_COLUMN_WIDTH = 12
const METRIC_VALUE_COLUMN_WIDTH = 15

// Display limits
const MAX_METRICS_DISPLAY = 30
const METRIC_NAME_TRUNCATE_LENGTH = 48

// Value formatting thresholds
const VALUE_BILLION = 1e9
const VALUE_MILLION = 1e6
const VALUE_THOUSAND = 1e3
const VALUE_SMALL_THRESHOLD = 0.01

// =============================================================================
// Internal Components
// =============================================================================

const MetricRow = ({ metric }: { readonly metric: MetricSummary }) => {
  const labelStr = Object.entries(metric.labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
  const displayName = labelStr ? `${metric.name}{${labelStr}}` : metric.name

  return (
    <Box flexDirection="row">
      <Text color="yellow">
        {displayName.slice(0, METRIC_NAME_TRUNCATE_LENGTH).padEnd(METRIC_NAME_COLUMN_WIDTH)}
      </Text>
      <Text color="green">{metric.type.padEnd(METRIC_TYPE_COLUMN_WIDTH)}</Text>
      <Text color="white">{formatValue(metric.value).padStart(METRIC_VALUE_COLUMN_WIDTH)}</Text>
    </Box>
  )
}

// =============================================================================
// Helpers
// =============================================================================

/** Format a metric value for display. */
const formatValue = (value: number): string => {
  if (value === 0) return '0'
  if (Math.abs(value) >= VALUE_BILLION) return `${(value / VALUE_BILLION).toFixed(2)}B`
  if (Math.abs(value) >= VALUE_MILLION) return `${(value / VALUE_MILLION).toFixed(2)}M`
  if (Math.abs(value) >= VALUE_THOUSAND) return `${(value / VALUE_THOUSAND).toFixed(2)}K`
  if (Math.abs(value) < VALUE_SMALL_THRESHOLD) return value.toExponential(2)
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(2)
}
