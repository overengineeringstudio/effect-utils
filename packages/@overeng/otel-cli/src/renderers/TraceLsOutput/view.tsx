/**
 * TraceLs TUI view
 *
 * Renders a tabular list of recent traces.
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { LsState, TraceSummary } from './schema.ts'

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

/** Root view for trace listing. */
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

  if (state.traces.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No traces found</Text>
        {state.query !== undefined ? <Text color="gray">Query: {state.query}</Text> : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="cyan" bold>
          Traces
        </Text>
        <Text color="gray">
          {' '}
          ({String(state.traces.length)}
          {state.query !== undefined ? `, query: ${state.query}` : ''})
        </Text>
      </Box>
      <Text> </Text>
      {/* Header row */}
      <Box flexDirection="row">
        <Text color="gray" bold>
          {'TRACE ID'.padEnd(34)}
        </Text>
        <Text color="gray" bold>
          {'SERVICE'.padEnd(20)}
        </Text>
        <Text color="gray" bold>
          {'SPAN'.padEnd(24)}
        </Text>
        <Text color="gray" bold>
          {'DURATION'.padStart(10)}
        </Text>
      </Box>
      {/* Data rows */}
      {state.traces.map((trace: TraceSummary) => (
        <TraceRow key={trace.traceId} trace={trace} />
      ))}
    </Box>
  )
}

// =============================================================================
// Internal Components
// =============================================================================

const TraceRow = ({ trace }: { readonly trace: TraceSummary }) => (
  <Box flexDirection="row">
    <Text color="yellow">{trace.traceId.slice(0, 32).padEnd(34)}</Text>
    <Text color="green">{trace.serviceName.slice(0, 18).padEnd(20)}</Text>
    <Text>{trace.spanName.slice(0, 22).padEnd(24)}</Text>
    <Text color="gray">{formatDuration(trace.durationMs).padStart(10)}</Text>
  </Box>
)

// =============================================================================
// Helpers
// =============================================================================

/** Format a duration in milliseconds to a human-readable string. */
const formatDuration = (ms: number): string => {
  if (ms < 1) return `${String(Math.round(ms * 1000))}µs`
  if (ms < 1000) return `${String(Math.round(ms))}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}
