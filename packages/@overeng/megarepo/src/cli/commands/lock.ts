import * as Cli from '@effect/cli'

import { outputOption, verboseOption } from '../context.ts'
import { runSyncCommand } from './sync.ts'

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
    Cli.Options.withDescription('Recursively sync nested megarepos'),
    Cli.Options.withDefault(false),
  ),
  only: Cli.Options.text('only').pipe(
    Cli.Options.withDescription('Only sync specified members (comma-separated)'),
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

const lockSyncCommand = Cli.Command.make(
  'sync',
  {
    ...sharedOptions,
  },
  ({ output, dryRun, force, all, only, skip, gitProtocol, verbose }) =>
    runSyncCommand({
      mode: 'lock_sync',
      output,
      dryRun,
      force,
      all,
      only,
      skip,
      gitProtocol,
      createBranches: false,
      verbose,
    }),
).pipe(Cli.Command.withDescription('Record the current synced workspace state into megarepo.lock.'))

const lockUpdateCommand = Cli.Command.make(
  'update',
  {
    ...sharedOptions,
    createBranches: Cli.Options.boolean('create-branches').pipe(
      Cli.Options.withDescription('Create branches that do not exist (from default branch)'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ output, dryRun, force, all, only, skip, gitProtocol, createBranches, verbose }) =>
    runSyncCommand({
      mode: 'lock_update',
      output,
      dryRun,
      force,
      all,
      only,
      skip,
      gitProtocol,
      createBranches,
      verbose,
    }),
).pipe(
  Cli.Command.withDescription(
    'Fetch configured refs, update the workspace to them, and write the new state into megarepo.lock.',
  ),
)

const lockApplyCommand = Cli.Command.make(
  'apply',
  {
    ...sharedOptions,
  },
  ({ output, dryRun, force, all, only, skip, gitProtocol, verbose }) =>
    runSyncCommand({
      mode: 'lock_apply',
      output,
      dryRun,
      force,
      all,
      only,
      skip,
      gitProtocol,
      createBranches: false,
      verbose,
    }),
).pipe(
  Cli.Command.withDescription(
    'Apply the exact commits from megarepo.lock, materializing commit worktrees for reproducible CI.',
  ),
)

/** CLI command group for megarepo.lock operations (sync, update, apply). */
export const lockCommand = Cli.Command.make('lock', {}).pipe(
  Cli.Command.withSubcommands([lockSyncCommand, lockUpdateCommand, lockApplyCommand]),
  Cli.Command.withDescription('Manage megarepo.lock and lock-driven workspace operations'),
)
