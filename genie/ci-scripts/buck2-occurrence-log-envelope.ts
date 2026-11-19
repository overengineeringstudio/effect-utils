import { createHash } from 'node:crypto'

import { Schema } from 'effect'

import type { RetainedOccurrenceFile } from './buck2-occurrence-record-codec.ts'

/** Transport metadata never substitutes for the strict native records inside each line. */
export const OccurrenceLogEnvelope = Schema.Struct({
  type: Schema.Literal('buck2.occurrence.ledger'),
  version: Schema.Literal(1),
  snapshotSha256: Schema.String,
  ordinal: Schema.Number,
  recordCount: Schema.Number,
  line: Schema.String,
})

type Snapshot = {
  count: number
  bytes: number
  lines: Map<number, string>
  poisoned: boolean
}

export const occurrenceLogLimits = {
  snapshots: 100_000,
  snapshotBytes: 64 * 1024 ** 2,
  totalBytes: 512 * 1024 ** 2,
} as const

/** Bounded, order-independent reconstruction, excluding every conflicted snapshot. */
export const makeOccurrenceLogAssembler = () => {
  const snapshots = new Map<string, Snapshot>()
  const gaps = new Set<string>()
  let bytes = 0
  let stopped = false
  return {
    add: (envelope: typeof OccurrenceLogEnvelope.Type): void => {
      if (stopped === true) return
      const { snapshotSha256: hash, ordinal, recordCount, line } = envelope
      if (
        /^[a-f0-9]{64}$/.test(hash) === false ||
        Number.isSafeInteger(recordCount) === false ||
        recordCount < 1 ||
        recordCount > occurrenceLogLimits.snapshotBytes ||
        Number.isSafeInteger(ordinal) === false ||
        ordinal < 0 ||
        ordinal >= recordCount ||
        line.includes('\n') === true ||
        line.includes('\r') === true ||
        line.length === 0
      ) {
        gaps.add('occurrence-log-invalid-envelope')
        // A bad row claiming a known snapshot must not leave its other rows authoritative.
        const snapshot = snapshots.get(hash)
        if (snapshot !== undefined) snapshot.poisoned = true
        else if (/^[a-f0-9]{64}$/.test(hash) === true) {
          if (snapshots.size >= occurrenceLogLimits.snapshots) {
            stopped = true
            gaps.add('occurrence-log-snapshot-count-overflow')
          } else {
            snapshots.set(hash, { count: 0, bytes: 0, lines: new Map(), poisoned: true })
          }
        }
        return
      }
      let snapshot = snapshots.get(hash)
      if (snapshot === undefined) {
        if (snapshots.size >= occurrenceLogLimits.snapshots) {
          gaps.add('occurrence-log-snapshot-count-overflow')
          stopped = true
          return
        }
        snapshot = { count: recordCount, bytes: 0, lines: new Map(), poisoned: false }
        snapshots.set(hash, snapshot)
      }
      if (snapshot.count !== recordCount) {
        snapshot.poisoned = true
        gaps.add('occurrence-log-conflicting-snapshot')
      }
      const previous = snapshot.lines.get(ordinal)
      if (previous !== undefined) {
        if (previous !== line) {
          snapshot.poisoned = true
          gaps.add('occurrence-log-conflicting-line')
        }
        return
      }
      if (snapshot.poisoned === true) return
      const size = Buffer.byteLength(line, 'utf8') + 1
      bytes += size
      snapshot.bytes += size
      if (bytes > occurrenceLogLimits.totalBytes) {
        stopped = true
        gaps.add('occurrence-log-total-byte-overflow')
        return
      }
      if (snapshot.bytes > occurrenceLogLimits.snapshotBytes) {
        snapshot.poisoned = true
        snapshot.lines.clear()
        gaps.add('occurrence-log-snapshot-byte-overflow')
        return
      }
      snapshot.lines.set(ordinal, line)
    },
    finish: (): { files: RetainedOccurrenceFile[]; evidenceGaps: string[] } => {
      const files: RetainedOccurrenceFile[] = []
      for (const [hash, snapshot] of snapshots) {
        if (snapshot.poisoned === true) continue
        if (snapshot.lines.size !== snapshot.count) {
          gaps.add('occurrence-log-incomplete-snapshot')
          continue
        }
        const body = `${Array.from(snapshot.lines.entries())
          .sort(([a], [b]) => a - b)
          .map(([, line]) => line)
          .join('\n')}\n`
        if (createHash('sha256').update(body, 'utf8').digest('hex') !== hash) {
          gaps.add('occurrence-log-snapshot-hash-mismatch')
          continue
        }
        files.push({ name: `occurrence-log-${hash}.jsonl`, body })
      }
      return { files, evidenceGaps: [...gaps] }
    },
  }
}
