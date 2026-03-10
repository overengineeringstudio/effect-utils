import { Effect } from 'effect'

import type { IngestedArtifact, SessionSourceAdapter } from '../schema/core.ts'
import { CheckpointStore } from './CheckpointStore.ts'

const buildCheckpointKey = (options: { readonly sourceId: string; readonly artifactId: string }) =>
  `${options.sourceId}:${options.artifactId}`

/** Ingest all artifacts from a source using stored checkpoints for incremental reads. */
export const ingestSource = Effect.fn('AgentSessionIngest.SessionIngestor.ingestSource')(
  <TRecord>(adapter: SessionSourceAdapter<TRecord>) =>
    Effect.gen(function* () {
      const checkpointStore = yield* CheckpointStore
      const checkpoints = yield* checkpointStore.list()
      const checkpointsByArtifact = new Map(
        checkpoints
          .filter((checkpoint) => checkpoint.sourceId === adapter.sourceId)
          .map((checkpoint) => [buildCheckpointKey(checkpoint), checkpoint]),
      )
      const artifacts = yield* adapter.discoverArtifacts

      const ingested = yield* Effect.forEach(artifacts, (artifact) =>
        Effect.gen(function* () {
          const checkpoint = checkpointsByArtifact.get(buildCheckpointKey(artifact))
          return yield* adapter.ingestArtifact({
            artifact,
            checkpoint,
          })
        }),
      )

      yield* checkpointStore.saveAll(ingested.map((entry) => entry.checkpoint))

      return ingested satisfies ReadonlyArray<IngestedArtifact<TRecord>>
    }),
)
