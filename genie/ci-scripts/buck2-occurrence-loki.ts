import { createHash } from 'node:crypto'

import { Schema } from 'effect'

import { fail, type RetainedOccurrenceFile } from './buck2-occurrence-record-codec.ts'

export const OccurrenceLokiResponse = Schema.Struct({
  status: Schema.Literal('success'),
  data: Schema.Struct({
    resultType: Schema.Literal('streams'),
    result: Schema.Array(
      Schema.Struct({
        values: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
      }),
    ),
  }),
})
const Envelope = Schema.Struct({
  type: Schema.Literal('buck2.occurrence.ledger'),
  version: Schema.Literal(1),
  snapshotSha256: Schema.String,
  ordinal: Schema.Number,
  recordCount: Schema.Number,
  line: Schema.String,
})

/** Shared native envelope validation for offline reconstruction and the disk ledger. */
export const decodeOccurrenceLokiEnvelope = (line: string): typeof Envelope.Type => {
  const row = Schema.decodeUnknownSync(Schema.fromJsonString(Envelope))(line)
  if (
    !/^[a-f0-9]{64}$/.test(row.snapshotSha256) ||
    !Number.isSafeInteger(row.ordinal) ||
    !Number.isSafeInteger(row.recordCount) ||
    row.ordinal < 0 ||
    row.recordCount < 1 ||
    row.recordCount > 5000 ||
    row.ordinal >= row.recordCount ||
    row.line.includes('\n')
  )
    fail()
  return row
}

/** Rebuild only complete, content-addressed producer snapshots; never invent a header. */
export const decodeOccurrenceLoki = (body: string): RetainedOccurrenceFile[] => {
  const response = Schema.decodeUnknownSync(Schema.fromJsonString(OccurrenceLokiResponse))(body)
  const values = response.data.result.flatMap((stream) => stream.values)
  // The proxy's fixed request limit is 5000. Hitting it cannot certify completeness.
  if (values.length >= 5000) fail()
  return reconstructOccurrenceLokiSnapshots(values.map(([, line]) => line))
}

/** @internal Shared strict reconstruction; the live reader calls this only after exhaustion. */
export const reconstructOccurrenceLokiSnapshots = (
  lines: Iterable<string>,
): RetainedOccurrenceFile[] => {
  const snapshots = new Map<string, { count: number; lines: Map<number, string> }>()
  for (const line of lines) {
    const row = decodeOccurrenceLokiEnvelope(line)
    let snapshot = snapshots.get(row.snapshotSha256)
    if (snapshot === undefined) {
      snapshot = { count: row.recordCount, lines: new Map() }
      snapshots.set(row.snapshotSha256, snapshot)
    }
    if (
      snapshot.count !== row.recordCount ||
      (snapshot.lines.has(row.ordinal) && snapshot.lines.get(row.ordinal) !== row.line)
    )
      fail()
    snapshot.lines.set(row.ordinal, row.line)
  }
  return Array.from(snapshots, ([hash, snapshot]) => {
    if (snapshot.lines.size !== snapshot.count) fail()
    const body =
      Array.from({ length: snapshot.count }, (_, index) => snapshot.lines.get(index)!).join('\n') +
      '\n'
    if (createHash('sha256').update(body).digest('hex') !== hash) fail()
    return { name: `loki-${hash}.jsonl`, body }
  })
}
