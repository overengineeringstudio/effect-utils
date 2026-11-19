import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  makeOccurrenceLogAssembler,
  occurrenceLogLimits,
} from './buck2-occurrence-log-envelope.ts'

const snapshot = (lines: string[]) => {
  const body = `${lines.join('\n')}\n`
  const snapshotSha256 = createHash('sha256').update(body).digest('hex')
  return {
    body,
    envelopes: lines.map((line, ordinal) => ({
      type: 'buck2.occurrence.ledger' as const,
      version: 1 as const,
      snapshotSha256,
      ordinal,
      recordCount: lines.length,
      line,
    })),
  }
}

// The transport must preserve even unsupported native rows for the existing strict codec.
describe('occurrence log envelopes', () => {
  it('reconstructs exact UTF-8 bytes, order and terminal LF despite replay', () => {
    const input = snapshot(['{"type":"conversion","name":"雪"}', '{"type":"occurrence"}'])
    const assembler = makeOccurrenceLogAssembler()
    for (const envelope of [...input.envelopes].reverse()) {
      assembler.add(envelope)
      assembler.add(envelope)
    }
    expect(assembler.finish()).toEqual({
      files: [{ name: `occurrence-log-${input.envelopes[0]!.snapshotSha256}.jsonl`, body: input.body }],
      evidenceGaps: [],
    })
  })

  it('never emits a snapshot with a missing ordinal', () => {
    const input = snapshot(['header', 'row'])
    const assembler = makeOccurrenceLogAssembler()
    assembler.add(input.envelopes[0]!)
    expect(assembler.finish()).toEqual({
      files: [], evidenceGaps: ['occurrence-log-incomplete-snapshot'],
    })
  })

  it('excludes a conflicting duplicate even after every original row arrived', () => {
    const input = snapshot(['header', 'row'])
    const assembler = makeOccurrenceLogAssembler()
    for (const envelope of input.envelopes) assembler.add(envelope)
    assembler.add({ ...input.envelopes[1]!, line: 'different' })
    expect(assembler.finish().files).toEqual([])
    expect(assembler.finish().evidenceGaps).toContain('occurrence-log-conflicting-line')
  })

  it('excludes conflicting record counts and wrong whole-snapshot hashes', () => {
    const input = snapshot(['header', 'row'])
    const assembler = makeOccurrenceLogAssembler()
    assembler.add(input.envelopes[0]!)
    assembler.add({ ...input.envelopes[1]!, recordCount: 3 })
    expect(assembler.finish().evidenceGaps).toContain('occurrence-log-conflicting-snapshot')
    const wrongHash = makeOccurrenceLogAssembler()
    for (const envelope of input.envelopes) wrongHash.add({ ...envelope, snapshotSha256: 'a'.repeat(64) })
    expect(wrongHash.finish()).toEqual({
      files: [], evidenceGaps: ['occurrence-log-snapshot-hash-mismatch'],
    })
  })

  it('rejects raw newlines, invalid ordinals and unbounded declared counts', () => {
    const envelope = snapshot(['header']).envelopes[0]!
    for (const invalid of [
      { line: 'one\ntwo' }, { line: 'one\rtwo' }, { ordinal: -1 },
      { ordinal: 0.5 }, { recordCount: Number.MAX_SAFE_INTEGER },
    ]) {
      const assembler = makeOccurrenceLogAssembler()
      assembler.add({ ...envelope, ...invalid })
      expect(assembler.finish().files).toEqual([])
      expect(assembler.finish().evidenceGaps).toContain('occurrence-log-invalid-envelope')
    }
  })

  it('caps reconstructed bytes before retaining an oversized row', () => {
    const assembler = makeOccurrenceLogAssembler()
    assembler.add({
      ...snapshot(['header']).envelopes[0]!,
      line: 'x'.repeat(occurrenceLogLimits.snapshotBytes),
    })
    expect(assembler.finish().files).toEqual([])
    expect(assembler.finish().evidenceGaps).toContain('occurrence-log-snapshot-byte-overflow')
  })
})
