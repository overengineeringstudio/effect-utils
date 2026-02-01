/**
 * Init Command
 *
 * Initialize a new megarepo in the current directory.
 */

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'
import React from 'react'

import { EffectPath } from '@overeng/effect-path'

import { CONFIG_FILE_NAME, MegarepoConfig } from '../../lib/config.ts'
import * as Git from '../../lib/git.ts'
import { Cwd, outputOption, outputModeLayer } from '../context.ts'
import { InitApp, InitView } from '../renderers/InitOutput/mod.ts'

/** Initialize a new megarepo in current directory */
export const initCommand = Cli.Command.make('init', { output: outputOption }, ({ output }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const fs = yield* FileSystem.FileSystem

    // Run TuiApp for all output (handles JSON/TTY modes automatically)
    yield* Effect.scoped(
      Effect.gen(function* () {
        const tui = yield* InitApp.run(React.createElement(InitView, { stateAtom: InitApp.stateAtom }))

        // Check if already in a git repo
        const isGit = yield* Git.isGitRepo(cwd)
        if (!isGit) {
          tui.dispatch({
            _tag: 'SetError',
            error: 'not_git_repo',
            message: 'Not a git repository',
          })
          return
        }

        const configPath = EffectPath.ops.join(
          cwd,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )

        // Check if config already exists
        const exists = yield* fs.exists(configPath)
        if (exists) {
          // Already initialized
          tui.dispatch({ _tag: 'SetAlreadyInitialized', path: configPath })
          return
        }

        // Create initial config
        const initialConfig = {
          $schema:
            'https://raw.githubusercontent.com/overengineeringstudio/megarepo/main/schema/megarepo.schema.json',
          members: {},
        }

        const configContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
          initialConfig,
        )
        yield* fs.writeFileString(configPath, configContent + '\n')

        // Output success
        tui.dispatch({ _tag: 'SetInitialized', path: configPath })
      }),
    ).pipe(Effect.provide(outputModeLayer(output)))
  }).pipe(Effect.withSpan('megarepo/init')),
).pipe(Cli.Command.withDescription('Initialize a new megarepo in the current directory'))
