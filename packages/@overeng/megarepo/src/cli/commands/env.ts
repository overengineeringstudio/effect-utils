/**
 * Env Command
 *
 * Print environment variables for shell integration.
 */

import * as Cli from '@effect/cli'
import { Effect } from 'effect'
import React from 'react'

import { DEFAULT_STORE_PATH } from '../../lib/config.ts'
import { outputOption, outputModeLayer } from '../context.ts'
import { EnvApp, EnvView } from '../renderers/EnvOutput/mod.ts'

/** Print environment variables for shell integration */
export const envCommand = Cli.Command.make(
  'env',
  {
    shell: Cli.Options.choice('shell', ['bash', 'zsh', 'fish']).pipe(
      Cli.Options.withDescription('Shell type for output format'),
      Cli.Options.withDefault('bash' as const),
    ),
    output: outputOption,
  },
  ({ shell, output }) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Run TuiApp for all output (handles JSON/TTY modes automatically)
        const tui = yield* EnvApp.run(React.createElement(EnvView, { stateAtom: EnvApp.stateAtom }))

        // Get store path from env or use default
        const storePath = process.env['MEGAREPO_STORE'] ?? DEFAULT_STORE_PATH

        tui.dispatch({
          _tag: 'SetEnv',
          MEGAREPO_STORE: storePath,
          shell,
        })
      }),
    ).pipe(Effect.provide(outputModeLayer(output)), Effect.withSpan('megarepo/env')),
).pipe(Cli.Command.withDescription('Output environment variables for shell integration'))
