import * as Cli from '@effect/cli'
import * as PlatformNode from '@effect/platform-node'
import { Effect, pipe } from 'effect'

import { resolveCliVersion } from '@overeng/utils/node/cli-version'

import { checkCommand } from './commands/check.ts'
import { installCommand } from './commands/install.ts'
import { listCommand } from './commands/list.ts'

const baseVersion = '0.1.0'
const buildVersion = '__CLI_VERSION__'
const version = resolveCliVersion({
  baseVersion,
  buildVersion,
  runtimeStampEnvVar: 'NIX_CLI_BUILD_STAMP',
})

const command = Cli.Command.make('bun-compose').pipe(
  Cli.Command.withDescription('CLI for composing bun workspaces with git submodules'),
  Cli.Command.withSubcommands([checkCommand, installCommand, listCommand]),
)

const cli = Cli.Command.run(command, {
  name: 'bun-compose',
  version,
})

pipe(
  cli(process.argv),
  Effect.scoped,
  Effect.provide(PlatformNode.NodeContext.layer),
  PlatformNode.NodeRuntime.runMain,
)
