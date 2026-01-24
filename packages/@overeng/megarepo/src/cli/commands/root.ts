/**
 * Root Command
 *
 * Find and print the megarepo root directory.
 */

import * as Cli from '@effect/cli'
import { Console, Effect, Option } from 'effect'

import { styled, symbols } from '@overeng/cli-ui'
import { jsonError, withJsonMode } from '@overeng/utils/node'

import * as Git from '../../lib/git.ts'
import { Cwd, findMegarepoRoot, jsonOption } from '../context.ts'

/** Find and print the megarepo root directory */
export const rootCommand = Cli.Command.make('root', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd

    // Search up from current directory
    const root = yield* findMegarepoRoot(cwd)

    if (Option.isNone(root)) {
      if (json) {
        return yield* jsonError({ error: 'not_found', message: 'No megarepo.json found' })
      }
      yield* Console.error(
        `${styled.red(symbols.cross)} No megarepo.json found in current directory or any parent.`,
      )
      return yield* Effect.fail(new Error('Not in a megarepo'))
    }

    const name = yield* Git.deriveMegarepoName(root.value)

    if (json) {
      console.log(JSON.stringify({ root: root.value, name, source: 'search' }))
    } else {
      yield* Console.log(root.value)
    }
  }).pipe(Effect.withSpan('megarepo/root'), withJsonMode(json)),
).pipe(Cli.Command.withDescription('Print the megarepo root directory'))
