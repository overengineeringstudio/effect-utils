import * as nodePath from 'node:path'

import { FileSystem } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'

import {
  SessionArtifactDecodeError,
  SessionCheckpointDecodeError,
  SessionSourceDiscoveryError,
} from '../errors.ts'
import { readAppendOnlyTextFileSince, splitCompleteJsonlRecords } from '../files/append-only.ts'
import type { SessionSourceAdapter } from '../schema/core.ts'
import { ArtifactDescriptor, IngestionCheckpoint, SourceId } from '../schema/core.ts'

const QueueOperationRecord = Schema.Struct({
  type: Schema.Literal('queue-operation'),
  operation: Schema.Literal('enqueue', 'dequeue'),
  timestamp: Schema.DateTimeUtc,
  sessionId: Schema.String,
  content: Schema.optional(Schema.String),
}).annotations({ identifier: 'AgentSessionIngest.ClaudeQueueOperationRecord' })

const HookProgressData = Schema.Struct({
  type: Schema.String,
  hookEvent: Schema.optional(Schema.String),
  hookName: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
}).annotations({ identifier: 'AgentSessionIngest.ClaudeHookProgressData' })

const ProgressRecord = Schema.Struct({
  type: Schema.Literal('progress'),
  parentUuid: Schema.NullOr(Schema.String),
  isSidechain: Schema.Boolean,
  userType: Schema.String,
  cwd: Schema.String,
  sessionId: Schema.String,
  version: Schema.String,
  gitBranch: Schema.optional(Schema.String),
  agentId: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  parentToolUseID: Schema.optional(Schema.String),
  toolUseID: Schema.optional(Schema.String),
  uuid: Schema.String,
  timestamp: Schema.DateTimeUtc,
  data: HookProgressData,
}).annotations({ identifier: 'AgentSessionIngest.ClaudeProgressRecord' })

const MessageEnvelope = Schema.Struct({
  role: Schema.String,
  content: Schema.Unknown,
}).annotations({ identifier: 'AgentSessionIngest.ClaudeMessageEnvelope' })

const UserRecord = Schema.Struct({
  type: Schema.Literal('user'),
  parentUuid: Schema.NullOr(Schema.String),
  isSidechain: Schema.Boolean,
  userType: Schema.String,
  cwd: Schema.String,
  sessionId: Schema.String,
  version: Schema.String,
  gitBranch: Schema.optional(Schema.String),
  agentId: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  uuid: Schema.String,
  timestamp: Schema.DateTimeUtc,
  permissionMode: Schema.optional(Schema.String),
  sourceToolAssistantUUID: Schema.optional(Schema.String),
  toolUseResult: Schema.optional(Schema.Unknown),
  message: MessageEnvelope,
}).annotations({ identifier: 'AgentSessionIngest.ClaudeUserRecord' })

const AssistantMessagePayload = Schema.Struct({
  model: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  type: Schema.optional(Schema.String),
  role: Schema.Literal('assistant'),
  content: Schema.Unknown,
  stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
  stop_sequence: Schema.optional(Schema.NullOr(Schema.String)),
  usage: Schema.optional(Schema.Unknown),
}).annotations({ identifier: 'AgentSessionIngest.ClaudeAssistantMessagePayload' })

const AssistantRecord = Schema.Struct({
  type: Schema.Literal('assistant'),
  parentUuid: Schema.NullOr(Schema.String),
  isSidechain: Schema.Boolean,
  userType: Schema.String,
  cwd: Schema.String,
  sessionId: Schema.String,
  version: Schema.String,
  gitBranch: Schema.optional(Schema.String),
  agentId: Schema.optional(Schema.String),
  slug: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
  uuid: Schema.String,
  timestamp: Schema.DateTimeUtc,
  message: AssistantMessagePayload,
}).annotations({ identifier: 'AgentSessionIngest.ClaudeAssistantRecord' })

const SystemRecord = Schema.Struct({
  type: Schema.Literal('system'),
  parentUuid: Schema.NullOr(Schema.String),
  isSidechain: Schema.Boolean,
  userType: Schema.optional(Schema.String),
  cwd: Schema.String,
  sessionId: Schema.String,
  version: Schema.String,
  uuid: Schema.String,
  timestamp: Schema.DateTimeUtc,
  content: Schema.Unknown,
}).annotations({ identifier: 'AgentSessionIngest.ClaudeSystemRecord' })

const GenericClaudeRecord = Schema.Struct({
  type: Schema.String,
  sessionId: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.DateTimeUtc),
}).annotations({ identifier: 'AgentSessionIngest.ClaudeGenericRecord' })

/**
 * Source-of-truth record union for Claude project/subagent transcript JSONL artifacts.
 *
 * References:
 * - Native transcript store: `~/.claude/projects/(nested path).jsonl`
 * - Common shared-store target: `~/.claude-shared/projects/(nested path).jsonl`
 */
export const ClaudeSessionRecord = Schema.Union(
  QueueOperationRecord,
  ProgressRecord,
  UserRecord,
  AssistantRecord,
  SystemRecord,
  GenericClaudeRecord,
).annotations({ identifier: 'AgentSessionIngest.ClaudeSessionRecord' })
export type ClaudeSessionRecord = typeof ClaudeSessionRecord.Type

const listClaudeJsonlFiles = Effect.fn('AgentSessionIngest.Claude.listClaudeJsonlFiles')(
  (options: { root: string; discoverySinceEpochMs?: number }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const exists = yield* fs.exists(options.root)
      if (exists !== true) return [] as Array<string>

      const directories = [options.root]
      const files: Array<string> = []

      while (directories.length > 0) {
        const currentDir = directories.pop()
        if (currentDir === undefined) continue

        const entries = yield* fs.readDirectory(currentDir)
        for (const entry of entries) {
          const path = nodePath.join(currentDir, entry)
          const info = yield* fs.stat(path)
          if (info.type === 'Directory') {
            directories.push(path)
            continue
          }

          const modifiedAtEpochMs = Option.getOrUndefined(info.mtime)?.getTime()
          const isRecentEnough =
            options.discoverySinceEpochMs === undefined ||
            modifiedAtEpochMs === undefined ||
            modifiedAtEpochMs >= options.discoverySinceEpochMs

          if (
            info.type === 'File' &&
            entry.endsWith('.jsonl') === true &&
            isRecentEnough === true
          ) {
            files.push(path)
          }
        }
      }

      return files.toSorted()
    }),
)

/**
 * Adapter for incremental ingestion of Claude project transcript JSONL artifacts.
 *
 * References:
 * - Canonical transcript root: `~/.claude/projects`
 * - Shared transcript root: `~/.claude-shared/projects`
 */
export const makeClaudeAdapter = (options: {
  readonly projectsRoot: string
  readonly sourceId?: string
  readonly discoverySinceEpochMs?: number
  readonly initialReadMaxBytes?: number
}): SessionSourceAdapter<ClaudeSessionRecord> => ({
  sourceId: Schema.decodeUnknownSync(SourceId)(options.sourceId ?? 'claude'),
  discoverArtifacts: listClaudeJsonlFiles({
    root: options.projectsRoot,
    ...(options.discoverySinceEpochMs !== undefined && {
      discoverySinceEpochMs: options.discoverySinceEpochMs,
    }),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SessionSourceDiscoveryError({
          message: 'Failed to discover Claude project transcripts',
          sourceId: options.sourceId ?? 'claude',
          cause,
        }),
    ),
    Effect.map((paths) =>
      paths.map((path) =>
        Schema.decodeUnknownSync(ArtifactDescriptor)({
          sourceId: options.sourceId ?? 'claude',
          artifactId: path.slice(options.projectsRoot.length + 1).replaceAll(nodePath.sep, '__'),
          path,
          status:
            path.includes(`${nodePath.sep}subagents${nodePath.sep}`) === true ? 'open' : 'stable',
        }),
      ),
    ),
  ),
  ingestArtifact: ({ artifact, checkpoint }) =>
    Effect.gen(function* () {
      const read = yield* readAppendOnlyTextFileSince({
        path: artifact.path,
        offsetBytes:
          checkpoint?.cursor._tag === 'AppendOnlyCursor' ? checkpoint.cursor.offsetBytes : 0,
        ...(checkpoint?.cursor._tag === 'AppendOnlyCursor' && {
          previousContentVersion: checkpoint.cursor.contentVersion,
        }),
        ...(options.initialReadMaxBytes !== undefined && {
          initialReadMaxBytes: options.initialReadMaxBytes,
        }),
      })

      const records = yield* Effect.forEach(splitCompleteJsonlRecords(read.text), (line) =>
        Schema.decodeUnknown(Schema.parseJson(ClaudeSessionRecord))(line).pipe(
          Effect.mapError(
            (cause) =>
              new SessionArtifactDecodeError({
                message: 'Failed to decode Claude session record',
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
        checkpoint: yield* Schema.decodeUnknown(IngestionCheckpoint)({
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
        }).pipe(
          Effect.mapError(
            (cause) =>
              new SessionCheckpointDecodeError({
                message: 'Failed to decode Claude ingestion checkpoint',
                path: artifact.path,
                cause,
              }),
          ),
        ),
      }
    }),
})
