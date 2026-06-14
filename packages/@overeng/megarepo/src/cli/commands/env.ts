/**
 * Env Command
 *
 * Print environment variables for shell integration.
 */

import * as Cli from '@effect/cli'
import { Effect } from 'effect'
import React from 'react'

import { run } from '@overeng/tui-react'

import { DEFAULT_STORE_PATH } from '../../lib/config.ts'
import { outputOption, outputModeLayer } from '../context.ts'
import * as Observability from '../observability.ts'
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
    run(
      EnvApp,
      (tui) =>
        Effect.sync(() => {
          // Get store path from env or use default
          const storePath = process.env['MEGAREPO_STORE'] ?? DEFAULT_STORE_PATH

          tui.dispatch({
            _tag: 'SetEnv',
            MEGAREPO_STORE: storePath,
            shell,
          })
        }),
      { view: React.createElement(EnvView, { stateAtom: EnvApp.stateAtom }) },
    ).pipe(
      Effect.provide(outputModeLayer(output)),
      Observability.withCommandSpan({
        name: 'megarepo/env',
        command: 'env',
        label: shell,
        output,
      }),
    ),
).pipe(Cli.Command.withDescription('Output environment variables for shell integration'))
