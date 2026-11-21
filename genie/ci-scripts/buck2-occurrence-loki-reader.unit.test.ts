import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'

import { Effect } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'

import {
  assertReadWindow,
  readOccurrenceLoki,
  readPartitions,
  reassembleSnapshots,
  readerOtlp,
} from './buck2-occurrence-loki-reader.ts'

const envelopes = (lines: readonly string[]) => {
  const snapshotSha256 = createHash('sha256')
    .update(lines.map((line) => `${line}\n`).join(''))
    .digest('hex')
  return lines.map((line, ordinal) =>
    JSON.stringify({
      type: 'buck2.occurrence.ledger',
      version: 1,
      snapshotSha256,
      ordinal,
      recordCount: lines.length,
      line,
    }),
  )
}
const now = Date.parse('2026-11-19T01:00:00Z')
const start = Date.parse('2026-11-18T00:00:00Z')
const manifest = JSON.stringify({
  type: 'manifest',
  host: 'test-host',
  enrolled_at_ns: String(BigInt(start - 1) * 1_000_000n),
  retention_seconds: 2592000,
  scope: 'supported-entrypoints',
  coverage: 'unknown-until-reconciled',
})
const inherited = [
  'continuous-census:unknown',
  'fleet-registry:unknown',
  'remote-worker-linkage:unknown',
  'unsupported-entrypoints:unknown',
]
const census = (phase: 'open' | 'terminal') =>
  JSON.stringify({
    type: 'invocation',
    phase,
    invocation_id: 'invocation',
    host: 'test-host',
    timestamp_ns: String(BigInt(start + (phase === 'open' ? 1 : 5)) * 1_000_000n),
    build_id: 'build',
    exit_code: phase === 'open' ? null : 0,
    capture_error: false,
    lane: 'supported-entrypoint/local',
    run_id: 'local-run',
  })
const stringAttribute = ({ key, value }: { key: string; value: string }) => ({
  key,
  value: { stringValue: value },
})
const conversion = [
  JSON.stringify({
    type: 'conversion',
    build_id: 'build',
    root_id: 'root',
    truncated: false,
    stop_reason: null,
    unknown_fields: 0,
    action_count: 1,
    resource_attributes: [
      stringAttribute({ key: 'host.name', value: 'test-host' }),
      stringAttribute({ key: 'buck2.root_id', value: 'root' }),
      stringAttribute({ key: 'cicd.pipeline.run.id', value: 'local-run' }),
    ],
  }),
  JSON.stringify({
    type: 'occurrence',
    build_id: 'build',
    span_id: '1',
    start_ns: String(BigInt(start + 2) * 1_000_000n),
    end_ns: String(BigInt(start + 3) * 1_000_000n),
    ended: true,
    attributes: [
      stringAttribute({ key: 'buck2.occurrence_id', value: 'occurrence' }),
      stringAttribute({ key: 'buck2.action_digest', value: 'digest' }),
      stringAttribute({ key: 'buck2.execution_outcome', value: 'local-exec' }),
      { key: 'buck2.total_bytes', value: { intValue: '42' } },
    ],
  }),
]
const runReader = (
  settings: {
    drop?: number
    missingMimir?: boolean
    noConfig?: boolean
    entries?: readonly string[]
    hangLoki?: boolean
  } = {},
) => {
  const calls: URL[] = []
  const client = HttpClient.make((request) => {
    const url = new URL(request.url)
    calls.push(url)
    let body: unknown
    if (url.pathname === '/config')
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            settings.noConfig === true ? '' : 'limits_config:\n  max_entries_limit_per_query: 10\n',
          ),
        ),
      )
    if (url.pathname.endsWith('/series') === true)
      body = {
        status: 'success',
        data: [{ service_name: 'infra/buck2-events', host_name: 'test-host' }],
      }
    else if (url.pathname.endsWith('/query_range') === true) {
      if (settings.hangLoki === true) return Effect.never
      const entries = settings.entries ?? envelopes([manifest])
      body = {
        status: 'success',
        data: {
          resultType: 'streams',
          result: [
            {
              stream: { host_name: 'test-host' },
              values: entries.map((line) => [url.searchParams.get('start'), line]),
            },
          ],
        },
      }
    } else if (url.pathname === '/prometheus/api/v1/query') {
      if (settings.missingMimir === true)
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response('unavailable', { status: 503 })),
        )
      body = {
        status: 'success',
        data: {
          resultType: 'vector',
          result: [{ metric: {}, value: [now / 1000, String(settings.drop ?? 0)] }],
        },
      }
    } else throw new Error(`Unexpected path ${url.pathname}`)
    return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)))
  })
  return {
    calls,
    result: Effect.runPromise(
      readOccurrenceLoki({
        lokiUrl: 'http://loki.test',
        mimirUrl: 'http://mimir.test',
        expectedHosts: ['test-host'],
        now,
        maxRuntimeMs: 1000,
        queryTimeoutMs: settings.hangLoki === true ? 2000 : 100,
      }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    ),
  }
}

describe('snapshot verification', () => {
  it('deduplicates and reorders complete snapshots', () => {
    const [a, b] = envelopes(['first', 'second'])
    const result = reassembleSnapshots([b!, a!, a!])
    expect(result.evidenceGaps).toEqual([])
    expect(result.files[0]?.body).toBe('first\nsecond\n')
  })
  it('rejects conflicting duplicate ordinals', () => {
    const [a] = envelopes(['first'])
    expect(
      reassembleSnapshots([a!, JSON.stringify({ ...JSON.parse(a!), line: 'changed' })])
        .evidenceGaps,
    ).toEqual(['conflicting-ordinal'])
  })
  it('distinguishes missing ordinals, record counts, versions, and malformed envelopes', () => {
    const [a] = envelopes(['first', 'second'])
    expect(reassembleSnapshots([a!]).evidenceGaps).toEqual(['missing-ordinal'])
    const [single] = envelopes(['first'])
    expect(
      reassembleSnapshots([single!, JSON.stringify({ ...JSON.parse(single!), recordCount: 2 })])
        .evidenceGaps,
    ).toContain('record-count-mismatch')
    expect(
      reassembleSnapshots([JSON.stringify({ ...JSON.parse(single!), version: 2 })]).evidenceGaps,
    ).toEqual(['unknown-envelope-version'])
    expect(reassembleSnapshots(['not json']).evidenceGaps).toEqual(['unparsable-envelope'])
  })
  it('reports redaction hash mismatch distinctly', () => {
    const [a] = envelopes(['first'])
    const result = reassembleSnapshots([JSON.stringify({ ...JSON.parse(a!), line: 'redacted' })])
    expect(result.evidenceGaps).toEqual(['hash-mismatch'])
    expect(result.files).toEqual([])
  })
})

describe('bounded partitioning', () => {
  it('splits saturation recursively without gaps or overlap for many window sizes', async () => {
    for (let size = 1; size <= 32; size++) {
      const entries = Array.from({ length: size }, (_, index) => index)
      let active = 0
      const result = await Effect.runPromise(
        readPartitions({
          start: 0n,
          end: BigInt(size - 1),
          limit: 3,
          limitKnown: true,
          query: (from, to) =>
            Effect.sync(() => {
              active++
              expect(active).toBe(1)
              const result = entries
                .filter((value) => BigInt(value) >= from && BigInt(value) <= to)
                .slice(0, 3)
                .map(String)
              active--
              return result
            }),
        }),
      )
      expect(result.evidenceGaps).toEqual([])
      expect(result.lines.map(Number).toSorted((a, b) => a - b)).toEqual(entries)
    }
  })
  it('marks equal-timestamp saturation UNKNOWN', async () => {
    const result = await Effect.runPromise(
      readPartitions({
        start: 7n,
        end: 7n,
        limit: 2,
        limitKnown: true,
        query: () => Effect.succeed(['a', 'b']),
      }),
    )
    expect(result.evidenceGaps).toEqual(['saturated-timestamp'])
    expect(result.lines).toEqual([])
  })
  it('does not claim unsaturated positive results without an effective limit', async () => {
    const result = await Effect.runPromise(
      readPartitions({
        start: 0n,
        end: 1n,
        limit: 10,
        limitKnown: false,
        query: () => Effect.succeed(['a']),
      }),
    )
    expect(result.evidenceGaps).toEqual(['unknown-query-limit'])
  })
  it('rejects any read older than 48 hours', () => {
    expect(() => assertReadWindow({ now, start: now - 48 * 3600_000 - 1, end: now })).toThrow(
      'outside-48h-window',
    )
    expect(() => assertReadWindow({ now, start: now - 48 * 3600_000, end: now })).not.toThrow()
  })
})

describe('in-memory Loki and Mimir through HttpClient', () => {
  it('reassembles through the real codec/reconciler without adding reader gaps', async () => {
    const { result, calls } = runReader()
    const report = await result
    expect(report.evidenceGaps).toEqual(inherited)
    expect(report.reasons).toEqual(inherited)
    expect(report.proof).toBe('unknown')
    expect(report.windowStartMs).toBe(start)
    expect(report.windowEndMs).toBe(Date.parse('2026-11-19T00:00:00Z'))
    for (const call of calls.filter((call) => call.pathname.includes('/loki/'))) {
      expect(BigInt(call.searchParams.get('start')!)).toBeGreaterThanOrEqual(
        BigInt(now - 48 * 3600_000) * 1_000_000n,
      )
      expect(BigInt(call.searchParams.get('end')!)).toBeLessThanOrEqual(BigInt(now) * 1_000_000n)
    }
    const query = calls.find((call) => call.pathname.endsWith('/query_range'))!
    expect(query.searchParams.get('direction')).toBe('forward')
    expect(query.searchParams.get('query')).toContain('host_name="test-host"')
    const metrics = readerOtlp(report).resourceMetrics[0]!
    expect(metrics.scopeMetrics[0]?.scope.name).toBe('buck2-occurrence-loki-reader')
    expect(metrics.scopeMetrics[0]?.metrics[0]?.name).toBe('buck2.cache.execute_once.proof_known')
  })
  it('counts a real native occurrence with only the documented upstream seam gaps', async () => {
    const report = await runReader({
      entries: [
        ...envelopes([manifest]),
        ...envelopes([census('open')]),
        ...envelopes([census('terminal')]),
        ...envelopes(conversion),
      ],
    }).result
    const gaps = [
      ...inherited,
      'reader-seam:missing-repo',
      'reader-seam:unsupported-lane',
    ].toSorted()
    expect(report.evidenceGaps).toEqual(gaps)
    expect(report.reasons).toEqual(gaps)
    expect(report.records).toHaveLength(1)
    expect(report.totals.occurrences).toBe(1)
    expect(report.totals.localExecutions).toBe(1)
    expect(report.totals.totalBytes).toBe(42)
    expect(report.proof).toBe('unknown')
  })
  it('sink drop increase makes the window UNKNOWN', async () => {
    expect((await runReader({ drop: 1 }).result).reasons).toContain('sink-drop-increase')
  })
  it('Mimir unavailability remains UNKNOWN', async () => {
    expect((await runReader({ missingMimir: true }).result).reasons).toContain(
      'sink-check-unavailable',
    )
  })
  it('runtime exhaustion discards partial collection and remains UNKNOWN', async () => {
    const report = await runReader({ hangLoki: true }).result
    expect(report.proof).toBe('unknown')
    expect(report.reasons).toContain('collection-failed-or-runtime-exhausted')
    expect(report.records).toEqual([])
  })
  it('unknown live query limit is not treated as exact', async () => {
    expect((await runReader({ noConfig: true }).result).reasons).toContain('unknown-query-limit')
  })
  it('corrupted transport snapshots do not reach the reconciler as valid files', async () => {
    const [line] = envelopes([manifest])
    const report = await runReader({
      entries: [JSON.stringify({ ...JSON.parse(line!), line: 'redacted' })],
    }).result
    expect(report.reasons).toContain('hash-mismatch')
    expect(report.reasons).toContain('test-host:missing-manifest')
  })
})
