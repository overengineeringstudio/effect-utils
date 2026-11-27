import { Console, Effect, Schema } from 'effect'
import * as Cli from 'effect/cli'

import { readPoolProvenance } from '../../../store/store-pool-state.ts'
import { Store, StoreLayer } from '../../../store/store.ts'
import * as Observability from '../../observability.ts'

const encodeSnapshot = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const poolSnapshotCommand = Cli.Command.make('snapshot', {}, () =>
  Effect.gen(function* () {
    const store = yield* Store
    const snapshot = yield* readPoolProvenance({ base: store.basePath })
    // Machine-readable recorded metadata, never a scan or removal authorization.
    yield* Console.log(yield* encodeSnapshot(snapshot))
  }).pipe(
    Effect.provide(StoreLayer),
    Observability.withCommandSpan({
      name: 'megarepo/store/pool/snapshot',
      command: 'store pool snapshot',
    }),
  ),
).pipe(
  Cli.Command.withDescription('Read pool ledger metadata as JSON (always HOLD; never removal authority)'),
)

/** Pool commands share the canonical store owner; observation performs no physical action. */
export const storePoolCommand = Cli.Command.make('pool', {}).pipe(
  Cli.Command.withSubcommands([poolSnapshotCommand]),
  Cli.Command.withDescription('Observe bounded worktree pool metadata without changing the pool'),
)
