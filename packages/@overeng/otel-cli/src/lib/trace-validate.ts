/**
 * Trace structure validation
 *
 * Validates structural invariants of a trace: parent-child linkage,
 * orphaned spans, duplicate root spans, and timing consistency.
 *
 * Operates on the raw TempoTraceResponse so it can be used from both
 * the CLI (via Tempo API) and tests (via spool file data).
 */

import type { TempoTraceResponse } from '../services/TempoClient.ts'

// =============================================================================
// Types
// =============================================================================

/** A flat span extracted from the trace response. */
interface FlatSpan {
  readonly spanId: string
  readonly parentSpanId: string | undefined
  readonly name: string
  readonly serviceName: string
  readonly startTimeMs: number
  readonly endTimeMs: number
  readonly durationMs: number
}

/** A single validation finding. */
export interface TraceValidationFinding {
  readonly severity: 'error' | 'warning'
  readonly rule: string
  readonly message: string
  /** spanId(s) involved, if applicable */
  readonly spanIds?: ReadonlyArray<string>
}

/** Result of validating a trace. */
export interface TraceValidationResult {
  readonly valid: boolean
  readonly spanCount: number
  readonly findings: ReadonlyArray<TraceValidationFinding>
}

// =============================================================================
// Constants
// =============================================================================

const NANOSECONDS_TO_MILLISECONDS = 1_000_000n

// =============================================================================
// Public API
// =============================================================================

/** Validate the structural integrity of a trace. */
export const validateTraceStructure = (response: TempoTraceResponse): TraceValidationResult => {
  const flatSpans = extractFlatSpans(response)
  const findings: Array<TraceValidationFinding> = []

  if (flatSpans.length === 0) {
    findings.push({
      severity: 'error',
      rule: 'non-empty',
      message: 'Trace contains no spans',
    })
    return { valid: false, spanCount: 0, findings }
  }

  const spanMap = new Map<string, FlatSpan>()
  for (const span of flatSpans) {
    spanMap.set(span.spanId, span)
  }

  // Rule 1: No duplicate span IDs
  checkDuplicateSpanIds({ spans: flatSpans, findings })

  // Rule 2: Single root span (no parent or parent not in trace)
  const rootSpans = flatSpans.filter(
    (s) => s.parentSpanId === undefined || !spanMap.has(s.parentSpanId),
  )
  checkSingleRoot({ rootSpans, findings })

  // Rule 3: No orphaned spans (parentSpanId references a non-existent span)
  checkOrphanedSpans({ spans: flatSpans, spanMap, findings })

  // Rule 4: No duplicate root-level spans per service
  checkDuplicateServiceRoots({ rootSpans, findings })

  // Rule 5: Parent spans encompass children (timing)
  checkParentEncompassesChildren({ spans: flatSpans, spanMap, findings })

  const valid = findings.every((f) => f.severity !== 'error')
  return { valid, spanCount: flatSpans.length, findings }
}

// =============================================================================
// Validation Rules
// =============================================================================

/** Check for duplicate span IDs within the trace. */
const checkDuplicateSpanIds = ({
  spans,
  findings,
}: {
  spans: ReadonlyArray<FlatSpan>
  findings: Array<TraceValidationFinding>
}): void => {
  const seen = new Map<string, number>()
  for (const span of spans) {
    seen.set(span.spanId, (seen.get(span.spanId) ?? 0) + 1)
  }
  for (const [spanId, count] of seen) {
    if (count > 1) {
      findings.push({
        severity: 'error',
        rule: 'no-duplicate-span-ids',
        message: `Span ID "${spanId}" appears ${String(count)} times`,
        spanIds: [spanId],
      })
    }
  }
}

/** Check that the trace has exactly one root span. */
const checkSingleRoot = ({
  rootSpans,
  findings,
}: {
  rootSpans: ReadonlyArray<FlatSpan>
  findings: Array<TraceValidationFinding>
}): void => {
  if (rootSpans.length === 0) {
    findings.push({
      severity: 'error',
      rule: 'single-root',
      message: 'No root span found (all spans reference a parent)',
    })
  } else if (rootSpans.length > 1) {
    findings.push({
      severity: 'warning',
      rule: 'single-root',
      message: `Found ${String(rootSpans.length)} root spans: ${rootSpans.map((s) => `${s.serviceName}/${s.name} (${s.spanId})`).join(', ')}`,
      spanIds: rootSpans.map((s) => s.spanId),
    })
  }
}

/**
 * Check for orphaned spans whose parentSpanId references a span not in the trace.
 *
 * Spans with no parentSpanId are root spans (not orphaned).
 * Spans whose parentSpanId is in the trace are correctly linked.
 * Spans with a parentSpanId that is NOT in the trace are orphaned.
 */
const checkOrphanedSpans = ({
  spans,
  spanMap,
  findings,
}: {
  spans: ReadonlyArray<FlatSpan>
  spanMap: ReadonlyMap<string, FlatSpan>
  findings: Array<TraceValidationFinding>
}): void => {
  for (const span of spans) {
    if (span.parentSpanId !== undefined && !spanMap.has(span.parentSpanId)) {
      findings.push({
        severity: 'warning',
        rule: 'no-orphaned-spans',
        message: `Span "${span.serviceName}/${span.name}" (${span.spanId}) references parent "${span.parentSpanId}" which is not in the trace`,
        spanIds: [span.spanId],
      })
    }
  }
}

/** Check that no service has multiple root-level spans (potential duplicate subtrees). */
const checkDuplicateServiceRoots = ({
  rootSpans,
  findings,
}: {
  rootSpans: ReadonlyArray<FlatSpan>
  findings: Array<TraceValidationFinding>
}): void => {
  const byService = new Map<string, Array<FlatSpan>>()
  for (const span of rootSpans) {
    const list = byService.get(span.serviceName) ?? []
    list.push(span)
    byService.set(span.serviceName, list)
  }
  for (const [serviceName, spans] of byService) {
    if (spans.length > 1) {
      findings.push({
        severity: 'warning',
        rule: 'no-duplicate-service-roots',
        message: `Service "${serviceName}" has ${String(spans.length)} root-level spans: ${spans.map((s) => `${s.name} (${s.spanId})`).join(', ')}`,
        spanIds: spans.map((s) => s.spanId),
      })
    }
  }
}

/**
 * Check that parent span duration encompasses all children.
 *
 * A parent should start at or before its earliest child and end at or after
 * its latest child. Violations indicate clock skew or incorrect timestamps.
 */
const checkParentEncompassesChildren = ({
  spans,
  spanMap,
  findings,
}: {
  spans: ReadonlyArray<FlatSpan>
  spanMap: ReadonlyMap<string, FlatSpan>
  findings: Array<TraceValidationFinding>
}): void => {
  /** Map of parent spanId to its children. */
  const childrenByParent = new Map<string, Array<FlatSpan>>()
  for (const span of spans) {
    if (span.parentSpanId !== undefined && spanMap.has(span.parentSpanId)) {
      const list = childrenByParent.get(span.parentSpanId) ?? []
      list.push(span)
      childrenByParent.set(span.parentSpanId, list)
    }
  }

  for (const [parentId, children] of childrenByParent) {
    const parent = spanMap.get(parentId)
    if (parent === undefined) continue

    const earliestChildStart = Math.min(...children.map((c) => c.startTimeMs))
    const latestChildEnd = Math.max(...children.map((c) => c.endTimeMs))

    if (parent.startTimeMs > earliestChildStart) {
      findings.push({
        severity: 'warning',
        rule: 'parent-encompasses-children',
        message: `Parent "${parent.serviceName}/${parent.name}" (${parent.spanId}) starts at ${String(parent.startTimeMs)}ms but has a child starting at ${String(earliestChildStart)}ms`,
        spanIds: [parent.spanId],
      })
    }

    if (parent.endTimeMs < latestChildEnd) {
      findings.push({
        severity: 'warning',
        rule: 'parent-encompasses-children',
        message: `Parent "${parent.serviceName}/${parent.name}" (${parent.spanId}) ends at ${String(parent.endTimeMs)}ms but has a child ending at ${String(latestChildEnd)}ms`,
        spanIds: [parent.spanId],
      })
    }
  }
}

// =============================================================================
// Internal
// =============================================================================

/** Extract flat spans from a Tempo trace response. */
const extractFlatSpans = (response: TempoTraceResponse): Array<FlatSpan> => {
  const results: Array<FlatSpan> = []
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
