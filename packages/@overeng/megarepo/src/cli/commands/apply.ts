/**
 * `mr apply` — Lock → Workspace
 *
 * Create worktrees from lock, symlink, nix lock sync, generators. Never writes lock.
 */

import * as Cli from 'effect/unstable/cli'

import { outputOption, verboseOption } from '../context.ts'
import { runCommand, type LockSyncMode } from './engine.ts'

const lockSyncOption = Cli.Flag.choice('lock-sync', ['auto', 'off', 'direct', 'recursive']).pipe(
  Cli.Flag.withDescription(
    'Lock-file rewrite policy during apply: auto, off, direct members only, or recursive nested megarepos',
  ),
  Cli.Flag.withDefault('auto' as LockSyncMode),
)

/** `mr apply` — Lock → Workspace: create worktrees, symlink, nix lock sync, generators. */
export const applyCommand = Cli.Command.make(
  'apply',
  {
    output: outputOption,
    dryRun: Cli.Flag.boolean('dry-run').pipe(
      Cli.Flag.withDescription('Show what would be done without making changes'),
      Cli.Flag.withDefault(false),
    ),
    force: Cli.Flag.boolean('force').pipe(
      Cli.Flag.withAlias('f'),
      Cli.Flag.withDescription('Force updates for pinned members'),
      Cli.Flag.withDefault(false),
    ),
    all: Cli.Flag.boolean('all').pipe(
      Cli.Flag.withDescription('Recursively apply nested megarepos'),
      Cli.Flag.withDefault(false),
    ),
    only: Cli.Flag.string('only').pipe(
      Cli.Flag.withDescription('Only apply specified members (comma-separated)'),
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
        'Worktree strategy: commit (deterministic), tracking (branch worktrees), auto (tracking outside CI; rejected in CI)',
      ),
      Cli.Flag.withDefault('auto' as const),
    ),
    lockSync: lockSyncOption,
    verbose: verboseOption,
  },
  ({ output, dryRun, force, all, only, skip, gitProtocol, worktreeMode, lockSync, verbose }) =>
    runCommand({
      mode: 'apply',
      output,
      dryRun,
      force,
      all,
      only,
      skip,
      gitProtocol,
      createBranches: false,
      verbose,
      worktreeMode,
      lockSyncMode: lockSync,
    }),
).pipe(
  Cli.Command.withDescription(
    'Lock → Workspace: create worktrees from lock, symlink, nix lock sync, generators. Never writes lock.',
  ),
)
