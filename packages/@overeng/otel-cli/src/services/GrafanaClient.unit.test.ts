import { DateTime } from 'effect'
import { describe, expect, it } from 'vitest'

import { parseTempoTraces } from './GrafanaClient.ts'

// =============================================================================
// Helpers
// =============================================================================

/** Create a minimal Tempo search trace with only root span info (no spanSets). */
const makeRootOnlyTrace = (opts: {
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
  spanSets: [],
})

/** Create a Tempo search trace with a matched span in spanSets (from `| select(name)`). */
const makeTraceWithSpanSet = (opts: {
  traceID: string
  rootServiceName: string
  rootTraceName: string
  matched: {
    name: string
    serviceName: string
    startTimeMs: number
    durationMs: number
  }
}) => ({
  traceID: opts.traceID,
  rootServiceName: opts.rootServiceName,
  rootTraceName: opts.rootTraceName,
  durationMs: 99999,
  startTimeUnixNano: '0',
  spanSets: [
    {
      spans: [
        {
          spanID: 'abcdef0123456789',
          name: opts.matched.name,
          startTimeUnixNano: String(BigInt(opts.matched.startTimeMs) * BigInt(1_000_000)),
          durationNanos: String(BigInt(opts.matched.durationMs) * BigInt(1_000_000)),
          attributes: [{ key: 'service.name', value: { stringValue: opts.matched.serviceName } }],
        },
      ],
      matched: 1,
    },
  ],
})

// =============================================================================
// Tests
// =============================================================================

describe('parseTempoTraces', () => {
  it('returns empty array when no traces', () => {
    expect(parseTempoTraces([])).toEqual([])
  })

  it('falls back to root span info when spanSets are empty', () => {
    const traces = [
      makeRootOnlyTrace({
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

  it('uses matched span data from spanSets over root span info', () => {
    const traces = [
      makeTraceWithSpanSet({
        traceID: 'trace-1',
        rootServiceName: 'devenv',
        rootTraceName: 'shell:entry',
        matched: {
          name: 'ts:check',
          serviceName: 'dt',
          startTimeMs: 5_000,
          durationMs: 2900,
        },
      }),
    ]

    const results = parseTempoTraces(traces)

    expect(results).toEqual([
      {
        traceId: 'trace-1',
        serviceName: 'dt',
        spanName: 'ts:check',
        durationMs: 2900,
        startTime: DateTime.unsafeMake(5_000),
      },
    ])
  })

  it('sorts by matched span startTime descending', () => {
    const traces = [
      makeTraceWithSpanSet({
        traceID: 'old',
        rootServiceName: 'devenv',
        rootTraceName: 'shell:entry',
        matched: { name: 'op-1', serviceName: 'dt', startTimeMs: 1_000, durationMs: 10 },
      }),
      makeTraceWithSpanSet({
        traceID: 'new',
        rootServiceName: 'devenv',
        rootTraceName: 'shell:entry',
        matched: { name: 'op-2', serviceName: 'dt', startTimeMs: 3_000, durationMs: 20 },
      }),
    ]

    const results = parseTempoTraces(traces)

    expect(results).toHaveLength(2)
    expect(results[0]!.traceId).toBe('new')
    expect(results[1]!.traceId).toBe('old')
  })

  it('converts nanosecond timestamps to millisecond DateTime', () => {
    const traces = [
      makeRootOnlyTrace({
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

  it('handles "<root span not yet received>" by using matched span data', () => {
    const traces = [
      makeTraceWithSpanSet({
        traceID: 'pending-root',
        rootServiceName: '<root span not yet received>',
        rootTraceName: '',
        matched: {
          name: 'megarepo/status',
          serviceName: 'megarepo',
          startTimeMs: 2_000,
          durationMs: 130,
        },
      }),
    ]

    const results = parseTempoTraces(traces)

    expect(results[0]!.serviceName).toBe('megarepo')
    expect(results[0]!.spanName).toBe('megarepo/status')
    expect(results[0]!.durationMs).toBe(130)
  })
})
