import * as nodePath from 'node:path'

import { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import { SessionArtifactDecodeError, SessionSourceDiscoveryError } from '../errors.ts'
import { readAppendOnlyTextFileSince } from '../files/append-only.ts'
import type { SessionSourceAdapter } from '../schema/core.ts'
import { ArtifactDescriptor, IngestionCheckpoint, SourceId } from '../schema/core.ts'

export const CcSafetyNetEntry = Schema.Struct({
  ts: Schema.DateTimeUtc,
  command: Schema.NonEmptyTrimmedString,
  segment: Schema.NonEmptyTrimmedString,
  reason: Schema.NonEmptyTrimmedString,
  cwd: Schema.NonEmptyTrimmedString,
}).annotations({ identifier: 'AgentSessionIngest.CcSafetyNetEntry' })
export type CcSafetyNetEntry = typeof CcSafetyNetEntry.Type

export const makeCcSafetyNetAdapter = (options: {
  readonly logsDir: string
  readonly sourceId?: string
}): SessionSourceAdapter<CcSafetyNetEntry> => ({
  sourceId: Schema.decodeUnknownSync(SourceId)(options.sourceId ?? 'cc-safety-net'),
  discoverArtifacts: Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(options.logsDir)
    if (!exists) return [] as Array<typeof ArtifactDescriptor.Type>

    const entries = yield* fs.readDirectory(options.logsDir)
    return entries
      .filter((entry) => entry.endsWith('.jsonl'))
      .toSorted()
      .map((entry) =>
        Schema.decodeUnknownSync(ArtifactDescriptor)({
          sourceId: options.sourceId ?? 'cc-safety-net',
          artifactId: nodePath.basename(entry, '.jsonl'),
          path: nodePath.join(options.logsDir, entry),
          status: 'stable',
        }),
      )
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SessionSourceDiscoveryError({
          message: 'Failed to discover cc-safety-net logs',
          sourceId: options.sourceId ?? 'cc-safety-net',
          cause,
        }),
    ),
  ),
  ingestArtifact: ({ artifact, checkpoint }) =>
    Effect.gen(function* () {
      const read = yield* readAppendOnlyTextFileSince({
        path: artifact.path,
        offsetBytes:
          checkpoint?.cursor._tag === 'AppendOnlyCursor' ? checkpoint.cursor.offsetBytes : 0,
      })

      const records = yield* Effect.forEach(
        read.text
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
        (line) =>
          Schema.decodeUnknown(Schema.parseJson(CcSafetyNetEntry))(line).pipe(
            Effect.mapError(
              (cause) =>
                new SessionArtifactDecodeError({
                  message: 'Failed to decode cc-safety-net entry',
                  sourceId: artifact.sourceId,
                  artifactId: artifact.artifactId,
                  rawRecord: line,
                  cause,
                }),
            ),
          ),
      )

      return {
        artifact,
        records,
        checkpoint: Schema.decodeUnknownSync(IngestionCheckpoint)({
          sourceId: artifact.sourceId,
          artifactId: artifact.artifactId,
          path: artifact.path,
          status: artifact.status,
          cursor: {
            _tag: 'AppendOnlyCursor',
            offsetBytes: read.nextOffsetBytes,
            contentVersion: read.contentVersion,
          },
          updatedAtEpochMs: Date.now(),
        }),
      }
    }),
})
