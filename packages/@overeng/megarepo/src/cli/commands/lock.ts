/**
 * `mr lock` — Workspace → Lock
 *
 * Record current worktree HEAD commits into megarepo.lock. No network, no workspace changes.
 */

import { Effect } from 'effect'
import * as Cli from 'effect/unstable/cli'

import { outputOption, resolveOutputOption, verboseOption } from '../context.ts'
import { runCommand } from './engine.ts'

/** `mr lock` — Workspace → Lock: record current worktree HEAD commits into megarepo.lock. */
export const lockCommand = Cli.Command.make(
  'lock',
  {
    output: outputOption,
    dryRun: Cli.Flag.Boolean('dry-run').pipe(
      Cli.Flag.withDescription('Show what would be done without making changes'),
      Cli.Flag.withDefault(false),
    ),
    force: Cli.Flag.Boolean('force').pipe(
      Cli.Flag.withAlias('f'),
      Cli.Flag.withDescription('Force lock operation even when members are pinned or need repair'),
      Cli.Flag.withDefault(false),
    ),
    all: Cli.Flag.Boolean('all').pipe(
      Cli.Flag.withDescription('Recursively operate on nested megarepos'),
      Cli.Flag.withDefault(false),
    ),
    only: Cli.Flag.String('only').pipe(
      Cli.Flag.withDescription('Only operate on specified members (comma-separated)'),
      Cli.Flag.optional,
    ),
    skip: Cli.Flag.String('skip').pipe(
      Cli.Flag.withDescription('Skip specified members (comma-separated)'),
      Cli.Flag.optional,
    ),
    gitProtocol: Cli.Flag.Literals('git-protocol', ['ssh', 'https', 'auto']).pipe(
      Cli.Flag.withDescription(
        'Git protocol for cloning: ssh (default for new clones), https, or auto (use lock file URL if available)',
      ),
      Cli.Flag.withDefault('auto' as const),
    ),
    verbose: verboseOption,
  },
  ({ output, dryRun, force, all, only, skip, gitProtocol, verbose }) =>
    resolveOutputOption(output).pipe(
      Effect.flatMap((outputMode) =>
        runCommand({
          mode: 'lock',
          output: outputMode,
          dryRun,
          force,
          all,
          only,
          skip,
          gitProtocol,
          createBranches: false,
          verbose,
        }),
      ),
    ),
).pipe(
  Cli.Command.withDescription(
    'Workspace → Lock: record current worktree HEAD commits into megarepo.lock.',
  ),
)
