import path from 'node:path'

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import * as PlatformNode from '@effect/platform-node'
import { Effect, Layer, Option, pipe, Schema } from 'effect'

import { styled, symbols } from '@overeng/cli-ui'

import {
  execCommand,
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
  RootConfigSchema,
} from './lib/mod.ts'

/** Initialize a new dotdot workspace */
const initCommand = Cli.Command.make('init', {}, () =>
  Effect.gen(function* () {
    const cwd = yield* CurrentWorkingDirectory
    const fs = yield* FileSystem.FileSystem

    const configPath = path.join(cwd, CONFIG_FILE_NAME)

    const exists = yield* fs.exists(configPath)
    if (exists) {
      yield* Effect.log(styled.dim('workspace already initialized'))
      return
    }

    const initialConfig = {
      $schema: JSON_SCHEMA_URL,
      repos: {},
    }

    const configContent = yield* Schema.encode(Schema.parseJson(RootConfigSchema, { space: 2 }))(
      initialConfig,
    )
    yield* fs.writeFileString(configPath, configContent + '\n')

    yield* Effect.log(
      `${styled.green(symbols.check)} ${styled.dim('initialized workspace at')} ${styled.bold(path.basename(cwd))}`,
    )
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
      const jsonSchema = generateJsonSchema()
      const content =
        (yield* Schema.encode(Schema.parseJson(Schema.Unknown, { space: 2 }))(jsonSchema)) + '\n'

      if (Option.isSome(output)) {
        yield* fs.writeFileString(output.value, content)
        yield* Effect.log(
          `${styled.green(symbols.check)} ${styled.dim('schema written to')} ${styled.bold(output.value)}`,
        )
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
    execCommand,
    schemaCommand,
  ]),
)

/** Main CLI entry point */
export const dotdotCommand = rootCommand

const baseVersion = '0.1.0'
const buildVersion = '__CLI_VERSION__'
const version = resolveCliVersion({
  baseVersion,
  buildVersion,
  runtimeStampEnvVar: 'NIX_CLI_BUILD_STAMP',
})

if (import.meta.main) {
  // Base layer provides platform services (FileSystem, CommandExecutor) and CWD.
  // WorkspaceService is NOT included here - each command provides its own layer variant.
  // This allows commands like `sync` to run without requiring configs to already be in sync.
  const baseLayer = Layer.mergeAll(PlatformNode.NodeContext.layer, CurrentWorkingDirectory.live)

  pipe(
    Cli.Command.run(dotdotCommand, {
      name: 'dotdot',
      version,
    })(process.argv),
    Effect.provide(baseLayer),
    PlatformNode.NodeRuntime.runMain,
  )
}
