import type { FileSystem } from '@effect/platform'
import type { Effect } from 'effect'
import { Schema } from 'effect'

import type { SessionIngestError, SessionSourceDiscoveryError } from '../errors.ts'

export const SourceId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand('SourceId'),
  Schema.annotations({ identifier: 'AgentSessionIngest.SourceId' }),
)
export type SourceId = typeof SourceId.Type

export const ArtifactId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand('ArtifactId'),
  Schema.annotations({ identifier: 'AgentSessionIngest.ArtifactId' }),
)
export type ArtifactId = typeof ArtifactId.Type

export const ArtifactPath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.annotations({ identifier: 'AgentSessionIngest.ArtifactPath' }),
)
export type ArtifactPath = typeof ArtifactPath.Type

export const ArtifactStatus = Schema.Literal('open', 'stable', 'finalized').annotations({
  identifier: 'AgentSessionIngest.ArtifactStatus',
})
export type ArtifactStatus = typeof ArtifactStatus.Type

export const ArtifactDescriptor = Schema.Struct({
  sourceId: SourceId,
  artifactId: ArtifactId,
  path: ArtifactPath,
  status: ArtifactStatus,
}).annotations({ identifier: 'AgentSessionIngest.ArtifactDescriptor' })
export type ArtifactDescriptor = typeof ArtifactDescriptor.Type

export const ContentVersion = Schema.Struct({
  sizeBytes: Schema.NonNegativeInt,
  modifiedAtEpochMs: Schema.NonNegativeInt,
  tailHash: Schema.NonEmptyTrimmedString,
}).annotations({ identifier: 'AgentSessionIngest.ContentVersion' })
export type ContentVersion = typeof ContentVersion.Type

export const AppendOnlyCursor = Schema.TaggedStruct('AppendOnlyCursor', {
  offsetBytes: Schema.NonNegativeInt,
  contentVersion: ContentVersion,
}).annotations({ identifier: 'AgentSessionIngest.AppendOnlyCursor' })
export type AppendOnlyCursor = typeof AppendOnlyCursor.Type

export const ContentVersionCursor = Schema.TaggedStruct('ContentVersionCursor', {
  contentVersion: ContentVersion,
}).annotations({ identifier: 'AgentSessionIngest.ContentVersionCursor' })
export type ContentVersionCursor = typeof ContentVersionCursor.Type

export const ArtifactCursor = Schema.Union(AppendOnlyCursor, ContentVersionCursor).annotations({
  identifier: 'AgentSessionIngest.ArtifactCursor',
})
export type ArtifactCursor = typeof ArtifactCursor.Type

export const IngestionCheckpoint = Schema.Struct({
  sourceId: SourceId,
  artifactId: ArtifactId,
  path: ArtifactPath,
  status: ArtifactStatus,
  cursor: ArtifactCursor,
  updatedAtEpochMs: Schema.NonNegativeInt,
}).annotations({ identifier: 'AgentSessionIngest.IngestionCheckpoint' })
export type IngestionCheckpoint = typeof IngestionCheckpoint.Type

export const IngestionCheckpointJsonLine = Schema.parseJson(IngestionCheckpoint).annotations({
  identifier: 'AgentSessionIngest.IngestionCheckpointJsonLine',
})

export interface AppendOnlyReadResult {
  readonly text: string
  readonly contentVersion: ContentVersion
  readonly nextOffsetBytes: number
  readonly resetToStart: boolean
}

export interface MutableReadResult {
  readonly content: string
  readonly contentVersion: ContentVersion
  readonly changed: boolean
}

export interface IngestedArtifact<TRecord> {
  readonly artifact: ArtifactDescriptor
  readonly records: ReadonlyArray<TRecord>
  readonly checkpoint: IngestionCheckpoint
}

export interface SessionSourceAdapter<TRecord> {
  readonly sourceId: SourceId
  readonly discoverArtifacts: Effect.Effect<
    ReadonlyArray<ArtifactDescriptor>,
    SessionSourceDiscoveryError,
    FileSystem.FileSystem
  >
  readonly ingestArtifact: (options: {
    readonly artifact: ArtifactDescriptor
    readonly checkpoint: IngestionCheckpoint | undefined
  }) => Effect.Effect<IngestedArtifact<TRecord>, SessionIngestError, FileSystem.FileSystem>
}
