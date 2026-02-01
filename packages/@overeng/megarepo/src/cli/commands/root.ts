/**
 * Root Command
 *
 * Find and print the megarepo root directory.
 */

import * as Cli from '@effect/cli'
import { Effect, Option } from 'effect'
import React from 'react'

import * as Git from '../../lib/git.ts'
import { Cwd, findMegarepoRoot, outputOption, outputModeLayer } from '../context.ts'
import { RootApp } from '../renderers/RootOutput/mod.ts'
import { RootConnectedView } from '../renderers/RootOutput/connected-view.tsx'

/** Find and print the megarepo root directory */
export const rootCommand = Cli.Command.make('root', { output: outputOption }, ({ output }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd

    // Run TuiApp for all output (handles JSON/TTY modes automatically)
    yield* Effect.scoped(
      Effect.gen(function* () {
        const tui = yield* RootApp.run(React.createElement(RootConnectedView))

        // Search up from current directory
        const root = yield* findMegarepoRoot(cwd)

        if (Option.isNone(root)) {
          // Dispatch error state
          tui.dispatch({
            _tag: 'SetError',
            error: 'not_found',
            message: 'No megarepo.json found in current directory or any parent.',
          })
          // Set exit code for error
          process.exitCode = 1
          return
        }

        const name = yield* Git.deriveMegarepoName(root.value)

        // Dispatch success state
        tui.dispatch({
          _tag: 'SetSuccess',
          root: root.value,
          name,
        })
      }),
    ).pipe(Effect.provide(outputModeLayer(output)))
  }).pipe(Effect.withSpan('megarepo/root')),
).pipe(Cli.Command.withDescription('Print the megarepo root directory'))
