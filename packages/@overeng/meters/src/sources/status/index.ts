import { Effect, type Scope } from 'effect'

import type { Sample, Series, StatusValue } from '../../series/index.ts'
import { makeSource, type Source, type SourceError } from '../../session/index.ts'

export type { StatusValue } from '../../series/index.ts'

/** Subscribe to an existing host sync/connection feed; never owns a transport. */
export const statusSource = (options: {
  readonly id: string
  readonly series: Series<StatusValue>
  readonly subscribe?: (options: {
    readonly emit: (sample: Sample<StatusValue>) => void
  }) => Effect.Effect<void, SourceError, Scope.Scope>
}): Source<StatusValue> =>
  makeSource({
    id: options.id,
    series: options.series,
    cadence: { _tag: 'Event' },
    start: ({ sink, clock }) => {
      if (options.subscribe === undefined)
        return Effect.sync(() =>
          sink.append({
            sample: { _tag: 'Unavailable', atMs: clock.now(), reason: 'NotConfigured' },
          }),
        )
      return options.subscribe({
        emit: (sample) => sink.append({ sample: { ...sample, atMs: clock.now() } }),
      })
    },
  })
