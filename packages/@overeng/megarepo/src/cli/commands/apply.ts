/**
 * `mr apply` — Lock → Workspace
 *
 * Create worktrees from lock, symlink, nix lock sync, generators. Never writes lock.
 */

import * as Cli from '@effect/cli'

import { outputOption, verboseOption } from '../context.ts'
import { runCommand } from './engine.ts'

/** `mr apply` — Lock → Workspace: create worktrees, symlink, nix lock sync, generators. */
export const applyCommand = Cli.Command.make(
  'apply',
  {
    output: outputOption,
    dryRun: Cli.Options.boolean('dry-run').pipe(
      Cli.Options.withDescription('Show what would be done without making changes'),
      Cli.Options.withDefault(false),
    ),
    force: Cli.Options.boolean('force').pipe(
      Cli.Options.withAlias('f'),
      Cli.Options.withDescription('Force updates for pinned members'),
      Cli.Options.withDefault(false),
    ),
    all: Cli.Options.boolean('all').pipe(
      Cli.Options.withDescription('Recursively apply nested megarepos'),
      Cli.Options.withDefault(false),
    ),
    only: Cli.Options.text('only').pipe(
      Cli.Options.withDescription('Only apply specified members (comma-separated)'),
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
    worktreeMode: Cli.Options.choice('worktree-mode', ['commit', 'tracking', 'auto']).pipe(
      Cli.Options.withDescription(
        'Worktree strategy: commit (deterministic), tracking (branch worktrees), auto (commit in CI, tracking otherwise)',
      ),
      Cli.Options.withDefault('auto' as const),
    ),
    verbose: verboseOption,
  },
  ({ output, dryRun, force, all, only, skip, gitProtocol, worktreeMode, verbose }) =>
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
    }),
).pipe(
  Cli.Command.withDescription(
    'Lock → Workspace: create worktrees from lock, symlink, nix lock sync, generators. Never writes lock.',
  ),
)
