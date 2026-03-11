import type { FileSystem } from '@effect/platform'
import type { Effect } from 'effect'
import { Schema } from 'effect'

import type { SessionIngestError, SessionSourceDiscoveryError } from '../errors.ts'

/** Stable logical identifier for a session source such as `codex`. */
export const SourceId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand('SourceId'),
  Schema.annotations({ identifier: 'AgentSessionIngest.SourceId' }),
)
export type SourceId = typeof SourceId.Type

/** Stable per-source identifier for one discoverable session artifact. */
export const ArtifactId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.brand('ArtifactId'),
  Schema.annotations({ identifier: 'AgentSessionIngest.ArtifactId' }),
)
export type ArtifactId = typeof ArtifactId.Type

/** Filesystem path to a discovered source artifact. */
export const ArtifactPath = Schema.String.pipe(
  Schema.minLength(1),
  Schema.annotations({ identifier: 'AgentSessionIngest.ArtifactPath' }),
)
export type ArtifactPath = typeof ArtifactPath.Type

/** Artifact lifecycle classification used to decide how aggressively to reprocess it. */
export const ArtifactStatus = Schema.Literal('open', 'stable', 'finalized').annotations({
  identifier: 'AgentSessionIngest.ArtifactStatus',
})
export type ArtifactStatus = typeof ArtifactStatus.Type

/** Source descriptor returned by source discovery before ingestion begins. */
export const ArtifactDescriptor = Schema.Struct({
  sourceId: SourceId,
  artifactId: ArtifactId,
  path: ArtifactPath,
  status: ArtifactStatus,
}).annotations({ identifier: 'AgentSessionIngest.ArtifactDescriptor' })
export type ArtifactDescriptor = typeof ArtifactDescriptor.Type

/** Compact content signature used to detect artifact growth, rewrites, or truncation. */
export const ContentVersion = Schema.Struct({
  sizeBytes: Schema.NonNegativeInt,
  modifiedAtEpochMs: Schema.NonNegativeInt,
  tailHash: Schema.NonEmptyTrimmedString,
}).annotations({ identifier: 'AgentSessionIngest.ContentVersion' })
export type ContentVersion = typeof ContentVersion.Type

/** Cursor for append-only artifacts that can be resumed from a byte offset. */
export const AppendOnlyCursor = Schema.TaggedStruct('AppendOnlyCursor', {
  offsetBytes: Schema.NonNegativeInt,
  contentVersion: ContentVersion,
}).annotations({ identifier: 'AgentSessionIngest.AppendOnlyCursor' })
export type AppendOnlyCursor = typeof AppendOnlyCursor.Type

/** Cursor for mutable artifacts that are re-read when the content signature changes. */
export const ContentVersionCursor = Schema.TaggedStruct('ContentVersionCursor', {
  contentVersion: ContentVersion,
}).annotations({ identifier: 'AgentSessionIngest.ContentVersionCursor' })
export type ContentVersionCursor = typeof ContentVersionCursor.Type

/** Cursor for ordered mutable artifacts that support incremental replay via an update watermark. */
export const UpdatedAtCursor = Schema.TaggedStruct('UpdatedAtCursor', {
  updatedAtEpochMs: Schema.NonNegativeInt,
  contentVersion: ContentVersion,
}).annotations({ identifier: 'AgentSessionIngest.UpdatedAtCursor' })
export type UpdatedAtCursor = typeof UpdatedAtCursor.Type

/** Unified cursor union used by checkpoint persistence. */
export const ArtifactCursor = Schema.Union(
  AppendOnlyCursor,
  ContentVersionCursor,
  UpdatedAtCursor,
).annotations({ identifier: 'AgentSessionIngest.ArtifactCursor' })
export type ArtifactCursor = typeof ArtifactCursor.Type

/** Persisted checkpoint entry for one source artifact. */
export const IngestionCheckpoint = Schema.Struct({
  sourceId: SourceId,
  artifactId: ArtifactId,
  path: ArtifactPath,
  status: ArtifactStatus,
  cursor: ArtifactCursor,
  updatedAtEpochMs: Schema.NonNegativeInt,
}).annotations({ identifier: 'AgentSessionIngest.IngestionCheckpoint' })
export type IngestionCheckpoint = typeof IngestionCheckpoint.Type

/** JSONL codec used for checkpoint files on disk. */
export const IngestionCheckpointJsonLine = Schema.parseJson(IngestionCheckpoint).annotations({
  identifier: 'AgentSessionIngest.IngestionCheckpointJsonLine',
})

/** Result of reading the unread suffix of an append-only text artifact. */
export interface AppendOnlyReadResult {
  readonly text: string
  readonly contentVersion: ContentVersion
  readonly nextOffsetBytes: number
  readonly resetToStart: boolean
}

/** Result of checking a mutable artifact for content changes. */
export interface MutableReadResult {
  readonly content: string
  readonly contentVersion: ContentVersion
  readonly changed: boolean
}

/** Fully ingested artifact bundle with decoded records and the next checkpoint entry. */
export interface IngestedArtifact<TRecord> {
  readonly artifact: ArtifactDescriptor
  readonly records: ReadonlyArray<TRecord>
  readonly checkpoint: IngestionCheckpoint
}

/** Source adapter contract used by janitor and other consumers to ingest session artifacts. */
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
