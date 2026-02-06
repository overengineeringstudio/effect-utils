/**
 * Span tree builder
 *
 * Converts a flat Tempo trace response into a hierarchical span tree
 * suitable for rendering as an ASCII waterfall.
 */

import type { ProcessedSpan } from '../renderers/TraceInspectOutput/schema.ts'
import type { TempoTraceResponse } from '../services/TempoClient.ts'

// =============================================================================
// Constants
// =============================================================================

/** Conversion factor from nanoseconds to milliseconds. */
const NANOSECONDS_TO_MILLISECONDS = 1_000_000n

// =============================================================================
// Types
// =============================================================================

/** Intermediate flat span used during tree construction. */
interface FlatSpan {
  readonly spanId: string
  readonly parentSpanId: string | undefined
  readonly name: string
  readonly serviceName: string
  readonly startTimeMs: number
  readonly endTimeMs: number
  readonly durationMs: number
  readonly statusCode: number | undefined
  readonly statusMessage: string | undefined
  readonly attributes: ReadonlyArray<{ readonly key: string; readonly value: string }>
}

/** Result of building a span tree. */
export interface SpanTreeResult {
  readonly rootSpans: ReadonlyArray<ProcessedSpan>
  readonly totalSpanCount: number
  readonly traceStartMs: number
  readonly traceEndMs: number
  readonly traceDurationMs: number
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Build a span tree from a Tempo trace response.
 *
 * Extracts spans from the response (handling both `batches` and `resourceSpans` formats),
 * organizes them into a parent-child tree, and computes timing offsets.
 */
export const buildSpanTree = (args: {
  readonly response: TempoTraceResponse
  readonly spanId?: string | undefined
}): SpanTreeResult => {
  const { response } = args
  const flatSpans = extractFlatSpans(response)

  if (flatSpans.length === 0) {
    return {
      rootSpans: [],
      totalSpanCount: 0,
      traceStartMs: 0,
      traceEndMs: 0,
      traceDurationMs: 0,
    }
  }

  // Build parent-child map
  const childrenMap = new Map<string, Array<FlatSpan>>()
  const spanMap = new Map<string, FlatSpan>()

  for (const span of flatSpans) {
    spanMap.set(span.spanId, span)
    const parentId = span.parentSpanId ?? '__root__'
    const siblings = childrenMap.get(parentId)
    if (siblings !== undefined) {
      siblings.push(span)
    } else {
      childrenMap.set(parentId, [span])
    }
  }

  // Find root spans (no parent or parent not in trace)
  let rootFlatSpans: Array<FlatSpan>
  if (args.spanId !== undefined) {
    // Focus on a specific span as root
    const focusSpan = spanMap.get(args.spanId)
    rootFlatSpans = focusSpan !== undefined ? [focusSpan] : []
  } else {
    rootFlatSpans = flatSpans.filter(
      (s) => s.parentSpanId === undefined || !spanMap.has(s.parentSpanId),
    )
  }

  // Sort roots by start time
  rootFlatSpans.sort((a, b) => a.startTimeMs - b.startTimeMs)

  // Build tree recursively
  const buildNode = (args: { flat: FlatSpan; depth: number }): ProcessedSpan => {
    const children = (childrenMap.get(args.flat.spanId) ?? [])
      .toSorted((a, b) => a.startTimeMs - b.startTimeMs)
      .map((child) => buildNode({ flat: child, depth: args.depth + 1 }))

    return {
      spanId: args.flat.spanId,
      parentSpanId: args.flat.parentSpanId,
      name: args.flat.name,
      serviceName: args.flat.serviceName,
      startTimeMs: args.flat.startTimeMs,
      endTimeMs: args.flat.endTimeMs,
      durationMs: args.flat.durationMs,
      statusCode: args.flat.statusCode,
      statusMessage: args.flat.statusMessage,
      attributes: [...args.flat.attributes],
      depth: args.depth,
      children,
    }
  }

  const rootSpans = rootFlatSpans.map((s) => buildNode({ flat: s, depth: 0 }))

  // Compute trace-level timing
  const traceStartMs = Math.min(...flatSpans.map((s) => s.startTimeMs))
  const traceEndMs = Math.max(...flatSpans.map((s) => s.endTimeMs))

  return {
    rootSpans,
    totalSpanCount: flatSpans.length,
    traceStartMs,
    traceEndMs,
    traceDurationMs: traceEndMs - traceStartMs,
  }
}

// =============================================================================
// Internal
// =============================================================================

/** Extract flat spans from a Tempo trace response. */
const extractFlatSpans = (response: TempoTraceResponse): Array<FlatSpan> => {
  const results: Array<FlatSpan> = []
  // Tempo can return either `batches` (older format) or `resourceSpans` (OTLP format)
  const resourceSpans = response.resourceSpans ?? response.batches ?? []

  for (const rs of resourceSpans) {
    const serviceName = extractServiceName(rs.resource?.attributes)

    for (const ss of rs.scopeSpans) {
      for (const span of ss.spans) {
        const startNano = BigInt(span.startTimeUnixNano)
        const endNano = BigInt(span.endTimeUnixNano)
        const startTimeMs = Number(startNano / NANOSECONDS_TO_MILLISECONDS)
        const endTimeMs = Number(endNano / NANOSECONDS_TO_MILLISECONDS)

        results.push({
          spanId: span.spanId,
          parentSpanId: span.parentSpanId,
          name: span.name,
          serviceName,
          startTimeMs,
          endTimeMs,
          durationMs: endTimeMs - startTimeMs,
          statusCode: normalizeStatusCode(span.status?.code),
          statusMessage: span.status?.message,
          attributes: (span.attributes ?? []).map((attr) => ({
            key: attr.key,
            value: extractAttributeValue(attr.value),
          })),
        })
      }
    }
  }

  return results
}

/** Extract service name from resource attributes. */
const extractServiceName = (
  attributes:
    | ReadonlyArray<{ key: string; value: { stringValue?: string | undefined } }>
    | undefined,
): string => {
  if (attributes === undefined) return 'unknown'
  const attr = attributes.find((a) => a.key === 'service.name')
  return attr?.value.stringValue ?? 'unknown'
}

/** Extract a string value from a span attribute value. */
const extractAttributeValue = (value: {
  stringValue?: string | undefined
  intValue?: string | number | undefined
  boolValue?: boolean | undefined
}): string => {
  if (value.stringValue !== undefined) return value.stringValue
  if (value.intValue !== undefined) return String(value.intValue)
  if (value.boolValue !== undefined) return String(value.boolValue)
  return ''
}

/** Convert OTEL status code to a number.
 * Tempo returns status.code as either:
 * - A string enum: "STATUS_CODE_UNSET" | "STATUS_CODE_OK" | "STATUS_CODE_ERROR"
 * - A number: 0 | 1 | 2
 */
const normalizeStatusCode = (code: string | number | undefined): number | undefined => {
  if (code === undefined) return undefined
  if (typeof code === 'number') return code
  switch (code) {
    case 'STATUS_CODE_UNSET':
      return 0
    case 'STATUS_CODE_OK':
      return 1
    case 'STATUS_CODE_ERROR':
      return 2
    default:
      return undefined
  }
}
