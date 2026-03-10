import * as nodePath from 'node:path'

import { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import {
  SessionArtifactDecodeError,
  SessionCheckpointDecodeError,
  SessionSourceDiscoveryError,
} from '../errors.ts'
import { readAppendOnlyTextFileSince } from '../files/append-only.ts'
import type { SessionSourceAdapter } from '../schema/core.ts'
import { ArtifactDescriptor, IngestionCheckpoint, SourceId } from '../schema/core.ts'

const OutputTextPart = Schema.Struct({
  type: Schema.Literal('output_text'),
  text: Schema.String,
})

const MessageResponsePayload = Schema.Struct({
  type: Schema.Literal('message'),
  role: Schema.Literal('assistant', 'user'),
  content: Schema.Array(OutputTextPart),
})

const FunctionCallPayload = Schema.Struct({
  type: Schema.Literal('function_call'),
  name: Schema.String,
  arguments: Schema.String,
  call_id: Schema.String,
})

const FunctionCallOutputPayload = Schema.Struct({
  type: Schema.Literal('function_call_output'),
  call_id: Schema.String,
  output: Schema.String,
})

const SessionMetaPayload = Schema.Struct({
  id: Schema.String,
  timestamp: Schema.String,
  cwd: Schema.String,
  originator: Schema.optional(Schema.String),
  cli_version: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
})

const TokenCountInfo = Schema.Struct({
  total_token_usage: Schema.optional(Schema.Unknown),
  last_token_usage: Schema.optional(Schema.Unknown),
  model_context_window: Schema.optional(Schema.Number),
})

export const CodexSessionRecord = Schema.Union(
  Schema.Struct({
    timestamp: Schema.DateTimeUtc,
    type: Schema.Literal('session_meta'),
    payload: SessionMetaPayload,
  }),
  Schema.Struct({
    timestamp: Schema.DateTimeUtc,
    type: Schema.Literal('response_item'),
    payload: Schema.Union(MessageResponsePayload, FunctionCallPayload, FunctionCallOutputPayload),
  }),
  Schema.Struct({
    timestamp: Schema.DateTimeUtc,
    type: Schema.Literal('event_msg'),
    payload: Schema.Struct({
      type: Schema.String,
      info: Schema.optional(TokenCountInfo),
      rate_limits: Schema.optional(Schema.Unknown),
    }),
  }),
  Schema.Struct({
    timestamp: Schema.DateTimeUtc,
    type: Schema.Literal('turn_context'),
    payload: Schema.Struct({
      cwd: Schema.String,
      approval_policy: Schema.optional(Schema.String),
      sandbox_policy: Schema.optional(Schema.Unknown),
      model: Schema.optional(Schema.String),
      effort: Schema.optional(Schema.String),
      summary: Schema.optional(Schema.String),
    }),
  }),
).annotations({ identifier: 'AgentSessionIngest.CodexSessionRecord' })
export type CodexSessionRecord = typeof CodexSessionRecord.Type

export const CodexSessionIndexEntry = Schema.Struct({
  id: Schema.String,
  thread_name: Schema.String,
  updated_at: Schema.String,
}).annotations({ identifier: 'AgentSessionIngest.CodexSessionIndexEntry' })
export type CodexSessionIndexEntry = typeof CodexSessionIndexEntry.Type

const listJsonlFiles = Effect.fn('AgentSessionIngest.Codex.listJsonlFiles')((root: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(root)
    if (!exists) return [] as Array<string>

    const directories = [root]
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
        if (info.type === 'File' && entry.endsWith('.jsonl')) {
          files.push(path)
        }
      }
    }

    return files.toSorted()
  }),
)

export const makeCodexAdapter = (options: {
  readonly sessionsRoot: string
  readonly sourceId?: string
}): SessionSourceAdapter<CodexSessionRecord> => ({
  sourceId: Schema.decodeUnknownSync(SourceId)(options.sourceId ?? 'codex'),
  discoverArtifacts: listJsonlFiles(options.sessionsRoot).pipe(
    Effect.mapError(
      (cause) =>
        new SessionSourceDiscoveryError({
          message: 'Failed to discover Codex sessions',
          sourceId: options.sourceId ?? 'codex',
          cause,
        }),
    ),
    Effect.map((paths) =>
      paths.map((path: string) =>
        Schema.decodeUnknownSync(ArtifactDescriptor)({
          sourceId: options.sourceId ?? 'codex',
          artifactId: nodePath.basename(path, '.jsonl'),
          path,
          status: 'stable',
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
      })

      const records = yield* Effect.forEach(
        read.text
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
        (line) =>
          Schema.decodeUnknown(Schema.parseJson(CodexSessionRecord))(line).pipe(
            Effect.mapError(
              (cause) =>
                new SessionArtifactDecodeError({
                  message: 'Failed to decode Codex session record',
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
                message: 'Failed to decode Codex ingestion checkpoint',
                path: artifact.path,
                cause,
              }),
          ),
        ),
      }
    }),
})
