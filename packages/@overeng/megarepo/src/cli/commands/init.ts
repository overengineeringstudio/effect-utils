/**
 * Init Command
 *
 * Initialize a new megarepo in the current directory.
 */

import path from 'node:path'

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Console, Effect, Schema } from 'effect'

import { styled, symbols } from '@overeng/cli-ui'
import { EffectPath } from '@overeng/effect-path'
import { jsonError, withJsonMode } from '@overeng/utils/node'

import { CONFIG_FILE_NAME, MegarepoConfig } from '../../lib/config.ts'
import * as Git from '../../lib/git.ts'
import { Cwd, jsonOption } from '../context.ts'

/** Initialize a new megarepo in current directory */
export const initCommand = Cli.Command.make('init', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const fs = yield* FileSystem.FileSystem

    // Check if already in a git repo
    const isGit = yield* Git.isGitRepo(cwd)
    if (!isGit) {
      if (json) {
        return yield* jsonError({ error: 'not_git_repo', message: 'Not a git repository' })
      }
      yield* Console.error(
        `${styled.red(symbols.cross)} Not a git repository. Run 'git init' first.`,
      )
      return yield* Effect.fail(new Error('Not a git repository'))
    }

    const configPath = EffectPath.ops.join(cwd, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME))

    // Check if config already exists
    const exists = yield* fs.exists(configPath)
    if (exists) {
      if (json) {
        console.log(JSON.stringify({ status: 'already_initialized', path: configPath }))
      } else {
        yield* Console.log(styled.dim('megarepo already initialized'))
      }
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

    if (json) {
      console.log(JSON.stringify({ status: 'initialized', path: configPath }))
    } else {
      yield* Console.log(
        `${styled.green(symbols.check)} ${styled.dim('initialized megarepo at')} ${styled.bold(path.basename(cwd))}`,
      )
    }
  }).pipe(Effect.withSpan('megarepo/init'), withJsonMode(json)),
).pipe(Cli.Command.withDescription('Initialize a new megarepo in the current directory'))
