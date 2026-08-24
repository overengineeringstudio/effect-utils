import { describe, expect, it } from 'vitest'

import { readFileSync } from 'node:fs'

import { decodeBuildReport, decodeEventLog, decodeEvidence } from './decoder.ts'
import { richClaimsAvailable, verdictFor } from './verdict.ts'

const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

describe('tier 1: stable build report (additive-tolerant)', () => {
  it('decodes the success fixture', () => {
    const decoded = decodeBuildReport(fixture('build-report-success.json'))
    expect(decoded._tag).toBe('Decoded')
    if (decoded._tag !== 'Decoded') return
    expect(decoded.report.outcome).toBe('SUCCESS')
    expect(decoded.report.targets?.['//apps/demo:bin']?.outcome).toBe('SUCCESS')
  })

  it('ignores unknown future properties instead of failing', () => {
    const decoded = decodeBuildReport(
      JSON.stringify({
        outcome: 'FAILURE',
        someFutureAggregate: { nested: [1, 2, 3] },
        targets: {},
        version: '99',
      }),
    )
    expect(decoded._tag).toBe('Decoded')
    if (decoded._tag !== 'Decoded') return
    expect(decoded.report.outcome).toBe('FAILURE')
  })

  it('reports malformed input as Malformed, never guesses', () => {
    expect(decodeBuildReport('')._tag).toBe('Malformed')
    const broken = decodeBuildReport('{"outcome": 42}')
    expect(broken._tag).toBe('Malformed')
    if (broken._tag === 'Malformed') {
      expect(broken.detail).toContain('outcome')
    }
  })
})

describe('tier 2: version-bound event log adapter', () => {
  it('decodes an admitted log with actions + materializations', () => {
    const decoded = decodeEventLog(fixture('event-log-v2026-04-15-success.jsonl'))
    expect(decoded._tag).toBe('DecodedEventLog')
    if (decoded._tag !== 'DecodedEventLog') return
    expect(decoded.log.buckVersion).toBe('2026-04-15')
    expect(decoded.log.invocationId).toBe('inv-3f9a2c7')
    expect(decoded.log.actions.map((action) => action.cache_class)).toEqual(['miss', 'hit'])
    expect(decoded.log.materializations).toHaveLength(1)
    expect(decoded.log.materializations[0]?.digest_sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('retains unknown versions as unsupported raw evidence', () => {
    const decoded = decodeEventLog(fixture('event-log-unknown-version.jsonl'))
    expect(decoded).toStrictEqual({
      _tag: 'UnsupportedEventLogVersion',
      buckVersion: '2026-08-22',
    })
  })

  it('rejects malformed headers and lines explicitly', () => {
    expect(decodeEventLog('')._tag).toBe('MalformedEventLog')
    const badHeader = decodeEventLog('{"schema":"something.else"}\n')
    expect(badHeader._tag).toBe('MalformedEventLog')
    const badLine =
      decodeEventLog(
        '{"schema":"buck2.event-log/v1","buck_version":"2026-04-15","invocation_id":"i"}\n{"type":"nonsense"}\n',
      )
    expect(badHeader._tag).toBe('MalformedEventLog')
    expect(badLine._tag).toBe('MalformedEventLog')
  })

  it('never consults what-ran style summaries', () => {
    // A log whose ONLY line is a header decodes fine with zero actions —
    // summaries are derivations of this log, never its replacement.
    const decoded = decodeEventLog(
      '{"schema":"buck2.event-log/v1","buck_version":"2026-04-15","invocation_id":"i"}\n',
    )
    expect(decoded._tag).toBe('DecodedEventLog')
    if (decoded._tag !== 'DecodedEventLog') return
    expect(decoded.log.actions).toHaveLength(0)
  })
})

describe('combined verdicts (R03/R11)', () => {
  it('PASS on success evidence', () => {
    const verdict = verdictFor({
      evidence: decodeEvidence({
        buildReportText: fixture('build-report-success.json'),
        eventLogText: fixture('event-log-v2026-04-15-success.jsonl'),
      }),
    })
    expect(verdict).toStrictEqual({ _tag: 'PASS' })
  })

  it('FAIL when the stable predicate does not hold', () => {
    const verdict = verdictFor({
      evidence: decodeEvidence({
        buildReportText: fixture('build-report-failure.json'),
        eventLogText: fixture('event-log-v2026-04-15-success.jsonl'),
      }),
    })
    expect(verdict._tag).toBe('FAIL')
  })

  it('NO_VERDICT per cause for missing tiers', () => {
    const missingReport = verdictFor({ evidence: decodeEvidence({ eventLogText: '{}' }) })
    expect(missingReport).toStrictEqual({ _tag: 'NO_VERDICT', cause: 'missing-build-report' })
    const missingLog = verdictFor({
      evidence: decodeEvidence({ buildReportText: fixture('build-report-success.json') }),
    })
    expect(missingLog).toStrictEqual({ _tag: 'NO_VERDICT', cause: 'missing-event-log' })
    const nothing = verdictFor({ evidence: decodeEvidence({}) })
    expect(nothing).toStrictEqual({ _tag: 'NO_VERDICT', cause: 'missing-build-report' })
  })

  it('NO_VERDICT(unsupported-event-log-version) while stable claims stay available', () => {
    const evidence = decodeEvidence({
      buildReportText: fixture('build-report-success.json'),
      eventLogText: fixture('event-log-unknown-version.jsonl'),
    })
    // Combined verification degrades to NO_VERDICT...
    expect(verdictFor({ evidence })).toStrictEqual({
      _tag: 'NO_VERDICT',
      cause: 'unsupported-event-log-version',
    })
    // ...but the stable tier remains fully decoded for callers.
    expect(evidence.buildReport?._tag).toBe('Decoded')
    expect(richClaimsAvailable(evidence)).toBe(false)
  })
  it('supports custom stable predicates over the decoded report', () => {
    const evidence = decodeEvidence({
      buildReportText: fixture('build-report-failure.json'),
      eventLogText: fixture('event-log-v2026-04-15-success.jsonl'),
    })
    const held = verdictFor({
      evidence,
      predicate: (report) => report.outcome === 'FAILURE',
    })
    expect(held._tag).toBe('PASS')
  })
})
