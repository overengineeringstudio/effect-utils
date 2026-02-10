import { describe, expect, it } from 'vitest'

import type { TempoTraceResponse } from '../services/TempoClient.ts'
import { validateTraceStructure } from './trace-validate.ts'

// =============================================================================
// Helpers
// =============================================================================

const ms = (millis: number) => String(BigInt(millis) * 1_000_000n)

/** Create a minimal span for test fixtures. */
const makeSpan = (opts: {
  spanId: string
  parentSpanId?: string
  name: string
  startMs: number
  endMs: number
}) => ({
  traceId: 'trace-001',
  spanId: opts.spanId,
  parentSpanId: opts.parentSpanId,
  name: opts.name,
  startTimeUnixNano: ms(opts.startMs),
  endTimeUnixNano: ms(opts.endMs),
})

/** Create a resourceSpans entry with a service name and spans. */
const makeResourceSpan = (
  serviceName: string,
  spans: Array<ReturnType<typeof makeSpan>>,
): TempoTraceResponse['resourceSpans'] extends ReadonlyArray<infer T> | undefined ? T : never => ({
  resource: {
    attributes: [{ key: 'service.name', value: { stringValue: serviceName } }],
  },
  scopeSpans: [{ spans }],
})

/** Build a TempoTraceResponse from resource spans. */
const makeTrace = (
  ...resourceSpans: Array<ReturnType<typeof makeResourceSpan>>
): TempoTraceResponse => ({
  resourceSpans,
})

// =============================================================================
// Tests
// =============================================================================

describe('validateTraceStructure', () => {
  describe('empty traces', () => {
    it('reports error for empty resourceSpans', () => {
      const result = validateTraceStructure({ resourceSpans: [] })

      expect(result.valid).toBe(false)
      expect(result.spanCount).toBe(0)
      expect(result.findings).toHaveLength(1)
      expect(result.findings[0]).toMatchInlineSnapshot(`
        {
          "message": "Trace contains no spans",
          "rule": "non-empty",
          "severity": "error",
        }
      `)
    })

    it('reports error for missing resourceSpans and batches', () => {
      const result = validateTraceStructure({})

      expect(result.valid).toBe(false)
      expect(result.spanCount).toBe(0)
    })

    it('reports error for resourceSpans with empty scopeSpans', () => {
      const result = validateTraceStructure({
        resourceSpans: [
          {
            resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
            scopeSpans: [{ spans: [] }],
          },
        ],
      })

      expect(result.valid).toBe(false)
      expect(result.spanCount).toBe(0)
    })
  })

  describe('valid traces', () => {
    it('accepts a valid single root span', () => {
      const result = validateTraceStructure(
        makeTrace(
          makeResourceSpan('my-service', [
            makeSpan({ spanId: 'root', name: 'entry', startMs: 0, endMs: 100 }),
          ]),
        ),
      )

      expect(result.valid).toBe(true)
      expect(result.spanCount).toBe(1)
      expect(result.findings).toHaveLength(0)
    })

    it('accepts a valid parent-child tree', () => {
      const result = validateTraceStructure(
        makeTrace(
          makeResourceSpan('my-service', [
            makeSpan({ spanId: 'root', name: 'entry', startMs: 0, endMs: 200 }),
            makeSpan({
              spanId: 'child-1',
              parentSpanId: 'root',
              name: 'step-1',
              startMs: 10,
              endMs: 90,
            }),
            makeSpan({
              spanId: 'child-2',
              parentSpanId: 'root',
              name: 'step-2',
              startMs: 100,
              endMs: 190,
            }),
          ]),
        ),
      )

      expect(result.valid).toBe(true)
      expect(result.spanCount).toBe(3)
      expect(result.findings).toHaveLength(0)
    })

    it('accepts a realistic shell entry trace across services', () => {
      const result = validateTraceStructure(
        makeTrace(
          makeResourceSpan('devenv', [
            makeSpan({ spanId: 'shell', name: 'shell:entry', startMs: 0, endMs: 5000 }),
          ]),
          makeResourceSpan('dt', [
            makeSpan({
              spanId: 'task',
              parentSpanId: 'shell',
              name: 'ts:check',
              startMs: 100,
              endMs: 3000,
            }),
            makeSpan({
              spanId: 'subtask',
              parentSpanId: 'task',
              name: 'tsc --noEmit',
              startMs: 200,
              endMs: 2900,
            }),
          ]),
        ),
      )

      expect(result.valid).toBe(true)
      expect(result.spanCount).toBe(3)
      expect(result.findings).toHaveLength(0)
    })
  })

  describe('orphaned spans', () => {
    it('warns about spans referencing non-existent parent', () => {
      const result = validateTraceStructure(
        makeTrace(
          makeResourceSpan('svc', [
            makeSpan({ spanId: 'root', name: 'entry', startMs: 0, endMs: 100 }),
            makeSpan({
              spanId: 'orphan',
              parentSpanId: 'missing-parent',
              name: 'lost',
              startMs: 10,
              endMs: 50,
            }),
          ]),
        ),
      )

      expect(result.valid).toBe(true) // orphaned spans are warnings, not errors
      expect(result.findings.some((f) => f.rule === 'no-orphaned-spans')).toBe(true)
      const orphanFinding = result.findings.find((f) => f.rule === 'no-orphaned-spans')!
      expect(orphanFinding.severity).toBe('warning')
      expect(orphanFinding.spanIds).toEqual(['orphan'])
      expect(orphanFinding.message).toContain('missing-parent')
    })
  })

  describe('duplicate span IDs', () => {
    it('reports error for duplicate span IDs', () => {
      const result = validateTraceStructure(
        makeTrace(
          makeResourceSpan('svc', [
            makeSpan({ spanId: 'dup', name: 'first', startMs: 0, endMs: 100 }),
            makeSpan({ spanId: 'dup', name: 'second', startMs: 0, endMs: 100 }),
          ]),
        ),
      )

      expect(result.valid).toBe(false)
      const dupFinding = result.findings.find((f) => f.rule === 'no-duplicate-span-ids')!
      expect(dupFinding.severity).toBe('error')
      expect(dupFinding.message).toContain('"dup"')
      expect(dupFinding.message).toContain('2 times')
    })
  })

  describe('multiple root spans', () => {
    it('warns when multiple root spans exist', () => {
      const result = validateTraceStructure(
        makeTrace(
          makeResourceSpan('svc-a', [
            makeSpan({ spanId: 'root-a', name: 'entry-a', startMs: 0, endMs: 100 }),
          ]),
          makeResourceSpan('svc-b', [
            makeSpan({ spanId: 'root-b', name: 'entry-b', startMs: 0, endMs: 100 }),
          ]),
        ),
      )

      expect(result.valid).toBe(true) // multiple roots are warnings
      const rootFinding = result.findings.find((f) => f.rule === 'single-root')!
      expect(rootFinding.severity).toBe('warning')
      expect(rootFinding.message).toContain('2 root spans')
      expect(rootFinding.spanIds).toEqual(['root-a', 'root-b'])
    })
  })

  describe('duplicate service roots', () => {
    it('warns when a service has multiple root-level spans', () => {
      const result = validateTraceStructure(
        makeTrace(
          makeResourceSpan('devenv', [
            makeSpan({ spanId: 'root-1', name: 'shell:entry', startMs: 0, endMs: 100 }),
            makeSpan({ spanId: 'root-2', name: 'shell:entry', startMs: 200, endMs: 300 }),
          ]),
        ),
      )

      expect(result.valid).toBe(true)
      const svcFinding = result.findings.find((f) => f.rule === 'no-duplicate-service-roots')!
      expect(svcFinding.severity).toBe('warning')
      expect(svcFinding.message).toContain('devenv')
      expect(svcFinding.message).toContain('2 root-level spans')
    })
  })

  describe('parent-child timing violations', () => {
    it('warns when child starts before parent', () => {
      const result = validateTraceStructure(
        makeTrace(
          makeResourceSpan('svc', [
            makeSpan({ spanId: 'parent', name: 'slow-start', startMs: 100, endMs: 500 }),
            makeSpan({
              spanId: 'child',
              parentSpanId: 'parent',
              name: 'eager',
              startMs: 50,
              endMs: 200,
            }),
          ]),
        ),
      )

      expect(result.valid).toBe(true) // timing issues are warnings
      const timingFinding = result.findings.find(
        (f) => f.rule === 'parent-encompasses-children' && f.message.includes('starts at'),
      )!
      expect(timingFinding.severity).toBe('warning')
      expect(timingFinding.message).toContain('starts at 100ms')
      expect(timingFinding.message).toContain('child starting at 50ms')
    })

    it('warns when child ends after parent', () => {
      const result = validateTraceStructure(
        makeTrace(
          makeResourceSpan('svc', [
            makeSpan({ spanId: 'parent', name: 'short', startMs: 0, endMs: 100 }),
            makeSpan({
              spanId: 'child',
              parentSpanId: 'parent',
              name: 'overrun',
              startMs: 10,
              endMs: 200,
            }),
          ]),
        ),
      )

      expect(result.valid).toBe(true)
      const timingFinding = result.findings.find(
        (f) => f.rule === 'parent-encompasses-children' && f.message.includes('ends at'),
      )!
      expect(timingFinding.severity).toBe('warning')
      expect(timingFinding.message).toContain('ends at 100ms')
      expect(timingFinding.message).toContain('child ending at 200ms')
    })

    it('reports both start and end timing violations for same parent', () => {
      const result = validateTraceStructure(
        makeTrace(
          makeResourceSpan('svc', [
            makeSpan({ spanId: 'parent', name: 'narrow', startMs: 100, endMs: 200 }),
            makeSpan({
              spanId: 'child',
              parentSpanId: 'parent',
              name: 'wide',
              startMs: 50,
              endMs: 300,
            }),
          ]),
        ),
      )

      const timingFindings = result.findings.filter((f) => f.rule === 'parent-encompasses-children')
      expect(timingFindings).toHaveLength(2)
      expect(timingFindings.some((f) => f.message.includes('starts at'))).toBe(true)
      expect(timingFindings.some((f) => f.message.includes('ends at'))).toBe(true)
    })
  })

  describe('combined malformed trace', () => {
    it('reports multiple findings for a trace with several issues', () => {
      const result = validateTraceStructure(
        makeTrace(
          makeResourceSpan('svc-a', [
            makeSpan({ spanId: 'dup', name: 'first', startMs: 0, endMs: 100 }),
            makeSpan({ spanId: 'dup', name: 'second', startMs: 0, endMs: 100 }),
          ]),
          makeResourceSpan('svc-b', [
            makeSpan({
              spanId: 'orphan',
              parentSpanId: 'nonexistent',
              name: 'lost',
              startMs: 0,
              endMs: 50,
            }),
          ]),
        ),
      )

      expect(result.valid).toBe(false)
      expect(result.findings.length).toBeGreaterThanOrEqual(2)

      const rules = result.findings.map((f) => f.rule)
      expect(rules).toContain('no-duplicate-span-ids')
      expect(rules).toContain('no-orphaned-spans')
    })
  })

  describe('batches format', () => {
    it('works with batches key instead of resourceSpans', () => {
      const result = validateTraceStructure({
        batches: [
          makeResourceSpan('legacy-svc', [
            makeSpan({ spanId: 'root', name: 'entry', startMs: 0, endMs: 100 }),
          ]),
        ],
      })

      expect(result.valid).toBe(true)
      expect(result.spanCount).toBe(1)
    })
  })
})
