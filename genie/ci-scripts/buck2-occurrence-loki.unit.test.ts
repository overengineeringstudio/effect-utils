import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { decodeOccurrenceLoki } from './buck2-occurrence-loki.ts'

const body = '{"type":"conversion"}\n{"type":"occurrence"}\n'
const hash = createHash('sha256').update(body).digest('hex')
const envelopes = body.trimEnd().split('\n').map((line, ordinal) => ({
  type: 'buck2.occurrence.ledger', version: 1, snapshotSha256: hash,
  ordinal, recordCount: 2, line,
}))
const response = (rows: unknown[]) => JSON.stringify({
  status: 'success', data: { resultType: 'streams', result: [{
    values: rows.map((row) => ['123456789', JSON.stringify(row)]),
  }] },
})

test('Loki reader reconstructs producer bytes, deduplicating reordered replay', () => {
  expect(decodeOccurrenceLoki(response([envelopes[1], envelopes[0], envelopes[1]])))
    .toEqual([{ name: `loki-${hash}.jsonl`, body }])
  expect(decodeOccurrenceLoki(response([]))).toEqual([])
})

test('Loki reader rejects partial, conflicting, corrupt and capped evidence', () => {
  for (const rows of [
    [envelopes[0]],
    [envelopes[0], { ...envelopes[1], line: 'changed' }],
    [envelopes[0], envelopes[1], { ...envelopes[1], recordCount: 3 }],
    [envelopes[0], { ...envelopes[1], ordinal: -1 }],
    [envelopes[0], { ...envelopes[1], line: 'embedded\nline' }],
    Array.from({ length: 5000 }, () => envelopes[0]),
  ]) expect(() => decodeOccurrenceLoki(response(rows))).toThrow()
  for (const invalid of ['{', '{"status":"error"}', response(['not-an-envelope'])])
    expect(() => decodeOccurrenceLoki(invalid)).toThrow()
})
