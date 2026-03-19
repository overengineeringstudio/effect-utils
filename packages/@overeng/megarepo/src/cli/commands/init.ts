/**
 * Init Command
 *
 * Initialize a new megarepo in the current directory.
 */

import * as Cli from '@effect/cli'
import { Effect } from 'effect'
import React from 'react'

import { EffectPath } from '@overeng/effect-path'
import { run } from '@overeng/tui-react'

import { CONFIG_FILE_NAME_KDL, findConfigPath, writeMegarepoConfig } from '../../lib/config.ts'
import * as Git from '../../lib/git.ts'
import { Cwd, outputOption, outputModeLayer } from '../context.ts'
import { InitApp, InitView } from '../renderers/InitOutput/mod.ts'

/** Initialize a new megarepo in current directory */
export const initCommand = Cli.Command.make('init', { output: outputOption }, ({ output }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd

    // Run TuiApp for all output (handles JSON/TTY modes automatically)
    yield* run(
      InitApp,
      (tui) =>
        Effect.gen(function* () {
          // Check if already in a git repo
          const isGit = yield* Git.isGitRepo(cwd)
          if (isGit === false) {
            tui.dispatch({
              _tag: 'SetError',
              error: 'not_git_repo',
              message: 'Not a git repository',
            })
            return
          }

          // Check if any config already exists (KDL or JSON)
          const existingPath = yield* findConfigPath(cwd)
          if (existingPath !== undefined) {
            tui.dispatch({ _tag: 'SetAlreadyInitialized', path: existingPath })
            return
          }

          // Create initial config as KDL
          const configPath = EffectPath.ops.join(
            cwd,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME_KDL),
          )

          const initialConfig = {
            members: {},
          }

          yield* writeMegarepoConfig(configPath, initialConfig)

          // Output success
          tui.dispatch({ _tag: 'SetInitialized', path: configPath })
        }),
      { view: React.createElement(InitView, { stateAtom: InitApp.stateAtom }) },
    ).pipe(Effect.provide(outputModeLayer(output)))
  }).pipe(Effect.withSpan('megarepo/init')),
).pipe(Cli.Command.withDescription('Initialize a new megarepo in the current directory'))
