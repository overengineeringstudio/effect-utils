/**
 * Ls Command
 *
 * List all members in the megarepo.
 */

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Console, Effect, Option, Schema } from 'effect'
import React from 'react'

import { EffectPath } from '@overeng/effect-path'
import { renderToString, Box, Text } from '@overeng/tui-react'
import { jsonError, withJsonMode } from '@overeng/utils/node'

import { CONFIG_FILE_NAME, MegarepoConfig } from '../../lib/config.ts'
import { Cwd, findMegarepoRoot, jsonOption } from '../context.ts'

/** List members */
export const lsCommand = Cli.Command.make('ls', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const root = yield* findMegarepoRoot(cwd)

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
            React.createElement(Text, null, ' Not in a megarepo'),
          ),
        ),
      )
      yield* Console.error(output)
      return yield* Effect.fail(new Error('Not in a megarepo'))
    }

    // Load config
    const fs = yield* FileSystem.FileSystem
    const configPath = EffectPath.ops.join(
      root.value,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
    )
    const configContent = yield* fs.readFileString(configPath)
    const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

    if (json) {
      console.log(JSON.stringify({ members: config.members }))
    } else {
      for (const [name, sourceString] of Object.entries(config.members)) {
        const memberOutput = yield* Effect.promise(() =>
          renderToString(
            React.createElement(
              Box,
              { flexDirection: 'row' },
              React.createElement(Text, { bold: true }, name),
              React.createElement(Text, { dim: true }, ` (${sourceString})`),
            ),
          ),
        )
        yield* Console.log(memberOutput)
      }
    }
  }).pipe(Effect.withSpan('megarepo/ls'), withJsonMode(json)),
).pipe(Cli.Command.withDescription('List all members in the megarepo'))
