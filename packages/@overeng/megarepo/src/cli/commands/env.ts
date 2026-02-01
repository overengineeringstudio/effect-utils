/**
 * Env Command
 *
 * Print environment variables for shell integration.
 */

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'
import React from 'react'

import { EffectPath } from '@overeng/effect-path'

import { CONFIG_FILE_NAME, MegarepoConfig } from '../../lib/config.ts'
import {
  Cwd,
  findMegarepoRoot,
  findNearestMegarepoRoot,
  outputOption,
  outputModeLayer,
} from '../context.ts'
import { EnvConnectedView } from '../renderers/EnvOutput/connected-view.tsx'
import { EnvApp } from '../renderers/EnvOutput/mod.ts'

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
    Effect.gen(function* () {
      const cwd = yield* Cwd

      // Run TuiApp for all output (handles JSON/TTY modes automatically)
      yield* Effect.scoped(
        Effect.gen(function* () {
          const tui = yield* EnvApp.run(React.createElement(EnvConnectedView))

          // Find the megarepo root
          const root = yield* findMegarepoRoot(cwd)
          const nearestRoot = yield* findNearestMegarepoRoot(cwd)

          if (Option.isNone(root)) {
            tui.dispatch({
              _tag: 'SetError',
              error: 'not_found',
              message: 'No megarepo.json found',
            })
            return
          }

          // Load config to get member names
          const fs = yield* FileSystem.FileSystem
          const configPath = EffectPath.ops.join(
            root.value,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
          )
          const configContent = yield* fs.readFileString(configPath)
          const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(
            configContent,
          )

          const memberNames = Object.keys(config.members).join(',')
          const nearestRootValue = Option.getOrElse(nearestRoot, () => root.value)

          tui.dispatch({
            _tag: 'SetEnv',
            MEGAREPO_ROOT_OUTERMOST: root.value,
            MEGAREPO_ROOT_NEAREST: nearestRootValue,
            MEGAREPO_MEMBERS: memberNames,
            shell,
          })
        }),
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(Effect.withSpan('megarepo/env')),
).pipe(Cli.Command.withDescription('Output environment variables for shell integration'))
