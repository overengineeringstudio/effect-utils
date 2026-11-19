import { Console, Effect, Option, Schema } from 'effect'
import * as Cli from 'effect/cli'

import { validateBuckMaintainProgressOptions } from '../../../store/store-buck-maintain-progress-schema.ts'
import { runBuckMaintainWithProgress } from '../../../store/store-buck-maintain-progress.ts'
import {
  BUCK_MAINTAIN_UNSUPPORTED_PLATFORM_REASON,
  runBuckMaintain,
} from '../../../store/store-buck-maintain.ts'
import * as Observability from '../../observability.ts'

const encodeReceipt = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** Reports native action failure after the complete maintenance receipt has been emitted. */
export class BuckMaintainCommandFailed extends Schema.TaggedError<BuckMaintainCommandFailed>()(
  'BuckMaintainCommandFailed',
  { message: Schema.String },
) {}

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
    progressDir: Cli.Flag.String('progress-dir').pipe(
      Cli.Flag.withDescription('Persist historical per-root dry-run observations in this directory; requires --dry-run'),
      Cli.Flag.optional,
    ),
    maxWorktrees: Cli.Flag.Int('max-worktrees').pipe(
      Cli.Flag.withDescription('Maximum unfinished roots per resumable shard (default: 1); requires --progress-dir'),
      Cli.Flag.optional,
    ),
    json: Cli.Flag.Boolean('json').pipe(
      Cli.Flag.withDescription('Emit the complete machine-readable maintenance receipt'),
      Cli.Flag.withDefault(false),
    ),
  },
  ({ configPath, dryRun, json, progressDir, maxWorktrees }) =>
    Effect.gen(function* () {
      const directory = Option.getOrUndefined(progressDir)
      const maximum = Option.getOrUndefined(maxWorktrees)
      const invalid = validateBuckMaintainProgressOptions({ dryRun, progressDir: directory, maxWorktrees: maximum })
      if (invalid !== undefined) return yield* invalid
      const options = { configPath: Option.getOrUndefined(configPath), dryRun }
      const receipt = yield* directory === undefined
        ? runBuckMaintain(options)
        : runBuckMaintainWithProgress({ ...options, progressDir: directory, maxWorktrees: maximum })
      if (json === true) {
        yield* Console.log(encodeReceipt(receipt))
      } else {
        if ('progress' in receipt) {
          yield* Console.log(
            `Historical dry-run coverage: ${receipt.progress.completed}/${receipt.progress.total} roots · ${receipt.progress.remaining} remaining · ${receipt.progress.complete === true ? 'complete' : 'partial'} (${receipt.progress.processedThisRun} this shard). Not an atomic fresh census; never authorizes apply.`,
          )
        }
        if (process.platform !== 'linux') {
          yield* Console.log(
            `Buck maintenance is unsupported on ${process.platform}: ${BUCK_MAINTAIN_UNSUPPORTED_PLATFORM_REASON}. No outputs or daemons will be changed. See #1955.`,
          )
        }
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
      if (
        receipt.entries.some(
          (entry) => entry.reason === 'clean-failed' || entry.reason === 'kill-failed',
        ) === true
      )
        return yield* new BuckMaintainCommandFailed({
          message: 'Native Buck maintenance failed; see the complete maintenance receipt above',
        })
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
