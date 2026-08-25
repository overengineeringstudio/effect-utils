import type { FileSystem } from 'effect'
import { Schedule, Stream } from 'effect'

import type { SessionIngestError, SessionSourceDiscoveryError } from './errors.ts'
import type { IngestedArtifact, SessionSourceAdapter } from './schema/core.ts'
import type { CheckpointStore } from './services/CheckpointStore.ts'
import { ingestSource } from './services/SessionIngestor.ts'

/** Stream that polls a source adapter at a fixed interval, emitting new records. */
export const watchSource = <TRecord>(options: {
  readonly adapter: SessionSourceAdapter<TRecord>
  readonly intervalMs?: number
}): Stream.Stream<
  IngestedArtifact<TRecord>,
  SessionIngestError | SessionSourceDiscoveryError,
  FileSystem.FileSystem | CheckpointStore
> => {
  const interval = options.intervalMs ?? 2000

  return Stream.repeat(
    Stream.fromEffect(ingestSource(options.adapter)),
    Schedule.spaced(interval),
  ).pipe(
    Stream.flatMap((artifacts) => Stream.fromIterable(artifacts)),
    Stream.filter((artifact) => artifact.records.length > 0),
  )
}
