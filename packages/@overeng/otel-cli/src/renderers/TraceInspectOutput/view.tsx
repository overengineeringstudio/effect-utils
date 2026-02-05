/**
 * TraceInspect TUI view
 *
 * Renders a trace as an ASCII span tree with waterfall timing bars.
 * Shows hierarchical parent-child relationships and timing alignment.
 */

import type { Atom } from '@effect-atom/atom'
import React from 'react'

import type { ColorName } from '@overeng/tui-core'
import { Box, Text, useTuiAtomValue, useSymbols } from '@overeng/tui-react'

import type { InspectState, ProcessedSpan } from './schema.ts'

// =============================================================================
// Props
// =============================================================================

/** Props for the InspectView component. */
export interface InspectViewProps {
  /** State atom from the TUI app. */
  readonly stateAtom: Atom.Atom<InspectState>
}

// =============================================================================
// Main View
// =============================================================================

/** Root view for trace inspection. */
export const InspectView = ({ stateAtom }: InspectViewProps) => {
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

  return (
    <Box flexDirection="column">
      <TraceHeader
        traceId={state.traceId}
        totalSpanCount={state.totalSpanCount}
        traceDurationMs={state.traceDurationMs}
      />
      <Text> </Text>
      {state.flat ? (
        <FlatSpanList
          rootSpans={state.rootSpans}
          traceStartMs={state.traceStartMs}
          traceDurationMs={state.traceDurationMs}
        />
      ) : (
        <SpanTree
          rootSpans={state.rootSpans}
          traceStartMs={state.traceStartMs}
          traceDurationMs={state.traceDurationMs}
        />
      )}
    </Box>
  )
}

// =============================================================================
// Constants
// =============================================================================

const WATERFALL_WIDTH = 40
const INDENT_SIZE = 2

// =============================================================================
// Header
// =============================================================================

const TraceHeader = ({
  traceId,
  totalSpanCount,
  traceDurationMs,
}: {
  readonly traceId: string
  readonly totalSpanCount: number
  readonly traceDurationMs: number
}) => (
  <Box flexDirection="column">
    <Box flexDirection="row">
      <Text color="cyan" bold>
        Trace{' '}
      </Text>
      <Text color="yellow">{traceId}</Text>
    </Box>
    <Box flexDirection="row">
      <Text color="gray">
        {String(totalSpanCount)} spans · {formatDuration(traceDurationMs)}
      </Text>
    </Box>
  </Box>
)

// =============================================================================
// Span Tree (hierarchical view)
// =============================================================================

const SpanTree = ({
  rootSpans,
  traceStartMs,
  traceDurationMs,
}: {
  readonly rootSpans: ReadonlyArray<ProcessedSpan>
  readonly traceStartMs: number
  readonly traceDurationMs: number
}) => (
  <Box flexDirection="column">
    {rootSpans.map((span: ProcessedSpan) => (
      <SpanNode
        key={span.spanId}
        span={span}
        traceStartMs={traceStartMs}
        traceDurationMs={traceDurationMs}
        isLast={false}
        prefix=""
      />
    ))}
  </Box>
)

const SpanNode = ({
  span,
  traceStartMs,
  traceDurationMs,
  isLast,
  prefix,
}: {
  readonly span: ProcessedSpan
  readonly traceStartMs: number
  readonly traceDurationMs: number
  readonly isLast: boolean
  readonly prefix: string
}) => {
  const connector = span.depth === 0 ? '' : isLast ? '└─ ' : '├─ '
  const childPrefix = span.depth === 0 ? '' : prefix + (isLast ? '   ' : '│  ')
  const statusColor = getStatusColor(span.statusCode)

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color="gray">
          {prefix}
          {connector}
        </Text>
        <Text color={statusColor} bold>
          {span.serviceName}
        </Text>
        <Text color="gray"> / </Text>
        <Text>{span.name}</Text>
        <Text color="gray"> ({formatDuration(span.durationMs)})</Text>
        <Text> </Text>
        <WaterfallBar
          startMs={span.startTimeMs}
          durationMs={span.durationMs}
          traceStartMs={traceStartMs}
          traceDurationMs={traceDurationMs}
        />
      </Box>
      {span.children.map((child: ProcessedSpan, i: number) => (
        <SpanNode
          key={child.spanId}
          span={child}
          traceStartMs={traceStartMs}
          traceDurationMs={traceDurationMs}
          isLast={i === span.children.length - 1}
          prefix={childPrefix}
        />
      ))}
    </Box>
  )
}

// =============================================================================
// Flat Span List
// =============================================================================

const FlatSpanList = ({
  rootSpans,
  traceStartMs,
  traceDurationMs,
}: {
  readonly rootSpans: ReadonlyArray<ProcessedSpan>
  readonly traceStartMs: number
  readonly traceDurationMs: number
}) => {
  const allSpans = flattenSpans(rootSpans)
  // Sort by start time
  const sorted = [...allSpans].toSorted((a, b) => a.startTimeMs - b.startTimeMs)

  return (
    <Box flexDirection="column">
      {sorted.map((span: ProcessedSpan) => {
        const indent = ' '.repeat(span.depth * INDENT_SIZE)
        const statusColor = getStatusColor(span.statusCode)

        return (
          <Box key={span.spanId} flexDirection="row">
            <Text color="gray">{indent}</Text>
            <Text color={statusColor} bold>
              {span.serviceName}
            </Text>
            <Text color="gray"> / </Text>
            <Text>{span.name}</Text>
            <Text color="gray"> ({formatDuration(span.durationMs)})</Text>
            <Text> </Text>
            <WaterfallBar
              startMs={span.startTimeMs}
              durationMs={span.durationMs}
              traceStartMs={traceStartMs}
              traceDurationMs={traceDurationMs}
            />
          </Box>
        )
      })}
    </Box>
  )
}

// =============================================================================
// Waterfall Bar
// =============================================================================

const WaterfallBar = ({
  startMs,
  durationMs,
  traceStartMs,
  traceDurationMs,
}: {
  readonly startMs: number
  readonly durationMs: number
  readonly traceStartMs: number
  readonly traceDurationMs: number
}) => {
  if (traceDurationMs === 0) {
    return <Text color="cyan">{'█'}</Text>
  }

  const offsetRatio = (startMs - traceStartMs) / traceDurationMs
  const widthRatio = durationMs / traceDurationMs

  const offsetChars = Math.round(offsetRatio * WATERFALL_WIDTH)
  const barChars = Math.max(1, Math.round(widthRatio * WATERFALL_WIDTH))

  const padding = ' '.repeat(Math.max(0, offsetChars))
  const bar = '█'.repeat(barChars)

  return (
    <Text>
      <Text color="gray">{padding}</Text>
      <Text color="cyan">{bar}</Text>
    </Text>
  )
}

// =============================================================================
// Helpers
// =============================================================================

/** Get color based on span status code. */
const getStatusColor = (statusCode: number | undefined): ColorName => {
  if (statusCode === 2) return 'red' // ERROR
  if (statusCode === 1) return 'green' // OK
  return 'white' // UNSET
}

/** Format a duration in milliseconds to a human-readable string. */
const formatDuration = (ms: number): string => {
  if (ms < 1) return `${String(Math.round(ms * 1000))}µs`
  if (ms < 1000) return `${String(Math.round(ms))}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

/** Flatten a span tree into a flat list preserving depth. */
const flattenSpans = (spans: ReadonlyArray<ProcessedSpan>): ReadonlyArray<ProcessedSpan> => {
  const result: Array<ProcessedSpan> = []
  const visit = (span: ProcessedSpan) => {
    result.push(span)
    for (const child of span.children) {
      visit(child as ProcessedSpan)
    }
  }
  for (const span of spans) {
    visit(span)
  }
  return result
}
