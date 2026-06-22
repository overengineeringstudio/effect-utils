import { NodeContext } from '@effect/platform-node'
import { Layer, Ref, Schema, Effect } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import type { IngestionCheckpoint, SessionSourceAdapter } from './schema/core.ts'
import {
  ArtifactDescriptor,
  ArtifactId,
  IngestionCheckpoint as IngestionCheckpointSchema,
  SourceId,
} from './schema/core.ts'
import { buildCheckpointKey, CheckpointStore } from './services/CheckpointStore.ts'
import { ingestSource } from './services/SessionIngestor.ts'

const makeCheckpoint = (options: {
  readonly sourceId: SourceId
  readonly artifactId: ArtifactId
  readonly offsetBytes: number
}) =>
  Schema.decodeUnknownSync(IngestionCheckpointSchema)({
    sourceId: options.sourceId,
    artifactId: options.artifactId,
    path: `/tmp/${options.sourceId}/${options.artifactId}.jsonl`,
    status: 'stable',
    cursor: {
      _tag: 'AppendOnlyCursor',
      offsetBytes: options.offsetBytes,
      contentVersion: {
        sizeBytes: options.offsetBytes,
        modifiedAtEpochMs: options.offsetBytes,
        headHash: `head-${options.artifactId}`,
        tailHash: `tail-${options.artifactId}`,
      },
    },
    updatedAtEpochMs: options.offsetBytes,
  })

Vitest.describe('agent-session-ingest services', () => {
  Vitest.it.effect('builds unambiguous checkpoint keys', () =>
    Effect.gen(function* () {
      const left = buildCheckpointKey({
        // @effect-diagnostics-next-line schemaSyncInEffect:off -- hardcoded invariant-valid test literal; a decode failure here is a desirable test failure, not a runtime path
        sourceId: Schema.decodeUnknownSync(SourceId)('a:b'),
        // @effect-diagnostics-next-line schemaSyncInEffect:off -- hardcoded invariant-valid test literal; a decode failure here is a desirable test failure, not a runtime path
        artifactId: Schema.decodeUnknownSync(ArtifactId)('c'),
      })
      const right = buildCheckpointKey({
        // @effect-diagnostics-next-line schemaSyncInEffect:off -- hardcoded invariant-valid test literal; a decode failure here is a desirable test failure, not a runtime path
        sourceId: Schema.decodeUnknownSync(SourceId)('a'),
        // @effect-diagnostics-next-line schemaSyncInEffect:off -- hardcoded invariant-valid test literal; a decode failure here is a desirable test failure, not a runtime path
        artifactId: Schema.decodeUnknownSync(ArtifactId)('b:c'),
      })
      expect(left).not.toBe(right)
    }),
  )

  Vitest.it.effect('preserves unrelated checkpoints when ingesting one source', () =>
    Effect.gen(function* () {
      const savedRef = yield* Ref.make<ReadonlyArray<IngestionCheckpoint>>([])
      // @effect-diagnostics-next-line schemaSyncInEffect:off -- hardcoded invariant-valid test literal; a decode failure here is a desirable test failure, not a runtime path
      const codexSourceId = Schema.decodeUnknownSync(SourceId)('codex')
      // @effect-diagnostics-next-line schemaSyncInEffect:off -- hardcoded invariant-valid test literal; a decode failure here is a desirable test failure, not a runtime path
      const claudeSourceId = Schema.decodeUnknownSync(SourceId)('claude')
      // @effect-diagnostics-next-line schemaSyncInEffect:off -- hardcoded invariant-valid test literal; a decode failure here is a desirable test failure, not a runtime path
      const otherArtifactId = Schema.decodeUnknownSync(ArtifactId)('other-artifact')
      // @effect-diagnostics-next-line schemaSyncInEffect:off -- hardcoded invariant-valid test literal; a decode failure here is a desirable test failure, not a runtime path
      const claudeArtifactId = Schema.decodeUnknownSync(ArtifactId)('claude-artifact')
      // @effect-diagnostics-next-line schemaSyncInEffect:off -- hardcoded invariant-valid test literal; a decode failure here is a desirable test failure, not a runtime path
      const targetArtifactId = Schema.decodeUnknownSync(ArtifactId)('target-artifact')
      const existingCheckpoints = [
        makeCheckpoint({
          sourceId: codexSourceId,
          artifactId: otherArtifactId,
          offsetBytes: 10,
        }),
        makeCheckpoint({
          sourceId: claudeSourceId,
          artifactId: claudeArtifactId,
          offsetBytes: 20,
        }),
      ]

      const checkpointLayer = Layer.succeed(CheckpointStore, {
        list: () => Effect.succeed(existingCheckpoints),
        saveAll: (checkpoints) => Ref.set(savedRef, checkpoints),
      })

      // @effect-diagnostics-next-line schemaSyncInEffect:off -- hardcoded invariant-valid test literal; a decode failure here is a desirable test failure, not a runtime path
      const artifact = Schema.decodeUnknownSync(ArtifactDescriptor)({
        sourceId: codexSourceId,
        artifactId: targetArtifactId,
        path: '/tmp/codex/target-artifact.jsonl',
        status: 'stable',
      })

      const adapter: SessionSourceAdapter<{ readonly _tag: 'Record' }> = {
        sourceId: artifact.sourceId,
        discoverArtifacts: Effect.succeed([artifact]),
        ingestArtifact: () =>
          Effect.succeed({
            artifact,
            records: [{ _tag: 'Record' as const }],
            checkpoint: makeCheckpoint({
              sourceId: codexSourceId,
              artifactId: targetArtifactId,
              offsetBytes: 30,
            }),
          }),
      }

      yield* ingestSource(adapter).pipe(
        Effect.provide(Layer.mergeAll(NodeContext.layer, checkpointLayer)),
      )

      const saved = yield* Ref.get(savedRef)
      expect(saved).toHaveLength(3)
      expect(
        saved.find((checkpoint) => checkpoint.artifactId === 'other-artifact')?.cursor._tag,
      ).toBe('AppendOnlyCursor')
      expect(
        saved.find((checkpoint) => checkpoint.artifactId === 'claude-artifact')?.cursor._tag,
      ).toBe('AppendOnlyCursor')
      expect(saved.find((checkpoint) => checkpoint.artifactId === 'target-artifact')).toBeDefined()
    }),
  )
})
