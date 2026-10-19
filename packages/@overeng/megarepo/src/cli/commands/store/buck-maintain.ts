import { Console, Effect, Option, Schema } from 'effect'
import * as Cli from 'effect/cli'

import { runBuckMaintain } from '../../../store/store-buck-maintain.ts'
import * as Observability from '../../observability.ts'

const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** Buck owns output deletion and daemon shutdown; mr supplies the maintenance policy. */
export const storeBuckMaintainCommand = Cli.Command.make(
  'buck-maintain',
  {
    configPath: Cli.Flag.String('config').pipe(
      Cli.Flag.withDescription('Path to a version 1 Buck maintenance JSON configuration'),
      Cli.Flag.optional,
    ),
    dryRun: Cli.Flag.Boolean('dry-run').pipe(
      Cli.Flag.withDescription(
        'Report maintenance decisions without cleaning outputs or stopping daemons',
      ),
      Cli.Flag.withDefault(false),
    ),
    json: Cli.Flag.Boolean('json').pipe(
      Cli.Flag.withDescription('Emit the complete machine-readable maintenance receipt'),
      Cli.Flag.withDefault(false),
    ),
  },
  ({ configPath, dryRun, json }) =>
    Effect.gen(function* () {
      const receipt = yield* runBuckMaintain({
        configPath: Option.getOrUndefined(configPath),
        dryRun,
      })
      if (json === true) {
        yield* Console.log(encodeReceipt(receipt))
      } else {
        yield* Console.log(
          `Buck maintenance${receipt.dryRun === true ? ' (dry run)' : ''}: ${receipt.summary.worktrees} worktrees · ${receipt.summary.actions} actions · ${receipt.summary.skipped} skipped`,
        )
        for (const entry of receipt.entries.slice(0, 5)) {
          yield* Console.log(`  ${entry.worktree}: ${entry.action} — ${entry.reason}`)
        }
        if (receipt.entries.length > 5) {
          yield* Console.log(
            `  + ${receipt.entries.length - 5} more (use --json for the complete receipt)`,
          )
        }
      }
    }).pipe(
      Observability.withCommandSpan({
        name: 'megarepo/store/buck-maintain',
        command: 'store buck-maintain',
      }),
    ),
).pipe(
  Cli.Command.withDescription(
    'Maintain owner-scoped Buck outputs and idle daemons using native Buck commands',
  ),
)
