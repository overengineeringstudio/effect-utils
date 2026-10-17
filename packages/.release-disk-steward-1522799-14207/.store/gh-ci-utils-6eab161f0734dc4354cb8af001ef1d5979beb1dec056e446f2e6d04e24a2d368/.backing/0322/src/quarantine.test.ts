import { describe, expect, it } from 'vitest'

import {
  decodeQuarantineLedgerJson,
  expiredQuarantineEntries,
  type QuarantineLedger,
  renderQuarantineAnnotation,
  renderQuarantineAnnouncement,
  renderQuarantineSummaryLine,
  resolveQuarantineEntry,
} from './quarantine.ts'

const entry = {
  target: 'tests/integration:devtools',
  reason: 'Every test in the suite fails (0/15).',
  issue: 'https://github.com/livestorejs/livestore/issues/1489',
  expires: '2026-09-30',
}

const ledger: QuarantineLedger = { 'devtools-suite': entry }

describe('ledger decoding', () => {
  it('round-trips a well-formed ledger', () => {
    expect(decodeQuarantineLedgerJson(JSON.stringify(ledger))).toEqual(ledger)
  })

  it('rejects an entry missing its tracking issue', () => {
    const { issue: _issue, ...withoutIssue } = entry
    expect(() =>
      decodeQuarantineLedgerJson(JSON.stringify({ 'devtools-suite': withoutIssue })),
    ).toThrow()
  })

  it('rejects an empty reason, so a quarantine cannot be declared without one', () => {
    expect(() =>
      decodeQuarantineLedgerJson(JSON.stringify({ 'devtools-suite': { ...entry, reason: '' } })),
    ).toThrow()
  })
})

describe('expiry', () => {
  it('flags a lapsed entry and leaves a live one alone', () => {
    expect(expiredQuarantineEntries({ ledger, today: '2026-09-29' })).toEqual([])
    expect(expiredQuarantineEntries({ ledger, today: '2026-10-01' })).toEqual([
      ['devtools-suite', entry],
    ])
  })

  it('treats a malformed expiry as expired rather than never-expiring', () => {
    // Lexicographic comparison puts 'someday' above every real date, so without the format
    // check a typo would silently become a permanent quarantine.
    const malformed: QuarantineLedger = { bad: { ...entry, expires: 'someday' } }
    expect(expiredQuarantineEntries({ ledger: malformed, today: '2026-01-01' })).toHaveLength(1)
  })
})

describe('resolveQuarantineEntry', () => {
  it('returns the entry for a correctly declared quarantine', () => {
    expect(resolveQuarantineEntry({ ledger, key: 'devtools-suite', label: entry.target })).toEqual(
      entry,
    )
  })

  it('refuses a key with no ledger entry', () => {
    expect(() => resolveQuarantineEntry({ ledger, key: 'nope', label: entry.target })).toThrow(
      /has no entry in the ledger/,
    )
  })

  it('refuses an entry applied to a target it does not declare', () => {
    expect(() =>
      resolveQuarantineEntry({ ledger, key: 'devtools-suite', label: 'tests/integration:misc' }),
    ).toThrow(/declares target/)
  })
})

describe('rendering', () => {
  it('names target, reason, issue and expiry in both channels', () => {
    const summary = renderQuarantineAnnouncement({ label: entry.target, entry })

    expect(summary).toMatchInlineSnapshot(
      `"Quarantined failure: tests/integration:devtools — Every test in the suite fails (0/15). Tracking https://github.com/livestorejs/livestore/issues/1489, expires 2026-09-30."`,
    )
    expect(renderQuarantineAnnotation(summary)).toBe(
      `::warning title=Quarantined test failure::${summary}`,
    )
    expect(renderQuarantineSummaryLine(summary)).toBe(`- ${summary}\n`)
  })
})
