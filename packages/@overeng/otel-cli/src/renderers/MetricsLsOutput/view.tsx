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
          {'NAME'.padEnd(50)}
        </Text>
        <Text color="gray" bold>
          {'TYPE'.padEnd(12)}
        </Text>
        <Text color="gray" bold>
          {'VALUE'.padStart(15)}
        </Text>
      </Box>
      {/* Data rows */}
      {state.metrics.slice(0, 30).map((metric: MetricSummary, idx: number) => (
        <MetricRow key={`${metric.name}-${String(idx)}`} metric={metric} />
      ))}
      {state.metrics.length > 30 ? (
        <Text color="gray">... and {String(state.metrics.length - 30)} more</Text>
      ) : null}
    </Box>
  )
}

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
      <Text color="yellow">{displayName.slice(0, 48).padEnd(50)}</Text>
      <Text color="green">{metric.type.padEnd(12)}</Text>
      <Text color="white">{formatValue(metric.value).padStart(15)}</Text>
    </Box>
  )
}

// =============================================================================
// Helpers
// =============================================================================

/** Format a metric value for display. */
const formatValue = (value: number): string => {
  if (value === 0) return '0'
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(2)}K`
  if (Math.abs(value) < 0.01) return value.toExponential(2)
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(2)
}
