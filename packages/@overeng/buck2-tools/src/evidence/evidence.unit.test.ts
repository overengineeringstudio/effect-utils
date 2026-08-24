import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { decodeBuildReport, decodeEventLog, decodeEvidence } from './decoder.ts'
import { richClaimsAvailable, verdictFor } from './verdict.ts'

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

describe('tier 1: stable build report (empirical pinned-binary shape)', () => {
  it('decodes the REAL success capture', () => {
    const decoded = decodeBuildReport(fixture('build-report-success.json'))
    expect(decoded._tag).toBe('Decoded')
    if (decoded._tag !== 'Decoded') return
    expect(decoded.report.success).toBe(true)
    expect(decoded.report.trace_id).toMatch(/[0-9a-f-]{36}/)
    expect(Object.keys(decoded.report.results ?? {})).toContain('root//:succ')
  })

  it('decodes the REAL failure capture', () => {
    const decoded = decodeBuildReport(fixture('build-report-failure.json'))
    expect(decoded._tag).toBe('Decoded')
    if (decoded._tag !== 'Decoded') return
    expect(decoded.report.success).toBe(false)
    expect(Object.keys(decoded.report.failures ?? {}).length).toBeGreaterThan(0)
  })

  it('ignores unknown future properties additively', () => {
    const base = JSON.parse(fixture('build-report-success.json')) as Record<string, unknown>
    const decoded = decodeBuildReport(JSON.stringify({ ...base, someFutureAggregate: [1, 2, 3] }))
    expect(decoded._tag).toBe('Decoded')
  })

  it('REGRESSION: unrecognized JSON degrades to Malformed, never fabricates FAIL', () => {
    // An arbitrary object with no build-report anchors must NOT decode into a
    // view whose default predicate could produce FAIL on a successful build.
    for (const text of ['', '{}', '{"outcome":"FAILURE"}', '{"success":"yes"}']) {
      const decoded = decodeBuildReport(text)
      expect(decoded._tag).toBe('Malformed')
      const evidence = { buildReport: decoded, eventLog: null }
      expect(verdictFor({ evidence })._tag).toBe('NO_VERDICT')
    }
  })
})

describe('tier 2: event log adapter (gzip JSONL, header anchors)', () => {
  it('decodes the REAL success capture: header + action + materialization', () => {
    const decoded = decodeEventLog(fixture('event-log-success.jsonl'))
    expect(decoded._tag).toBe('DecodedEventLog')
    if (decoded._tag !== 'DecodedEventLog') return
    expect(decoded.log.buckTraceId).toMatch(/[0-9a-f-]{36}/)
    expect(decoded.log.actions).toHaveLength(1)
    const action = decoded.log.actions[0]
    if (action === undefined) throw new Error('unreachable')
    expect(action.failed).toBe(false)
    expect(action.cache_class).toBe('miss') // execution_kind 1 = locally executed
    expect(action.targetLabel).toContain('succ')
    // The absolute host-path materialization is preserved RAW here; sanitization happens at export.
    expect(decoded.log.materializations.some((m) => m.path?.startsWith('/home/dev/'))).toBe(true)
  })

  it('decodes GZIP bytes directly (real logs are gzip)', () => {
    const gzipped = gzipSync(Buffer.from(fixture('event-log-success.jsonl'), 'utf8'))
    const fromBytes = decodeEventLog(new Uint8Array(gzipped))
    const fromText = decodeEventLog(fixture('event-log-success.jsonl'))
    expect(fromBytes).toStrictEqual(fromText)
  })

  it('captures the failed action in the REAL failure capture', () => {
    const decoded = decodeEventLog(fixture('event-log-failure.jsonl'))
    expect(decoded._tag).toBe('DecodedEventLog')
    if (decoded._tag !== 'DecodedEventLog') return
    expect(decoded.log.actions[0]?.failed).toBe(true)
  })

  it('rejects malformed headers and lines explicitly', () => {
    expect(decodeEventLog('')._tag).toBe('MalformedEventLog')
    // No version tag exists on real logs: interpretability is the field-set anchor.
    const badHeader = decodeEventLog('{"schema":"buck2.event-log/v1","buck_version":"9"}\n')
    expect(badHeader).toStrictEqual({
      _tag: 'MalformedEventLog',
      detail: "header missing anchor 'command_line_args' — log shape not interpretable",
    })
    const truncatedLine = decodeEventLog(
      `${fixture('event-log-success.jsonl').split('\n')[0]}\n{"Event":{"data":\n`,
    )
    expect(truncatedLine._tag).toBe('MalformedEventLog')
  })

  it('ignores non-action rows additively (real logs are full of Instant/SpanStart rows)', () => {
    const header = fixture('event-log-success.jsonl').split('\n')[0]
    const noisy = decodeEventLog(
      [
        header,
        '{"Event":{"timestamp":[1,2],"trace_id":"t","span_id":0,"parent_id":0,"data":{"Instant":{"data":{"Snapshot":{"buck2_rss":1}}}}}}',
        '{"Event":{"timestamp":[1,3],"trace_id":"t","span_id":1,"parent_id":0,"data":{"SpanStart":{"data":{"Load":{}}}}}}',
      ].join('\n'),
    )
    expect(noisy._tag).toBe('DecodedEventLog')
    if (noisy._tag !== 'DecodedEventLog') return
    expect(noisy.log.actions).toHaveLength(0)
    expect(noisy.log.materializations).toHaveLength(0)
  })
})

describe('combined verdicts (R03/R11)', () => {
  it('PASS on real success evidence', () => {
    const verdict = verdictFor({
      evidence: decodeEvidence({
        buildReportText: fixture('build-report-success.json'),
        eventLogInput: fixture('event-log-success.jsonl'),
      }),
    })
    expect(verdict).toStrictEqual({ _tag: 'PASS' })
  })

  it('FAIL when the stable predicate does not hold on the real failure capture', () => {
    const verdict = verdictFor({
      evidence: decodeEvidence({
        buildReportText: fixture('build-report-failure.json'),
        eventLogInput: fixture('event-log-failure.jsonl'),
      }),
    })
    expect(verdict._tag).toBe('FAIL')
  })

  it('NO_VERDICT per cause for missing tiers', () => {
    const missingReport = verdictFor({ evidence: decodeEvidence({ eventLogInput: '{}' }) })
    expect(missingReport).toStrictEqual({ _tag: 'NO_VERDICT', cause: 'missing-build-report' })
    const missingLog = verdictFor({
      evidence: decodeEvidence({ buildReportText: fixture('build-report-success.json') }),
    })
    expect(missingLog).toStrictEqual({ _tag: 'NO_VERDICT', cause: 'missing-event-log' })
    const nothing = verdictFor({ evidence: decodeEvidence({}) })
    expect(nothing).toStrictEqual({ _tag: 'NO_VERDICT', cause: 'missing-build-report' })
  })

  it('malformed tiers degrade to NO_VERDICT while stable claims stay available', () => {
    const evidence = decodeEvidence({
      buildReportText: fixture('build-report-success.json'),
      eventLogInput: 'not json at all',
    })
    expect(verdictFor({ evidence })).toStrictEqual({
      _tag: 'NO_VERDICT',
      cause: 'malformed-event-log',
    })
    expect(evidence.buildReport?._tag).toBe('Decoded')
    expect(richClaimsAvailable(evidence)).toBe(false)
  })

  it('supports custom stable predicates over the decoded report', () => {
    const evidence = decodeEvidence({
      buildReportText: fixture('build-report-failure.json'),
      eventLogInput: fixture('event-log-failure.jsonl'),
    })
    const held = verdictFor({
      evidence,
      predicate: (report) => report.success === false,
    })
    expect(held._tag).toBe('PASS')
  })
})
