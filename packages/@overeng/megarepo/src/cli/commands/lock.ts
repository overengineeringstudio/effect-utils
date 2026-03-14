/**
 * `mr lock` — Workspace → Lock
 *
 * Record current worktree HEAD commits into megarepo.lock. No network, no workspace changes.
 */

import * as Cli from '@effect/cli'

import { outputOption, verboseOption } from '../context.ts'
import { runCommand } from './engine.ts'

/** `mr lock` — Workspace → Lock: record current worktree HEAD commits into megarepo.lock. */
export const lockCommand = Cli.Command.make(
  'lock',
  {
    output: outputOption,
    dryRun: Cli.Options.boolean('dry-run').pipe(
      Cli.Options.withDescription('Show what would be done without making changes'),
      Cli.Options.withDefault(false),
    ),
    force: Cli.Options.boolean('force').pipe(
      Cli.Options.withAlias('f'),
      Cli.Options.withDescription(
        'Force lock operation even when members are pinned or need repair',
      ),
      Cli.Options.withDefault(false),
    ),
    all: Cli.Options.boolean('all').pipe(
      Cli.Options.withDescription('Recursively operate on nested megarepos'),
      Cli.Options.withDefault(false),
    ),
    only: Cli.Options.text('only').pipe(
      Cli.Options.withDescription('Only operate on specified members (comma-separated)'),
      Cli.Options.optional,
    ),
    skip: Cli.Options.text('skip').pipe(
      Cli.Options.withDescription('Skip specified members (comma-separated)'),
      Cli.Options.optional,
    ),
    gitProtocol: Cli.Options.choice('git-protocol', ['ssh', 'https', 'auto']).pipe(
      Cli.Options.withDescription(
        'Git protocol for cloning: ssh (default for new clones), https, or auto (use lock file URL if available)',
      ),
      Cli.Options.withDefault('auto' as const),
    ),
    noStrict: Cli.Options.boolean('no-strict').pipe(
      Cli.Options.withDescription('Bypass store hygiene pre-flight checks'),
      Cli.Options.withDefault(false),
    ),
    verbose: verboseOption,
  },
  ({ output, dryRun, force, all, only, skip, gitProtocol, noStrict, verbose }) =>
    runCommand({
      mode: 'lock',
      output,
      dryRun,
      force,
      all,
      only,
      skip,
      gitProtocol,
      createBranches: false,
      noStrict,
      verbose,
    }),
).pipe(
  Cli.Command.withDescription(
    'Workspace → Lock: record current worktree HEAD commits into megarepo.lock.',
  ),
)
