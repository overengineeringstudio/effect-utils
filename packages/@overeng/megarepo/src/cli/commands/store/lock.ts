import { Effect } from 'effect'
import * as Cli from 'effect/cli'

import { startGitWriterProcess, withGitWriterLock } from '../../../store/git-writer-lock.ts'
import * as Observability from '../../observability.ts'

/** External writers share the same common-directory lock as mr's leaf Git writes. */
export const storeLockCommand = Cli.Command.make(
  'lock',
  {
    path: Cli.Argument.String('path').pipe(
      Cli.Argument.withDescription(
        'Repository, bare repository, worktree, or missing clone target',
      ),
    ),
    cloneTarget: Cli.Flag.Boolean('clone-target').pipe(
      Cli.Flag.withDescription('Lock a bare clone target even before Git metadata is complete'),
      Cli.Flag.withDefault(false),
    ),
    command: Cli.Argument.String('command').pipe(
      Cli.Argument.withDescription('Command and arguments to run under the Git writer lock'),
      Cli.Argument.atLeast(1),
    ),
  },
  ({ path, command, cloneTarget }) =>
    Effect.gen(function* () {
      const child = yield* startGitWriterProcess({
        command: command[0]!,
        args: command.slice(1),
        inheritStdio: true,
      })
      const exitCode = yield* child.exitCode
      if (exitCode !== 0) {
        yield* Effect.sync(() => {
          process.exitCode = exitCode
        })
      }
    }).pipe(
      withGitWriterLock(path, { create: cloneTarget }),
      Observability.withCommandSpan({ name: 'megarepo/store/lock', command: 'store lock' }),
    ),
).pipe(
  Cli.Command.withDescription(
    'Run a command under the host-local Git common-directory writer lock',
  ),
)
