/**
 * `mr apply` — Lock → Workspace
 *
 * Create worktrees from lock, symlink, nix lock sync, generators. Never writes lock.
 */

import { Effect } from 'effect'
import * as Cli from 'effect/unstable/cli'

import { outputOption, resolveOutputOption, verboseOption } from '../context.ts'
import { runCommand, type LockSyncMode } from './engine.ts'

const lockSyncOption = Cli.Flag.Literals('lock-sync', ['auto', 'off', 'direct', 'recursive']).pipe(
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
    dryRun: Cli.Flag.Boolean('dry-run').pipe(
      Cli.Flag.withDescription('Show what would be done without making changes'),
      Cli.Flag.withDefault(false),
    ),
    force: Cli.Flag.Boolean('force').pipe(
      Cli.Flag.withAlias('f'),
      Cli.Flag.withDescription('Force updates for pinned members'),
      Cli.Flag.withDefault(false),
    ),
    all: Cli.Flag.Boolean('all').pipe(
      Cli.Flag.withDescription('Recursively apply nested megarepos'),
      Cli.Flag.withDefault(false),
    ),
    only: Cli.Flag.String('only').pipe(
      Cli.Flag.withDescription('Only apply specified members (comma-separated)'),
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
    worktreeMode: Cli.Flag.Literals('worktree-mode', ['commit', 'tracking', 'auto']).pipe(
      Cli.Flag.withDescription(
        'Worktree strategy: commit (deterministic), tracking (branch worktrees), auto (commit in CI, tracking locally)',
      ),
      Cli.Flag.withDefault('auto' as const),
    ),
    lockSync: lockSyncOption,
    verbose: verboseOption,
  },
  ({ output, dryRun, force, all, only, skip, gitProtocol, worktreeMode, lockSync, verbose }) =>
    resolveOutputOption(output).pipe(
      Effect.flatMap((outputMode) =>
        runCommand({
          mode: 'apply',
          output: outputMode,
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
      ),
    ),
).pipe(
  Cli.Command.withDescription(
    'Lock → Workspace: create worktrees from lock, symlink, nix lock sync, generators. Never writes lock.',
  ),
)
