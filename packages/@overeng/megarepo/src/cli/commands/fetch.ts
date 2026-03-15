/**
 * `mr fetch` — Remote → Lock
 *
 * Fetch upstream refs, resolve commits, write lock.
 * With `--apply`, also applies lock to workspace afterward.
 */

import * as Cli from '@effect/cli'

import { outputOption, verboseOption } from '../context.ts'
import { runCommand } from './engine.ts'

const sharedOptions = {
  output: outputOption,
  dryRun: Cli.Options.boolean('dry-run').pipe(
    Cli.Options.withDescription('Show what would be done without making changes'),
    Cli.Options.withDefault(false),
  ),
  force: Cli.Options.boolean('force').pipe(
    Cli.Options.withAlias('f'),
    Cli.Options.withDescription('Force lock operation even when members are pinned or need repair'),
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
  verbose: verboseOption,
} as const

/** `mr fetch` — Remote → Lock: fetch upstream refs, resolve commits, write lock. */
export const fetchCommand = Cli.Command.make(
  'fetch',
  {
    ...sharedOptions,
    apply: Cli.Options.boolean('apply').pipe(
      Cli.Options.withDescription(
        'After fetching, also apply the lock to the workspace (fetch + apply)',
      ),
      Cli.Options.withDefault(false),
    ),
    createBranches: Cli.Options.boolean('create-branches').pipe(
      Cli.Options.withDescription('Create branches that do not exist (from default branch)'),
      Cli.Options.withDefault(false),
    ),
  },
  ({
    output,
    dryRun,
    force,
    all,
    only,
    skip,
    gitProtocol,
    apply: applyAfter,
    createBranches,
    verbose,
  }) =>
    runCommand({
      mode: 'fetch',
      output,
      dryRun,
      force,
      all,
      only,
      skip,
      gitProtocol,
      createBranches,
      verbose,
      applyAfterFetch: applyAfter,
    }),
).pipe(
  Cli.Command.withDescription(
    'Remote → Lock: fetch upstream refs, resolve commits, write lock. Use --apply to also materialize workspace.',
  ),
)
