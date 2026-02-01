/**
 * Ls Command
 *
 * List all members in the megarepo.
 */

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'
import React from 'react'

import { EffectPath } from '@overeng/effect-path'

import { CONFIG_FILE_NAME, MegarepoConfig } from '../../lib/config.ts'
import { Cwd, findMegarepoRoot, outputOption, outputModeLayer } from '../context.ts'
import { LsApp, LsView } from '../renderers/LsOutput/mod.ts'

/** List members */
export const lsCommand = Cli.Command.make('ls', { output: outputOption }, ({ output }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const root = yield* findMegarepoRoot(cwd)

    // Run TuiApp for all output (handles JSON/TTY modes automatically)
    yield* Effect.scoped(
      Effect.gen(function* () {
        const tui = yield* LsApp.run(React.createElement(LsView, { stateAtom: LsApp.stateAtom }))

        if (Option.isNone(root)) {
          // Dispatch error state
          tui.dispatch({
            _tag: 'SetError',
            error: 'not_found',
            message: 'No megarepo.json found',
          })
          return
        }

        // Load config
        const fs = yield* FileSystem.FileSystem
        const configPath = EffectPath.ops.join(
          root.value,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        const configContent = yield* fs.readFileString(configPath)
        const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

        // Convert members to array format and dispatch success
        const members = Object.entries(config.members).map(([name, source]) => ({
          name,
          source,
        }))
        tui.dispatch({ _tag: 'SetMembers', members })
      }),
    ).pipe(Effect.provide(outputModeLayer(output)))
  }).pipe(Effect.withSpan('megarepo/ls')),
).pipe(Cli.Command.withDescription('List all members in the megarepo'))
