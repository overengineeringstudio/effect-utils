/**
 * Env Command
 *
 * Print environment variables for shell integration.
 */

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Console, Effect, Option, Schema } from 'effect'
import React from 'react'

import { EffectPath } from '@overeng/effect-path'
import { renderToString, Box, Text } from '@overeng/tui-react'
import { jsonError, withJsonMode } from '@overeng/utils/node'

import { CONFIG_FILE_NAME, ENV_VARS, MegarepoConfig } from '../../lib/config.ts'
import { Cwd, findMegarepoRoot, findNearestMegarepoRoot, jsonOption } from '../context.ts'

/** Print environment variables for shell integration */
export const envCommand = Cli.Command.make(
  'env',
  {
    shell: Cli.Options.choice('shell', ['bash', 'zsh', 'fish']).pipe(
      Cli.Options.withDescription('Shell type for output format'),
      Cli.Options.withDefault('bash' as const),
    ),
    json: jsonOption,
  },
  ({ shell, json }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd

      // Find the megarepo root
      const root = yield* findMegarepoRoot(cwd)
      const nearestRoot = yield* findNearestMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          return yield* jsonError({
            error: 'not_found',
            message: 'No megarepo.json found',
          })
        }
        const output = yield* Effect.promise(() =>
          renderToString(
            React.createElement(
              Box,
              { flexDirection: 'row' },
              React.createElement(Text, { color: 'red' }, '\u2717'),
              React.createElement(Text, null, ' No megarepo.json found'),
            ),
          ),
        )
        yield* Console.error(output)
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      // Load config to get member names
      const fs = yield* FileSystem.FileSystem
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      const memberNames = Object.keys(config.members).join(',')

      if (json) {
        console.log(
          JSON.stringify({
            [ENV_VARS.ROOT_OUTERMOST]: root.value,
            [ENV_VARS.ROOT_NEAREST]: Option.getOrElse(nearestRoot, () => root.value),
            [ENV_VARS.MEMBERS]: memberNames,
          }),
        )
      } else {
        // Output shell-specific format
        switch (shell) {
          case 'fish':
            yield* Console.log(`set -gx ${ENV_VARS.ROOT_OUTERMOST} "${root.value}"`)
            yield* Console.log(
              `set -gx ${ENV_VARS.ROOT_NEAREST} "${Option.getOrElse(nearestRoot, () => root.value)}"`,
            )
            yield* Console.log(`set -gx ${ENV_VARS.MEMBERS} "${memberNames}"`)
            break
          default:
            yield* Console.log(`export ${ENV_VARS.ROOT_OUTERMOST}="${root.value}"`)
            yield* Console.log(
              `export ${ENV_VARS.ROOT_NEAREST}="${Option.getOrElse(nearestRoot, () => root.value)}"`,
            )
            yield* Console.log(`export ${ENV_VARS.MEMBERS}="${memberNames}"`)
        }
      }
    }).pipe(Effect.withSpan('megarepo/env'), withJsonMode(json)),
).pipe(Cli.Command.withDescription('Output environment variables for shell integration'))
