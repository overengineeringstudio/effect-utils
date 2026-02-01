/**
 * Root Command
 *
 * Find and print the megarepo root directory.
 */

import * as Cli from '@effect/cli'
import { Console, Effect, Option } from 'effect'
import React from 'react'

import { renderToString, Box, Text } from '@overeng/tui-react'
import { jsonError, withJsonMode } from '@overeng/utils/node'

import * as Git from '../../lib/git.ts'
import { Cwd, findMegarepoRoot, outputOption } from '../context.ts'
import { NotInMegarepoError } from '../errors.ts'

/** Find and print the megarepo root directory */
export const rootCommand = Cli.Command.make('root', { output: outputOption }, ({ output }) => {
  const json = output === 'json' || output === 'ndjson'

  return Effect.gen(function* () {
    const cwd = yield* Cwd

    // Search up from current directory
    const root = yield* findMegarepoRoot(cwd)

    if (Option.isNone(root)) {
      if (json) {
        return yield* jsonError({
          error: 'not_found',
          message: 'No megarepo.json found',
        })
      }
      const output = yield* Effect.promise(() =>
        renderToString({
          element: React.createElement(
            Box,
            { flexDirection: 'row' },
            React.createElement(Text, { color: 'red' }, '\u2717'),
            React.createElement(
              Text,
              null,
              ' No megarepo.json found in current directory or any parent.',
            ),
          ),
        }),
      )
      yield* Console.error(output)
      return yield* new NotInMegarepoError({ message: 'Not in a megarepo' })
    }

    const name = yield* Git.deriveMegarepoName(root.value)

    if (json) {
      console.log(JSON.stringify({ root: root.value, name, source: 'search' }))
    } else {
      yield* Console.log(root.value)
    }
  }).pipe(Effect.withSpan('megarepo/root'), withJsonMode(json))
}).pipe(Cli.Command.withDescription('Print the megarepo root directory'))
