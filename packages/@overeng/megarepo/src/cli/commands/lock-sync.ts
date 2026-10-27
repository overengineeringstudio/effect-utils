import { Console, Effect } from 'effect'
import * as Cli from 'effect/cli'

import { syncStandaloneLocks, StandaloneLockSyncError } from '../../core/nix-lock/standalone.ts'
import { Cwd } from '../context.ts'
import * as Observability from '../observability.ts'

/** Root-resolved cohort synchronization is separate from member-worktree apply. */
export const lockSyncCommand = Cli.Command.make(
  'lock-sync',
  {
    input: Cli.Flag.String('input').pipe(
      Cli.Flag.withDescription('Root input name to synchronize in every standalone flake.lock'),
    ),
    rootLock: Cli.Flag.Literals('root-lock', ['devenv.lock', 'flake.lock']).pipe(
      Cli.Flag.withDescription('Authoritative lock in the current consumer repository root'),
      Cli.Flag.withDefault('devenv.lock'),
    ),
    write: Cli.Flag.Boolean('write').pipe(
      Cli.Flag.withDescription(
        'Write root-resolved locked metadata; otherwise check without writing',
      ),
      Cli.Flag.withDefault(false),
    ),
  },
  ({ input, rootLock, write }) =>
    Effect.gen(function* () {
      const root = yield* Cwd
      const result = yield* syncStandaloneLocks({ root, input, rootLock, write })
      for (const path of result.changed) {
        yield* Console.log(`${write === true ? 'Updated' : 'Drift'}: ${path}`)
      }
      yield* Console.log(
        `${result.checked.length} standalone lock(s) checked; ${result.changed.length} ${write === true ? 'updated' : 'out of sync'}`,
      )
      if (write === false && result.changed.length > 0) {
        return yield* new StandaloneLockSyncError({
          path: root,
          input,
          message:
            'Standalone locks differ from the root resolution; run the same command with --write',
        })
      }
    }).pipe(Observability.withCommandSpan({ name: 'megarepo/lock-sync', command: 'lock-sync' })),
).pipe(
  Cli.Command.withDescription(
    'Check or synchronize standalone flake locks from one root-resolved input',
  ),
)
