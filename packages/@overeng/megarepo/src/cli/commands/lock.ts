/**
 * Lock & Fetch Commands
 *
 * - `mr lock`  — Workspace → Lock: record current HEAD commits into megarepo.lock.
 * - `mr fetch` — Remote → Lock: fetch upstream refs, resolve commits, write lock.
 *                With `--apply`, also applies lock to workspace afterward.
 */

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
} as const

/** `mr lock` — Workspace → Lock: record current worktree HEAD commits into megarepo.lock. No network, no workspace changes. */
export const lockCommand = Cli.Command.make(
  'lock',
  {
    ...sharedOptions,
  },
  ({ output, dryRun, force, all, only, skip, gitProtocol, noStrict, verbose }) =>
    runSyncCommand({
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

/** `mr fetch` — Remote → Lock: fetch upstream refs, resolve commits, write lock. With --apply, also materializes workspace. */
export const fetchCommand = Cli.Command.make(
  'fetch',
  {
    ...sharedOptions,
    apply: Cli.Options.boolean('apply').pipe(
      Cli.Options.withDescription('After fetching, also apply the lock to the workspace (fetch + apply)'),
      Cli.Options.withDefault(false),
    ),
    createBranches: Cli.Options.boolean('create-branches').pipe(
      Cli.Options.withDescription('Create branches that do not exist (from default branch)'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ output, dryRun, force, all, only, skip, gitProtocol, noStrict, apply: applyAfter, createBranches, verbose }) =>
    runSyncCommand({
      mode: 'fetch',
      output,
      dryRun,
      force,
      all,
      only,
      skip,
      gitProtocol,
      createBranches,
      noStrict,
      verbose,
      applyAfterFetch: applyAfter,
    }),
).pipe(
  Cli.Command.withDescription(
    'Remote → Lock: fetch upstream refs, resolve commits, write lock. Use --apply to also materialize workspace.',
  ),
)
