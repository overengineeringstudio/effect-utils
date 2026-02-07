import { describe, expect, it } from 'vitest'

import type { TempoTraceResponse } from '../services/TempoClient.ts'
import { buildSpanTree } from './span-tree.ts'

// =============================================================================
// Helpers
// =============================================================================

/** Create a minimal Tempo trace response with `resourceSpans` format. */
const makeResponse = (
  spans: Array<{
    spanId: string
    parentSpanId?: string
    name: string
    serviceName?: string
    startTimeUnixNano: string
    endTimeUnixNano: string
    statusCode?: string | number
    statusMessage?: string
    attributes?: Array<{ key: string; value: Record<string, unknown> }>
  }>,
): TempoTraceResponse => {
  // Group spans by serviceName
  const byService = new Map<string, typeof spans>()
  for (const span of spans) {
    const svc = span.serviceName ?? 'test-service'
    const list = byService.get(svc) ?? []
    list.push(span)
    byService.set(svc, list)
  }

  return {
    resourceSpans: [...byService.entries()].map(([svc, serviceSpans]) => ({
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: svc } }],
      },
      scopeSpans: [
        {
          spans: serviceSpans.map((s) => ({
            traceId: 'abc123',
            spanId: s.spanId,
            parentSpanId: s.parentSpanId,
            name: s.name,
            startTimeUnixNano: s.startTimeUnixNano,
            endTimeUnixNano: s.endTimeUnixNano,
            status:
              s.statusCode !== undefined
                ? { code: s.statusCode, message: s.statusMessage }
                : undefined,
            attributes: s.attributes,
          })),
        },
      ],
    })),
  }
}

/** Convert milliseconds to nanoseconds string. */
const msToNano = (ms: number): string => String(BigInt(ms) * 1_000_000n)

// =============================================================================
// Tests
// =============================================================================

describe('buildSpanTree', () => {
  it('returns empty result for empty response', () => {
    const result = buildSpanTree({ response: {} })
    expect(result).toEqual({
      rootSpans: [],
      totalSpanCount: 0,
      traceStartMs: 0,
      traceEndMs: 0,
      traceDurationMs: 0,
    })
  })

  it('returns empty result for response with empty resourceSpans', () => {
    const result = buildSpanTree({ response: { resourceSpans: [] } })
    expect(result).toEqual({
      rootSpans: [],
      totalSpanCount: 0,
      traceStartMs: 0,
      traceEndMs: 0,
      traceDurationMs: 0,
    })
  })

  it('processes a single root span', () => {
    const response = makeResponse([
      {
        spanId: 'span-1',
        name: 'root-op',
        startTimeUnixNano: msToNano(1000),
        endTimeUnixNano: msToNano(2000),
      },
    ])

    const result = buildSpanTree({ response })

    expect(result.totalSpanCount).toBe(1)
    expect(result.traceStartMs).toBe(1000)
    expect(result.traceEndMs).toBe(2000)
    expect(result.traceDurationMs).toBe(1000)
    expect(result.rootSpans).toHaveLength(1)
    expect(result.rootSpans[0]).toMatchObject({
      spanId: 'span-1',
      name: 'root-op',
      serviceName: 'test-service',
      startTimeMs: 1000,
      endTimeMs: 2000,
      durationMs: 1000,
      depth: 0,
      children: [],
    })
  })

  it('builds parent-child hierarchy', () => {
    const response = makeResponse([
      {
        spanId: 'parent',
        name: 'parent-op',
        startTimeUnixNano: msToNano(1000),
        endTimeUnixNano: msToNano(3000),
      },
      {
        spanId: 'child',
        parentSpanId: 'parent',
        name: 'child-op',
        startTimeUnixNano: msToNano(1500),
        endTimeUnixNano: msToNano(2500),
      },
    ])

    const result = buildSpanTree({ response })

    expect(result.totalSpanCount).toBe(2)
    expect(result.rootSpans).toHaveLength(1)
    expect(result.rootSpans[0]!.spanId).toBe('parent')
    expect(result.rootSpans[0]!.depth).toBe(0)
    expect(result.rootSpans[0]!.children).toHaveLength(1)
    expect(result.rootSpans[0]!.children[0]).toMatchObject({
      spanId: 'child',
      name: 'child-op',
      depth: 1,
      children: [],
    })
  })

  it('builds deep nesting (grandchild)', () => {
    const response = makeResponse([
      {
        spanId: 'root',
        name: 'root',
        startTimeUnixNano: msToNano(0),
        endTimeUnixNano: msToNano(100),
      },
      {
        spanId: 'child',
        parentSpanId: 'root',
        name: 'child',
        startTimeUnixNano: msToNano(10),
        endTimeUnixNano: msToNano(90),
      },
      {
        spanId: 'grandchild',
        parentSpanId: 'child',
        name: 'grandchild',
        startTimeUnixNano: msToNano(20),
        endTimeUnixNano: msToNano(80),
      },
    ])

    const result = buildSpanTree({ response })

    expect(result.rootSpans).toHaveLength(1)
    const root = result.rootSpans[0]!
    expect(root.depth).toBe(0)
    expect(root.children[0]!.depth).toBe(1)
    expect(root.children[0]!.children[0]!.depth).toBe(2)
    expect(root.children[0]!.children[0]!.spanId).toBe('grandchild')
  })

  it('treats spans with missing parent as roots', () => {
    const response = makeResponse([
      {
        spanId: 'orphan',
        parentSpanId: 'nonexistent',
        name: 'orphan-op',
        startTimeUnixNano: msToNano(100),
        endTimeUnixNano: msToNano(200),
      },
    ])

    const result = buildSpanTree({ response })

    expect(result.rootSpans).toHaveLength(1)
    expect(result.rootSpans[0]!.spanId).toBe('orphan')
    expect(result.rootSpans[0]!.depth).toBe(0)
  })

  it('sorts multiple root spans by start time', () => {
    const response = makeResponse([
      {
        spanId: 'late',
        name: 'late',
        startTimeUnixNano: msToNano(2000),
        endTimeUnixNano: msToNano(3000),
      },
      {
        spanId: 'early',
        name: 'early',
        startTimeUnixNano: msToNano(1000),
        endTimeUnixNano: msToNano(1500),
      },
    ])

    const result = buildSpanTree({ response })

    expect(result.rootSpans).toHaveLength(2)
    expect(result.rootSpans[0]!.spanId).toBe('early')
    expect(result.rootSpans[1]!.spanId).toBe('late')
  })

  it('sorts sibling children by start time', () => {
    const response = makeResponse([
      {
        spanId: 'root',
        name: 'root',
        startTimeUnixNano: msToNano(0),
        endTimeUnixNano: msToNano(100),
      },
      {
        spanId: 'child-b',
        parentSpanId: 'root',
        name: 'second',
        startTimeUnixNano: msToNano(50),
        endTimeUnixNano: msToNano(80),
      },
      {
        spanId: 'child-a',
        parentSpanId: 'root',
        name: 'first',
        startTimeUnixNano: msToNano(10),
        endTimeUnixNano: msToNano(40),
      },
    ])

    const result = buildSpanTree({ response })

    const children = result.rootSpans[0]!.children
    expect(children).toHaveLength(2)
    expect(children[0]!.spanId).toBe('child-a')
    expect(children[1]!.spanId).toBe('child-b')
  })

  it('computes trace-level timing across all spans', () => {
    const response = makeResponse([
      {
        spanId: 'a',
        name: 'a',
        startTimeUnixNano: msToNano(500),
        endTimeUnixNano: msToNano(800),
      },
      {
        spanId: 'b',
        name: 'b',
        startTimeUnixNano: msToNano(100),
        endTimeUnixNano: msToNano(1200),
      },
    ])

    const result = buildSpanTree({ response })

    expect(result.traceStartMs).toBe(100)
    expect(result.traceEndMs).toBe(1200)
    expect(result.traceDurationMs).toBe(1100)
  })

  it('focuses on a specific spanId when provided', () => {
    const response = makeResponse([
      {
        spanId: 'root',
        name: 'root',
        startTimeUnixNano: msToNano(0),
        endTimeUnixNano: msToNano(100),
      },
      {
        spanId: 'child',
        parentSpanId: 'root',
        name: 'child',
        startTimeUnixNano: msToNano(10),
        endTimeUnixNano: msToNano(50),
      },
      {
        spanId: 'grandchild',
        parentSpanId: 'child',
        name: 'grandchild',
        startTimeUnixNano: msToNano(20),
        endTimeUnixNano: msToNano(40),
      },
    ])

    const result = buildSpanTree({ response, spanId: 'child' })

    expect(result.rootSpans).toHaveLength(1)
    expect(result.rootSpans[0]!.spanId).toBe('child')
    expect(result.rootSpans[0]!.depth).toBe(0)
    // Should still include children of the focused span
    expect(result.rootSpans[0]!.children).toHaveLength(1)
    expect(result.rootSpans[0]!.children[0]!.spanId).toBe('grandchild')
  })

  it('returns empty roots when spanId is not found', () => {
    const response = makeResponse([
      {
        spanId: 'root',
        name: 'root',
        startTimeUnixNano: msToNano(0),
        endTimeUnixNano: msToNano(100),
      },
    ])

    const result = buildSpanTree({ response, spanId: 'nonexistent' })

    expect(result.rootSpans).toHaveLength(0)
    // totalSpanCount still reflects all spans in the response
    expect(result.totalSpanCount).toBe(1)
  })

  it('handles batches format (legacy Tempo)', () => {
    const response: TempoTraceResponse = {
      batches: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: 'legacy-svc' } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'abc',
                  spanId: 's1',
                  name: 'legacy-op',
                  startTimeUnixNano: msToNano(0),
                  endTimeUnixNano: msToNano(50),
                },
              ],
            },
          ],
        },
      ],
    }

    const result = buildSpanTree({ response })

    expect(result.totalSpanCount).toBe(1)
    expect(result.rootSpans[0]!.serviceName).toBe('legacy-svc')
    expect(result.rootSpans[0]!.name).toBe('legacy-op')
  })

  it('defaults serviceName to "unknown" when resource has no attributes', () => {
    const response: TempoTraceResponse = {
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'abc',
                  spanId: 's1',
                  name: 'op',
                  startTimeUnixNano: msToNano(0),
                  endTimeUnixNano: msToNano(10),
                },
              ],
            },
          ],
        },
      ],
    }

    const result = buildSpanTree({ response })

    expect(result.rootSpans[0]!.serviceName).toBe('unknown')
  })

  describe('status code normalization', () => {
    it('handles numeric status codes', () => {
      const response = makeResponse([
        {
          spanId: 's1',
          name: 'op',
          startTimeUnixNano: msToNano(0),
          endTimeUnixNano: msToNano(10),
          statusCode: 2,
          statusMessage: 'something failed',
        },
      ])

      const result = buildSpanTree({ response })

      expect(result.rootSpans[0]!.statusCode).toBe(2)
      expect(result.rootSpans[0]!.statusMessage).toBe('something failed')
    })

    it('normalizes STATUS_CODE_OK string to 1', () => {
      const response = makeResponse([
        {
          spanId: 's1',
          name: 'op',
          startTimeUnixNano: msToNano(0),
          endTimeUnixNano: msToNano(10),
          statusCode: 'STATUS_CODE_OK',
        },
      ])

      const result = buildSpanTree({ response })

      expect(result.rootSpans[0]!.statusCode).toBe(1)
    })

    it('normalizes STATUS_CODE_ERROR string to 2', () => {
      const response = makeResponse([
        {
          spanId: 's1',
          name: 'op',
          startTimeUnixNano: msToNano(0),
          endTimeUnixNano: msToNano(10),
          statusCode: 'STATUS_CODE_ERROR',
        },
      ])

      const result = buildSpanTree({ response })

      expect(result.rootSpans[0]!.statusCode).toBe(2)
    })

    it('normalizes STATUS_CODE_UNSET string to 0', () => {
      const response = makeResponse([
        {
          spanId: 's1',
          name: 'op',
          startTimeUnixNano: msToNano(0),
          endTimeUnixNano: msToNano(10),
          statusCode: 'STATUS_CODE_UNSET',
        },
      ])

      const result = buildSpanTree({ response })

      expect(result.rootSpans[0]!.statusCode).toBe(0)
    })

    it('returns undefined for unknown string status codes', () => {
      const response = makeResponse([
        {
          spanId: 's1',
          name: 'op',
          startTimeUnixNano: msToNano(0),
          endTimeUnixNano: msToNano(10),
          statusCode: 'BOGUS',
        },
      ])

      const result = buildSpanTree({ response })

      expect(result.rootSpans[0]!.statusCode).toBeUndefined()
    })

    it('returns undefined when status is absent', () => {
      const response = makeResponse([
        {
          spanId: 's1',
          name: 'op',
          startTimeUnixNano: msToNano(0),
          endTimeUnixNano: msToNano(10),
        },
      ])

      const result = buildSpanTree({ response })

      expect(result.rootSpans[0]!.statusCode).toBeUndefined()
    })
  })

  describe('attribute value extraction', () => {
    it('extracts stringValue attributes', () => {
      const response = makeResponse([
        {
          spanId: 's1',
          name: 'op',
          startTimeUnixNano: msToNano(0),
          endTimeUnixNano: msToNano(10),
          attributes: [{ key: 'http.method', value: { stringValue: 'GET' } }],
        },
      ])

      const result = buildSpanTree({ response })

      expect(result.rootSpans[0]!.attributes).toEqual([{ key: 'http.method', value: 'GET' }])
    })

    it('extracts intValue attributes', () => {
      const response = makeResponse([
        {
          spanId: 's1',
          name: 'op',
          startTimeUnixNano: msToNano(0),
          endTimeUnixNano: msToNano(10),
          attributes: [{ key: 'http.status_code', value: { intValue: 200 } }],
        },
      ])

      const result = buildSpanTree({ response })

      expect(result.rootSpans[0]!.attributes).toEqual([{ key: 'http.status_code', value: '200' }])
    })

    it('extracts boolValue attributes', () => {
      const response = makeResponse([
        {
          spanId: 's1',
          name: 'op',
          startTimeUnixNano: msToNano(0),
          endTimeUnixNano: msToNano(10),
          attributes: [{ key: 'error', value: { boolValue: true } }],
        },
      ])

      const result = buildSpanTree({ response })

      expect(result.rootSpans[0]!.attributes).toEqual([{ key: 'error', value: 'true' }])
    })

    it('returns empty string for unknown attribute value types', () => {
      const response = makeResponse([
        {
          spanId: 's1',
          name: 'op',
          startTimeUnixNano: msToNano(0),
          endTimeUnixNano: msToNano(10),
          attributes: [{ key: 'weird', value: {} }],
        },
      ])

      const result = buildSpanTree({ response })

      expect(result.rootSpans[0]!.attributes).toEqual([{ key: 'weird', value: '' }])
    })
  })

  it('handles multiple scope spans under one resource', () => {
    const response: TempoTraceResponse = {
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: 'service.name', value: { stringValue: 'my-svc' } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'abc',
                  spanId: 'scope1-span',
                  name: 'from-scope-1',
                  startTimeUnixNano: msToNano(0),
                  endTimeUnixNano: msToNano(50),
                },
              ],
            },
            {
              spans: [
                {
                  traceId: 'abc',
                  spanId: 'scope2-span',
                  name: 'from-scope-2',
                  startTimeUnixNano: msToNano(10),
                  endTimeUnixNano: msToNano(60),
                },
              ],
            },
          ],
        },
      ],
    }

    const result = buildSpanTree({ response })

    expect(result.totalSpanCount).toBe(2)
    expect(result.rootSpans).toHaveLength(2)
  })

  it('handles spans across multiple services', () => {
    const response = makeResponse([
      {
        spanId: 'frontend-span',
        name: 'request',
        serviceName: 'frontend',
        startTimeUnixNano: msToNano(0),
        endTimeUnixNano: msToNano(100),
      },
      {
        spanId: 'backend-span',
        parentSpanId: 'frontend-span',
        name: 'query',
        serviceName: 'backend',
        startTimeUnixNano: msToNano(10),
        endTimeUnixNano: msToNano(90),
      },
    ])

    const result = buildSpanTree({ response })

    expect(result.rootSpans).toHaveLength(1)
    expect(result.rootSpans[0]!.serviceName).toBe('frontend')
    expect(result.rootSpans[0]!.children[0]!.serviceName).toBe('backend')
  })

  it('converts nanoseconds correctly for large timestamps', () => {
    // Realistic timestamp: 2024-01-01T00:00:00Z = 1704067200000 ms
    const startMs = 1704067200000
    const endMs = 1704067200500

    const response = makeResponse([
      {
        spanId: 's1',
        name: 'op',
        startTimeUnixNano: msToNano(startMs),
        endTimeUnixNano: msToNano(endMs),
      },
    ])

    const result = buildSpanTree({ response })

    expect(result.rootSpans[0]!.startTimeMs).toBe(startMs)
    expect(result.rootSpans[0]!.endTimeMs).toBe(endMs)
    expect(result.rootSpans[0]!.durationMs).toBe(500)
  })
})
