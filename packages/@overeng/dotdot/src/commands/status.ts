/**
 * dotdot status command
 *
 * Shows status of all repos in the workspace using WorkspaceService.
 * Renders output following the CLI style guide.
 *
 * @see /context/cli-design/CLI_STYLE_GUIDE.md
 */

import * as Cli from '@effect/cli'
import { Console, Effect, Layer } from 'effect'

import { CurrentWorkingDirectory, WorkspaceService } from '../lib/mod.ts'
import { renderStyledStatus } from './status-renderer.ts'

/** Status command handler - separated for testability */
export const statusHandler = Effect.gen(function* () {
  const workspace = yield* WorkspaceService

  // Scan all repos
  const allRepos = yield* workspace.scanRepos()

  // Get packages from root config
  const packages = workspace.rootConfig.config.packages ?? {}

  // Render styled output
  const lines = renderStyledStatus({
    workspaceRoot: workspace.root,
    allRepos,
    packages,
    memberConfigs: workspace.memberConfigs,
  })

  // Output to console using Effect's Console.log for clean output
  for (const line of lines) {
    yield* Console.log(line)
  }
}).pipe(Effect.withSpan('dotdot/status'))

/** Status command implementation.
 * Provides its own WorkspaceService.live layer - validates config is in sync before running. */
export const statusCommand = Cli.Command.make('status', {}, () =>
  statusHandler.pipe(
    Effect.provide(WorkspaceService.live.pipe(Layer.provide(CurrentWorkingDirectory.live))),
  ),
)
