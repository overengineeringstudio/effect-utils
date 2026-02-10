/**
 * TraceLs TUI view
 *
 * Renders a tabular list of recent traces.
 */

import type { Atom } from '@effect-atom/atom'
import { DateTime } from 'effect'
import React from 'react'

import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import { buildGrafanaTraceUrl } from '../../services/GrafanaClient.ts'
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
          {'TRACE ID'.padEnd(TRACE_ID_COLUMN_WIDTH)}
        </Text>
        <Text color="gray" bold>
          {'SERVICE'.padEnd(SERVICE_COLUMN_WIDTH)}
        </Text>
        <Text color="gray" bold>
          {'SPAN'.padEnd(SPAN_NAME_COLUMN_WIDTH)}
        </Text>
        <Text color="gray" bold>
          {'TIME'.padStart(TIME_COLUMN_WIDTH)}
        </Text>
        <Text color="gray" bold>
          {'DURATION'.padStart(DURATION_COLUMN_WIDTH)}
        </Text>
      </Box>
      {/* Data rows */}
      {state.traces.map((trace: TraceSummary) => (
        <TraceRow key={trace.traceId} trace={trace} grafanaUrl={state.grafanaUrl} />
      ))}
    </Box>
  )
}

// =============================================================================
// Constants
// =============================================================================

// Column widths for table layout
const TRACE_ID_COLUMN_WIDTH = 34
const SERVICE_COLUMN_WIDTH = 20
const SPAN_NAME_COLUMN_WIDTH = 24
const TIME_COLUMN_WIDTH = 10
const DURATION_COLUMN_WIDTH = 10

// String truncation lengths (2 chars less than column width for spacing)
const TRACE_ID_TRUNCATE_LENGTH = 32
const SERVICE_TRUNCATE_LENGTH = 18
const SPAN_NAME_TRUNCATE_LENGTH = 22

// Relative time thresholds
const SECONDS_PER_MINUTE = 60_000
const MINUTES_PER_HOUR = 3_600_000
const HOURS_PER_DAY = 86_400_000

// Duration formatting thresholds
const MILLISECOND_THRESHOLD = 1
const MICROSECONDS_PER_MILLISECOND = 1000
const MILLISECONDS_PER_SECOND = 1000
const MILLISECONDS_PER_MINUTE = 60000

// =============================================================================
// Internal Components
// =============================================================================

const TraceRow = ({
  trace,
  grafanaUrl,
}: {
  readonly trace: TraceSummary
  readonly grafanaUrl: string
}) => (
  <Box flexDirection="row">
    <Text color="yellow" href={buildGrafanaTraceUrl({ grafanaUrl, traceId: trace.traceId })}>
      {trace.traceId.slice(0, TRACE_ID_TRUNCATE_LENGTH)}
    </Text>
    <Text>
      {' '.repeat(TRACE_ID_COLUMN_WIDTH - Math.min(trace.traceId.length, TRACE_ID_TRUNCATE_LENGTH))}
    </Text>
    <Text color="green">
      {trace.serviceName.slice(0, SERVICE_TRUNCATE_LENGTH).padEnd(SERVICE_COLUMN_WIDTH)}
    </Text>
    <Text>{trace.spanName.slice(0, SPAN_NAME_TRUNCATE_LENGTH).padEnd(SPAN_NAME_COLUMN_WIDTH)}</Text>
    <Text color="gray">{formatRelativeTime(trace.startTime).padStart(TIME_COLUMN_WIDTH)}</Text>
    <Text color="gray">{formatDuration(trace.durationMs).padStart(DURATION_COLUMN_WIDTH)}</Text>
  </Box>
)

// =============================================================================
// Helpers
// =============================================================================

/** Format a DateTime.Utc as relative time (e.g. "2m ago", "1h ago"). */
const formatRelativeTime = (startTime: DateTime.Utc): string => {
  const diffMs = Date.now() - DateTime.toEpochMillis(startTime)
  if (diffMs < SECONDS_PER_MINUTE) return `${String(Math.round(diffMs / 1_000))}s ago`
  if (diffMs < MINUTES_PER_HOUR) return `${String(Math.round(diffMs / 60_000))}m ago`
  if (diffMs < HOURS_PER_DAY) return `${String(Math.round(diffMs / 3_600_000))}h ago`
  return `${String(Math.round(diffMs / 86_400_000))}d ago`
}

/** Format a duration in milliseconds to a human-readable string. */
const formatDuration = (ms: number): string => {
  if (ms < MILLISECOND_THRESHOLD)
    return `${String(Math.round(ms * MICROSECONDS_PER_MILLISECOND))}µs`
  if (ms < MILLISECONDS_PER_SECOND) return `${String(Math.round(ms))}ms`
  if (ms < MILLISECONDS_PER_MINUTE) return `${(ms / MILLISECONDS_PER_SECOND).toFixed(1)}s`
  return `${(ms / MILLISECONDS_PER_MINUTE).toFixed(1)}m`
}
