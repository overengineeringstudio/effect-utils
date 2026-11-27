import { Console, Effect, Schema } from 'effect'
import * as Cli from 'effect/cli'

import { readPoolProvenance } from '../../../store/store-pool-state.ts'
import { Store, StoreLayer } from '../../../store/store.ts'
import * as Observability from '../../observability.ts'
import {
  poolServiceCommand,
  poolWarmCommand,
  poolRunCommand,
  poolResetCommand,
} from './pool-service.ts'

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
  Cli.Command.withDescription(
    'Read pool ledger metadata as JSON (always HOLD; never removal authority)',
  ),
)

/** Physical requests go to one actual host-local custodian; snapshot remains read-only. */
export const storePoolCommand = Cli.Command.make('pool', {}).pipe(
  Cli.Command.withSubcommands([
    poolSnapshotCommand,
    poolServiceCommand,
    poolWarmCommand,
    poolRunCommand,
    poolResetCommand,
  ]),
  Cli.Command.withDescription('Observe or use the bounded host-local worktree pool'),
)
