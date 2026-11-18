import { describe, expect, it } from 'bun:test'

import {
  census,
  conversion,
  filesFor,
  manifest,
  occurrence,
  reconcile,
  start,
  stringAttribute,
  windowEndMs,
  windowStartMs,
} from './buck2-occurrence-records.fixtures.ts'

describe('retained occurrence v1 reconciliation', () => {
  it('retains exact observed local rows over a 24h window without claiming fleet completeness', () => {
    const result = reconcile()
    expect(result.records).toEqual([
      {
        id: 'build-a-1',
        buildId: 'build-a',
        rootId: 'root-a',
        host: 'host-a',
        runId: 'run-a',
        lane: 'supported-entrypoint/local',
        digest: 'digest-shared',
        startedAt: windowStartMs,
        completedAt: windowStartMs + 5,
        executionOutcome: 'local-exec',
        durationNs: 5_000_001,
        totalBytes: 100,
      },
    ])
    expect(result.evidenceGaps).toEqual([
      'continuous-census:unknown',
      'fleet-registry:unknown',
      'remote-worker-linkage:unknown',
      'unsupported-entrypoints:unknown',
    ])
  })

  it('keeps repeated digests as separate native occurrences across roots and hosts', () => {
    const result = reconcile({
      files: [
        ...filesFor(),
        ...filesFor({ build: 'build-b', root: 'root-b' }),
        ...filesFor({ build: 'build-c', host: 'host-b', root: 'root-c' }),
      ],
      expectedHosts: ['host-a', 'host-b'],
    })
    expect(result.records.map((row) => row.id)).toEqual(['build-a-1', 'build-b-1', 'build-c-1'])
    expect(result.records.map((row) => row.rootId)).toEqual(['root-a', 'root-b', 'root-c'])
  })

  it('deduplicates repeated transport delivery without deduplicating action digests', () => {
    const files = filesFor()
    expect(reconcile({ files: [...files, ...files] }).records).toHaveLength(1)
  })

  it('requires the exact completion boundary, not rounded epoch milliseconds', () => {
    const end = BigInt(windowEndMs) * 1_000_000n
    const rows = [
      occurrence({ span: '1', ended: start - 1n }),
      occurrence({ span: '2', ended: start }),
      occurrence({ span: '3', ended: end - 1n }),
      occurrence({ span: '4', ended: end }),
    ]
    const result = reconcile({
      files: [
        manifest(),
        census({ phase: 'open' }),
        census({ phase: 'terminal' }),
        conversion({ rows }),
      ],
    })
    expect(result.records.map((row) => row.id)).toEqual(['build-a-2', 'build-a-3'])
    expect(result.records[1]?.durationNs).toBe(86_399_999_999_999)
  })

  it('reports missing open, terminal, build and conversion independently', () => {
    expect(
      reconcile({ files: [manifest(), census({ phase: 'terminal' }), conversion()] }).evidenceGaps,
    ).toContain('host-a-build-a:missing-open')
    expect(
      reconcile({ files: [manifest(), census({ phase: 'open' }), conversion()] }).evidenceGaps,
    ).toContain('host-a-build-a:missing-terminal')
    expect(
      reconcile({ files: [manifest(), census({ phase: 'terminal', build: null })] }).evidenceGaps,
    ).toContain('host-a-null:missing-build')
    expect(
      reconcile({ files: [manifest(), census({ phase: 'open' }), census({ phase: 'terminal' })] })
        .evidenceGaps,
    ).toContain('host-a-build-a:missing-conversion')
    expect(reconcile({ files: [manifest(), conversion()] }).records).toHaveLength(1)
    expect(reconcile({ files: [manifest(), conversion()] }).evidenceGaps).toContain(
      'build-a:missing-census',
    )
  })

  it('preserves capture failure even when an independently valid conversion exists', () => {
    const result = reconcile({
      files: [
        manifest(),
        census({ phase: 'open' }),
        census({ phase: 'terminal', error: true }),
        conversion(),
      ],
    })
    expect(result.records).toHaveLength(1)
    expect(result.evidenceGaps).toContain('host-a-build-a:capture-error')
  })

  it('rejects late enrollment, inadequate retention and absent hosts as coverage evidence', () => {
    const result = reconcile({
      files: [manifest({ enrolled: start + 1n, retention: 2_591_999 })],
      expectedHosts: ['host-a', 'host-b'],
    })
    expect(result.evidenceGaps).toContain('host-a:late-enrollment')
    expect(result.evidenceGaps).toContain('host-a:retention-under-30d')
    expect(result.evidenceGaps).toContain('host-b:missing-manifest')
    expect(reconcile({ files: [] }).evidenceGaps).toContain('host-a:missing-manifest')
  })

  it('never turns an enrolled empty directory into a proved zero-invocation fleet window', () => {
    const result = reconcile({ files: [manifest()] })
    expect(result.records).toEqual([])
    expect(result.evidenceGaps).toContain('continuous-census:unknown')
    expect(result.evidenceGaps).toContain('unsupported-entrypoints:unknown')
    expect(result.evidenceGaps).not.toContain('host-a:missing-manifest')
  })

  it('keeps independent rows when another JSONL line is malformed or the file is cut off', () => {
    const capture = conversion()
    const result = reconcile({
      files: [
        ...filesFor(),
        { name: 'malformed', body: `${capture.body}{bad}\n` },
        { name: 'cut', body: `${capture.body}{"type":` },
      ],
    })
    expect(result.records).toHaveLength(1)
    expect(result.evidenceGaps).toContain('malformed:3:malformed-record')
    expect(result.evidenceGaps).toContain('cut:truncated-file')
  })

  it('rejects unsafe numeric epoch ns instead of accepting rounded JSON numbers', () => {
    const bad = { ...occurrence(), start_ns: Number(start) }
    const result = reconcile({
      files: [manifest(), conversion({ rows: [bad, occurrence({ span: '2' })] })],
    })
    expect(result.records.map((row) => row.id)).toEqual(['build-a-2'])
    expect(result.evidenceGaps).toContain('build-a-conversion:2:malformed-record')
  })

  it('repairs exact partial prefixes with a complete strict superset', () => {
    const result = reconcile({
      files: [
        ...filesFor(),
        conversion({ truncated: true }),
        conversion({ rows: [occurrence(), occurrence({ span: '2' })] }),
      ],
    })
    expect(result.records).toHaveLength(2)
    expect(result.evidenceGaps).not.toContain('build-a:incomplete-conversion')
  })

  it('rejects conflicting overlap while retaining independent rows', () => {
    const result = reconcile({
      files: [
        ...filesFor(),
        conversion({ rows: [occurrence({ bytes: '101' }), occurrence({ span: '2' })] }),
      ],
    })
    expect(result.records.map((row) => row.id)).toEqual(['build-a-2'])
    expect(result.evidenceGaps).toContain('build-a:1:conflicting-capture')
  })

  it('excludes conflicting duplicate spans inside one capture even if a later duplicate matches', () => {
    for (const finalMatch of [false, true]) {
      const rows = [
        occurrence(),
        occurrence({ bytes: '999', outcome: 'cache-hit' }),
        ...(finalMatch === true ? [occurrence()] : []),
        occurrence({ span: '2' }),
      ]
      const result = reconcile({
        files: [...filesFor(), conversion({ rows })],
      })
      expect(result.records.map((row) => row.id)).toEqual(['build-a-2'])
      expect(result.evidenceGaps).toContain('build-a:duplicate-span')
      expect(result.evidenceGaps).toContain('build-a:1:conflicting-capture')
    }
  })

  it('does not repair unknown native fields without a clean capture', () => {
    const result = reconcile({ files: [manifest(), conversion({ unknown: 1 })] })
    expect(result.records).toHaveLength(1)
    expect(result.evidenceGaps).toContain('build-a:incomplete-conversion')
    const unknownAttribute = {
      ...occurrence(),
      attributes: [
        ...occurrence().attributes,
        stringAttribute({ key: 'buck2.future_field', value: 'unknown' }),
      ],
    }
    expect(
      reconcile({ files: [manifest(), conversion({ rows: [unknownAttribute] })] }).evidenceGaps,
    ).toContain('build-a-conversion:2:malformed-record')
  })

  it('reports census host/run mismatches and conversion root conflicts', () => {
    expect(
      reconcile({
        files: [...filesFor(), census({ phase: 'terminal', host: 'host-a', run: 'other-run' })],
      }).evidenceGaps,
    ).toContain('build-a:capture-census-mismatch')
    expect(
      reconcile({
        files: [
          ...filesFor(),
          conversion({ root: 'other-root', rows: [occurrence({ span: '2' })] }),
        ],
      }).evidenceGaps,
    ).toContain('build-a:capture-identity-mismatch')
    const unexpected = reconcile({ files: [manifest(), conversion({ host: 'host-b' })] })
    expect(unexpected.records).toHaveLength(1)
    expect(unexpected.evidenceGaps).toContain('host-b:unexpected-host')
  })

  it('keeps unavailable source metadata null and never invents root identity', () => {
    const result = reconcile({ files: [manifest(), conversion({ root: null })] })
    expect(result.records[0]?.rootId).toBeNull()
    expect(result.records[0]?.lane).toBeNull()
    expect(result.evidenceGaps).toContain('build-a-1:missing-rootId')
    expect(result.evidenceGaps).toContain('build-a-1:missing-lane')
  })

  it('does not call failed unknown actions cache hits or remote outcomes worker attempts', () => {
    const result = reconcile({
      files: [
        manifest(),
        conversion({
          rows: [
            occurrence({ outcome: 'unknown', failed: true }),
            occurrence({ span: '2', outcome: 'remote-exec' }),
          ],
        }),
      ],
    })
    expect(result.records.map((row) => row.executionOutcome)).toEqual(['failed', 'remote-exec'])
    expect(result.evidenceGaps).toContain('remote-worker-linkage:unknown')
  })

  it('does not turn unclosed actions into completed observations or unsafe byte counts into numbers', () => {
    const result = reconcile({
      files: [
        manifest(),
        conversion({
          rows: [
            occurrence({ closed: false }),
            occurrence({ span: '2', bytes: '9007199254740992' }),
          ],
        }),
      ],
    })
    expect(result.records).toHaveLength(1)
    expect(result.records[0]?.totalBytes).toBeNull()
    expect(result.evidenceGaps).toContain('build-a-1:unclosed')
    expect(result.evidenceGaps).toContain('build-a-2:missing-totalBytes')
  })

  it('keeps span elapsed separate from native wall-time attributes and marks unsafe elapsed unknown', () => {
    const wallTime = {
      ...occurrence(),
      attributes: [
        ...occurrence().attributes,
        { key: 'buck2.duration_ns', value: { intValue: '42' } },
      ],
    }
    const ancient = { ...occurrence({ span: '2' }), start_ns: '0' }
    const result = reconcile({ files: [manifest(), conversion({ rows: [wallTime, ancient] })] })
    expect(result.records[0]?.durationNs).toBe(5_000_001)
    expect(result.records[1]?.durationNs).toBeNull()
    expect(result.evidenceGaps).toContain('build-a-2:missing-durationNs')
  })

  it('preserves inconsistent build capture scope even for disjoint action spans', () => {
    const result = reconcile({
      files: [...filesFor(), conversion({ host: 'host-b', rows: [occurrence({ span: '2' })] })],
      expectedHosts: ['host-a', 'host-b'],
    })
    expect(result.evidenceGaps).toContain('build-a:capture-identity-mismatch')
    expect(result.evidenceGaps).toContain('build-a:incomparable-captures')
    expect(result.evidenceGaps).toContain('build-a:capture-census-mismatch')
    expect(result.records).toHaveLength(2)
  })
})
