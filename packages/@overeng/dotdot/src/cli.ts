import path from 'node:path'

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import * as PlatformNode from '@effect/platform-node'
import { Effect, Layer, Option, pipe } from 'effect'

import {
  execCommand,
  linkCommand,
  pullCommand,
  statusCommand,
  syncCommand,
  treeCommand,
  updateRevsCommand,
} from './commands/mod.ts'
import {
  CONFIG_FILE_NAME,
  CurrentWorkingDirectory,
  generateJsonSchema,
  JSON_SCHEMA_URL,
  resolveCliVersion,
} from './lib/mod.ts'

const baseVersion = '0.1.0'
const buildVersion = '__CLI_VERSION__'
const version = resolveCliVersion({
  baseVersion,
  buildVersion,
  runtimeStampEnvVar: 'NIX_CLI_BUILD_STAMP',
})

/** Initialize a new dotdot workspace */
const initCommand = Cli.Command.make('init', {}, () =>
  Effect.gen(function* () {
    const cwd = yield* CurrentWorkingDirectory
    const fs = yield* FileSystem.FileSystem

    const configPath = path.join(cwd, CONFIG_FILE_NAME)

    const exists = yield* fs.exists(configPath)
    if (exists) {
      yield* Effect.log('Workspace already initialized')
      return
    }

    const initialConfig = {
      $schema: JSON_SCHEMA_URL,
      repos: {},
    }

    yield* fs.writeFileString(configPath, JSON.stringify(initialConfig, null, 2) + '\n')

    yield* Effect.log(`Initialized dotdot workspace at ${cwd}`)
  }).pipe(Effect.withSpan('dotdot/init')),
)

/** Generate JSON Schema for dotdot.json */
const schemaCommand = Cli.Command.make(
  'schema',
  {
    output: Cli.Options.file('output').pipe(
      Cli.Options.withAlias('o'),
      Cli.Options.withDescription('Output file path for the schema'),
      Cli.Options.optional,
    ),
  },
  ({ output }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const schema = generateJsonSchema()
      const content = JSON.stringify(schema, null, 2) + '\n'

      if (Option.isSome(output)) {
        yield* fs.writeFileString(output.value, content)
        yield* Effect.log(`Schema written to ${output.value}`)
      } else {
        // Print to stdout
        console.log(content)
      }
    }).pipe(Effect.withSpan('dotdot/schema')),
)

/** Root command */
const rootCommand = Cli.Command.make('dotdot', {}).pipe(
  Cli.Command.withSubcommands([
    initCommand,
    statusCommand,
    syncCommand,
    updateRevsCommand,
    pullCommand,
    treeCommand,
    linkCommand,
    execCommand,
    schemaCommand,
  ]),
)

/** Main CLI entry point */
export const dotdotCommand = rootCommand

if (import.meta.main) {
  pipe(
    Cli.Command.run(dotdotCommand, {
      name: 'dotdot',
      version,
    })(process.argv),
    Effect.provide(Layer.mergeAll(PlatformNode.NodeContext.layer, CurrentWorkingDirectory.live)),
    PlatformNode.NodeRuntime.runMain,
  )
}
