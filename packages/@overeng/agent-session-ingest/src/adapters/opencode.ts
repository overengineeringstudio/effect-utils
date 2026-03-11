import { DatabaseSync } from 'node:sqlite'

import { Effect, Schema } from 'effect'

import {
  SessionArtifactDecodeError,
  SessionArtifactReadError,
  SessionCheckpointDecodeError,
  SessionSourceDiscoveryError,
} from '../errors.ts'
import { readFileContentVersion } from '../files/content-version.ts'
import type { SessionSourceAdapter } from '../schema/core.ts'
import { ArtifactDescriptor, IngestionCheckpoint, SourceId } from '../schema/core.ts'

const OpenCodeSessionRow = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  directory: Schema.String,
  title: Schema.String,
  version: Schema.String,
  time_created: Schema.NonNegativeInt,
  time_updated: Schema.NonNegativeInt,
  time_archived: Schema.optional(Schema.NullOr(Schema.NonNegativeInt)),
}).annotations({ identifier: 'AgentSessionIngest.OpenCodeSessionRow' })

const OpenCodeMessageData = Schema.Struct({
  role: Schema.String,
  time: Schema.optional(Schema.Unknown),
  parentID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  providerID: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  path: Schema.optional(
    Schema.Struct({
      cwd: Schema.String,
      root: Schema.optional(Schema.String),
    }),
  ),
  summary: Schema.optional(Schema.Unknown),
}).annotations({ identifier: 'AgentSessionIngest.OpenCodeMessageData' })

const OpenCodeMessageRecord = Schema.Struct({
  _tag: Schema.Literal('OpenCodeMessage'),
  id: Schema.String,
  sessionId: Schema.String,
  timeCreated: Schema.NonNegativeInt,
  timeUpdated: Schema.NonNegativeInt,
  data: OpenCodeMessageData,
}).annotations({ identifier: 'AgentSessionIngest.OpenCodeMessageRecord' })

const OpenCodePartToolData = Schema.Struct({
  type: Schema.Literal('tool'),
  callID: Schema.String,
  tool: Schema.String,
  state: Schema.Struct({
    status: Schema.String,
    input: Schema.Unknown,
    output: Schema.optional(Schema.Unknown),
    title: Schema.optional(Schema.String),
    metadata: Schema.optional(Schema.Unknown),
    time: Schema.optional(Schema.Unknown),
  }),
}).annotations({ identifier: 'AgentSessionIngest.OpenCodePartToolData' })

const OpenCodePartTextData = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String,
}).annotations({ identifier: 'AgentSessionIngest.OpenCodePartTextData' })

const OpenCodePartReasoningData = Schema.Struct({
  type: Schema.Literal('reasoning'),
  text: Schema.String,
  metadata: Schema.optional(Schema.Unknown),
}).annotations({ identifier: 'AgentSessionIngest.OpenCodePartReasoningData' })

const OpenCodePartStepStartData = Schema.Struct({
  type: Schema.Literal('step-start'),
  text: Schema.optional(Schema.String),
}).annotations({ identifier: 'AgentSessionIngest.OpenCodePartStepStartData' })

const OpenCodePartStepFinishData = Schema.Struct({
  type: Schema.Literal('step-finish'),
  reason: Schema.optional(Schema.String),
  snapshot: Schema.optional(Schema.String),
  cost: Schema.optional(Schema.Number),
  tokens: Schema.optional(Schema.Unknown),
}).annotations({ identifier: 'AgentSessionIngest.OpenCodePartStepFinishData' })

const OpenCodePartPatchData = Schema.Struct({
  type: Schema.Literal('patch'),
  patch: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
}).annotations({ identifier: 'AgentSessionIngest.OpenCodePartPatchData' })

const OpenCodePartFileData = Schema.Struct({
  type: Schema.Literal('file'),
  path: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Unknown),
}).annotations({ identifier: 'AgentSessionIngest.OpenCodePartFileData' })

const OpenCodePartSubtaskData = Schema.Struct({
  type: Schema.Literal('subtask'),
  metadata: Schema.optional(Schema.Unknown),
}).annotations({ identifier: 'AgentSessionIngest.OpenCodePartSubtaskData' })

const OpenCodePartCompactionData = Schema.Struct({
  type: Schema.Literal('compaction'),
  metadata: Schema.optional(Schema.Unknown),
}).annotations({ identifier: 'AgentSessionIngest.OpenCodePartCompactionData' })

const OpenCodePartGenericData = Schema.Struct({
  type: Schema.String,
}).annotations({ identifier: 'AgentSessionIngest.OpenCodePartGenericData' })

const OpenCodePartData = Schema.Union(
  OpenCodePartToolData,
  OpenCodePartTextData,
  OpenCodePartReasoningData,
  OpenCodePartStepStartData,
  OpenCodePartStepFinishData,
  OpenCodePartPatchData,
  OpenCodePartFileData,
  OpenCodePartSubtaskData,
  OpenCodePartCompactionData,
  OpenCodePartGenericData,
).annotations({ identifier: 'AgentSessionIngest.OpenCodePartData' })

const OpenCodePartRecord = Schema.Struct({
  _tag: Schema.Literal('OpenCodePart'),
  id: Schema.String,
  sessionId: Schema.String,
  timeCreated: Schema.NonNegativeInt,
  timeUpdated: Schema.NonNegativeInt,
  data: OpenCodePartData,
}).annotations({ identifier: 'AgentSessionIngest.OpenCodePartRecord' })

const OpenCodeSessionRecord = Schema.Struct({
  _tag: Schema.Literal('OpenCodeSession'),
  session: OpenCodeSessionRow,
}).annotations({ identifier: 'AgentSessionIngest.OpenCodeSessionRecord' })

/** Source-of-truth record union for OpenCode session storage. */
export const OpenCodeRecord = Schema.Union(
  OpenCodeSessionRecord,
  OpenCodeMessageRecord,
  OpenCodePartRecord,
).annotations({ identifier: 'AgentSessionIngest.OpenCodeRecord' })
export type OpenCodeRecord = typeof OpenCodeRecord.Type

const withReadonlyDb = <TValue>(options: {
  readonly path: string
  readonly f: (database: DatabaseSync) => TValue
}): Effect.Effect<TValue, SessionArtifactReadError> =>
  Effect.try({
    try: () => {
      const database = new DatabaseSync(options.path, { readOnly: true })
      try {
        return options.f(database)
      } finally {
        database.close()
      }
    },
    catch: (cause) =>
      new SessionArtifactReadError({
        message: 'Failed to query OpenCode session database',
        path: options.path,
        cause,
      }),
  })

/** Adapter for incremental ingestion of OpenCode session records from the local SQLite store. */
export const makeOpenCodeAdapter = (options: {
  readonly databasePath: string
  readonly sourceId?: string
}): SessionSourceAdapter<OpenCodeRecord> => ({
  sourceId: Schema.decodeUnknownSync(SourceId)(options.sourceId ?? 'opencode'),
  discoverArtifacts: withReadonlyDb({
    path: options.databasePath,
    f: (database) =>
      database
        .prepare(
          `
            select id, time_archived
            from session
            order by time_updated desc
          `,
        )
        .all()
        .map((row) =>
          Schema.decodeUnknownSync(ArtifactDescriptor)({
            sourceId: options.sourceId ?? 'opencode',
            artifactId: String(row.id),
            path: options.databasePath,
            status: row.time_archived === null ? 'stable' : 'finalized',
          }),
        ),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SessionSourceDiscoveryError({
          message: 'Failed to discover OpenCode sessions',
          sourceId: options.sourceId ?? 'opencode',
          cause,
        }),
    ),
  ),
  ingestArtifact: ({ artifact, checkpoint }) =>
    Effect.gen(function* () {
      const contentVersion = yield* readFileContentVersion(artifact.path)
      const previousCursor =
        checkpoint?.cursor._tag === 'UpdatedAtCursor' ? checkpoint.cursor : undefined

      const sessionRow = yield* withReadonlyDb({
        path: artifact.path,
        f: (database) =>
          database
            .prepare(
              `
                select id, slug, directory, title, version, time_created, time_updated, time_archived
                from session
                where id = ?
              `,
            )
            .get(artifact.artifactId),
      })

      if (sessionRow === undefined) {
        return {
          artifact,
          records: [] as Array<OpenCodeRecord>,
          checkpoint: yield* Schema.decodeUnknown(IngestionCheckpoint)({
            sourceId: artifact.sourceId,
            artifactId: artifact.artifactId,
            path: artifact.path,
            status: artifact.status,
            cursor: {
              _tag: 'UpdatedAtCursor',
              updatedAtEpochMs: previousCursor?.updatedAtEpochMs ?? 0,
              contentVersion,
            },
            updatedAtEpochMs: Date.now(),
          }).pipe(
            Effect.mapError(
              (cause) =>
                new SessionCheckpointDecodeError({
                  message: 'Failed to decode OpenCode checkpoint for missing session',
                  path: artifact.path,
                  cause,
                }),
            ),
          ),
        }
      }

      const session = yield* Schema.decodeUnknown(OpenCodeSessionRow)(sessionRow).pipe(
        Effect.mapError(
          (cause) =>
            new SessionArtifactDecodeError({
              message: 'Failed to decode OpenCode session row',
              sourceId: artifact.sourceId,
              artifactId: artifact.artifactId,
              rawRecord: JSON.stringify(sessionRow),
              cause,
            }),
        ),
      )

      const sameContentVersion =
        previousCursor?.contentVersion.sizeBytes === contentVersion.sizeBytes &&
        previousCursor?.contentVersion.modifiedAtEpochMs === contentVersion.modifiedAtEpochMs &&
        previousCursor?.contentVersion.tailHash === contentVersion.tailHash

      const resetToFullReplay =
        previousCursor !== undefined && session.time_updated < previousCursor.updatedAtEpochMs
      const watermark = resetToFullReplay === true ? 0 : (previousCursor?.updatedAtEpochMs ?? 0)

      if (sameContentVersion === true) {
        return {
          artifact,
          records: [] as Array<OpenCodeRecord>,
          checkpoint: yield* Schema.decodeUnknown(IngestionCheckpoint)({
            sourceId: artifact.sourceId,
            artifactId: artifact.artifactId,
            path: artifact.path,
            status: artifact.status,
            cursor: {
              _tag: 'UpdatedAtCursor',
              updatedAtEpochMs: previousCursor?.updatedAtEpochMs ?? session.time_updated,
              contentVersion,
            },
            updatedAtEpochMs: Date.now(),
          }).pipe(
            Effect.mapError(
              (cause) =>
                new SessionCheckpointDecodeError({
                  message: 'Failed to decode unchanged OpenCode checkpoint',
                  path: artifact.path,
                  cause,
                }),
            ),
          ),
        }
      }

      const messageRows = yield* withReadonlyDb({
        path: artifact.path,
        f: (database) =>
          database
            .prepare(
              `
                select id, session_id, time_created, time_updated, data
                from message
                where session_id = ? and time_updated > ?
                order by time_updated asc, id asc
              `,
            )
            .all(artifact.artifactId, watermark),
      })

      const partRows = yield* withReadonlyDb({
        path: artifact.path,
        f: (database) =>
          database
            .prepare(
              `
                select id, session_id, time_created, time_updated, data
                from part
                where session_id = ? and time_updated > ?
                order by time_updated asc, id asc
              `,
            )
            .all(artifact.artifactId, watermark),
      })

      const sessionRecord = yield* Schema.decodeUnknown(OpenCodeSessionRecord)({
        _tag: 'OpenCodeSession',
        session,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SessionArtifactDecodeError({
              message: 'Failed to decode OpenCode session record',
              sourceId: artifact.sourceId,
              artifactId: artifact.artifactId,
              rawRecord: JSON.stringify(session),
              cause,
            }),
        ),
      )

      const messageRecords = yield* Effect.forEach(messageRows, (row) =>
        Schema.decodeUnknown(OpenCodeMessageRecord)({
          _tag: 'OpenCodeMessage',
          id: row.id,
          sessionId: row.session_id,
          timeCreated: row.time_created,
          timeUpdated: row.time_updated,
          data: JSON.parse(String(row.data)),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new SessionArtifactDecodeError({
                message: 'Failed to decode OpenCode message record',
                sourceId: artifact.sourceId,
                artifactId: artifact.artifactId,
                rawRecord: JSON.stringify(row),
                cause,
              }),
          ),
        ),
      )

      const partRecords = yield* Effect.forEach(partRows, (row) =>
        Schema.decodeUnknown(OpenCodePartRecord)({
          _tag: 'OpenCodePart',
          id: row.id,
          sessionId: row.session_id,
          timeCreated: row.time_created,
          timeUpdated: row.time_updated,
          data: JSON.parse(String(row.data)),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new SessionArtifactDecodeError({
                message: 'Failed to decode OpenCode part record',
                sourceId: artifact.sourceId,
                artifactId: artifact.artifactId,
                rawRecord: JSON.stringify(row),
                cause,
              }),
          ),
        ),
      )

      const records =
        previousCursor === undefined ||
        resetToFullReplay === true ||
        session.time_updated > watermark
          ? [sessionRecord, ...messageRecords, ...partRecords]
          : [...messageRecords, ...partRecords]

      const nextWatermark = Math.max(
        session.time_updated,
        ...messageRecords.map((record) => record.timeUpdated),
        ...partRecords.map((record) => record.timeUpdated),
        previousCursor?.updatedAtEpochMs ?? 0,
      )

      return {
        artifact,
        records,
        checkpoint: yield* Schema.decodeUnknown(IngestionCheckpoint)({
          sourceId: artifact.sourceId,
          artifactId: artifact.artifactId,
          path: artifact.path,
          status: artifact.status,
          cursor: {
            _tag: 'UpdatedAtCursor',
            updatedAtEpochMs: nextWatermark,
            contentVersion,
          },
          updatedAtEpochMs: Date.now(),
        }).pipe(
          Effect.mapError(
            (cause) =>
              new SessionCheckpointDecodeError({
                message: 'Failed to decode OpenCode ingestion checkpoint',
                path: artifact.path,
                cause,
              }),
          ),
        ),
      }
    }),
})
