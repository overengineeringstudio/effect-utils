import { DateTime } from 'effect'
import { describe, expect, it } from 'vitest'

import { parseTempoTraces } from './GrafanaClient.ts'

// =============================================================================
// Helpers
// =============================================================================

/** Create a Tempo search trace entry with nanosecond timestamps. */
const makeTrace = (opts: {
  traceID: string
  rootServiceName: string
  rootTraceName: string
  durationMs: number
  startTimeMs: number
}) => ({
  traceID: opts.traceID,
  rootServiceName: opts.rootServiceName,
  rootTraceName: opts.rootTraceName,
  durationMs: opts.durationMs,
  startTimeUnixNano: String(BigInt(opts.startTimeMs) * BigInt(1_000_000)),
})

// =============================================================================
// Tests
// =============================================================================

describe('parseTempoTraces', () => {
  it('returns empty array when no traces', () => {
    expect(parseTempoTraces([])).toEqual([])
  })

  it('parses a single trace correctly', () => {
    const traces = [
      makeTrace({
        traceID: 'abc123',
        rootServiceName: 'my-svc',
        rootTraceName: 'GET /api',
        durationMs: 42,
        startTimeMs: 1_000,
      }),
    ]

    const results = parseTempoTraces(traces)

    expect(results).toEqual([
      {
        traceId: 'abc123',
        serviceName: 'my-svc',
        spanName: 'GET /api',
        durationMs: 42,
        startTime: DateTime.unsafeMake(1_000),
      },
    ])
  })

  it('sorts by startTime descending', () => {
    const traces = [
      makeTrace({
        traceID: 'aaa',
        rootServiceName: 'svc',
        rootTraceName: 'op-1',
        durationMs: 10,
        startTimeMs: 1_000,
      }),
      makeTrace({
        traceID: 'bbb',
        rootServiceName: 'svc',
        rootTraceName: 'op-2',
        durationMs: 20,
        startTimeMs: 3_000,
      }),
      makeTrace({
        traceID: 'ccc',
        rootServiceName: 'svc',
        rootTraceName: 'op-3',
        durationMs: 30,
        startTimeMs: 2_000,
      }),
    ]

    const results = parseTempoTraces(traces)

    expect(results).toHaveLength(3)
    expect(results[0]!.traceId).toBe('bbb')
    expect(results[1]!.traceId).toBe('ccc')
    expect(results[2]!.traceId).toBe('aaa')
  })

  it('converts nanosecond timestamps to millisecond DateTime', () => {
    const traces = [
      makeTrace({
        traceID: 'aaa',
        rootServiceName: 'svc',
        rootTraceName: 'op',
        durationMs: 10,
        startTimeMs: 1_700_000_000_000,
      }),
    ]

    const results = parseTempoTraces(traces)

    expect(DateTime.toEpochMillis(results[0]!.startTime)).toBe(1_700_000_000_000)
  })
})
