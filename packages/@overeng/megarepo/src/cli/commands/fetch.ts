/**
 * `mr fetch` — Remote → Lock
 *
 * Fetch upstream refs, resolve commits, write lock.
 * With `--apply`, also applies lock to workspace afterward.
 */

import * as Cli from 'effect/unstable/cli'

import { outputOption, verboseOption } from '../context.ts'
import { runCommand, type LockSyncMode } from './engine.ts'

const lockSyncOption = Cli.Flag.choice('lock-sync', ['auto', 'off', 'direct', 'recursive']).pipe(
  Cli.Flag.withDescription(
    'Lock-file rewrite policy for the apply phase: auto, off, direct members only, or recursive nested megarepos',
  ),
  Cli.Flag.withDefault('auto' as LockSyncMode),
)

const sharedOptions = {
  output: outputOption,
  dryRun: Cli.Flag.boolean('dry-run').pipe(
    Cli.Flag.withDescription('Show what would be done without making changes'),
    Cli.Flag.withDefault(false),
  ),
  force: Cli.Flag.boolean('force').pipe(
    Cli.Flag.withAlias('f'),
    Cli.Flag.withDescription('Force lock operation even when members are pinned or need repair'),
    Cli.Flag.withDefault(false),
  ),
  all: Cli.Flag.boolean('all').pipe(
    Cli.Flag.withDescription('Recursively operate on nested megarepos'),
    Cli.Flag.withDefault(false),
  ),
  only: Cli.Flag.string('only').pipe(
    Cli.Flag.withDescription('Only operate on specified members (comma-separated)'),
    Cli.Flag.optional,
  ),
  skip: Cli.Flag.string('skip').pipe(
    Cli.Flag.withDescription('Skip specified members (comma-separated)'),
    Cli.Flag.optional,
  ),
  gitProtocol: Cli.Flag.choice('git-protocol', ['ssh', 'https', 'auto']).pipe(
    Cli.Flag.withDescription(
      'Git protocol for cloning: ssh (default for new clones), https, or auto (use lock file URL if available)',
    ),
    Cli.Flag.withDefault('auto' as const),
  ),
  worktreeMode: Cli.Flag.choice('worktree-mode', ['commit', 'tracking', 'auto']).pipe(
    Cli.Flag.withDescription(
      'Worktree strategy for --apply: commit (deterministic), tracking (branch worktrees), auto (commit in CI, tracking locally or for composition)',
    ),
    Cli.Flag.withDefault('auto' as const),
  ),
  lockSync: lockSyncOption,
  verbose: verboseOption,
} as const

/** `mr fetch` — Remote → Lock: fetch upstream refs, resolve commits, write lock. */
export const fetchCommand = Cli.Command.make(
  'fetch',
  {
    ...sharedOptions,
    apply: Cli.Flag.boolean('apply').pipe(
      Cli.Flag.withDescription(
        'After fetching, also apply the lock to the workspace (fetch + apply)',
      ),
      Cli.Flag.withDefault(false),
    ),
    createBranches: Cli.Flag.boolean('create-branches').pipe(
      Cli.Flag.withDescription('Create branches that do not exist (from default branch)'),
      Cli.Flag.withDefault(false),
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
    worktreeMode,
    lockSync,
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
      worktreeMode,
      lockSyncMode: lockSync,
    }),
).pipe(
  Cli.Command.withDescription(
    'Remote → Lock: fetch upstream refs, resolve commits, write lock. Use --apply to also materialize workspace.',
  ),
)
