#!/usr/bin/env bun

import * as Cli from '@effect/cli'
import * as PlatformNode from '@effect/platform-node'
import { Effect, pipe } from 'effect'

import { checkCommand } from './commands/check.ts'
import { installCommand } from './commands/install.ts'
import { listCommand } from './commands/list.ts'

const baseVersion = '0.1.0'
const buildVersion = '__CLI_VERSION__'
const version = buildVersion === '__CLI_VERSION__' ? baseVersion : buildVersion

const command = Cli.Command.make('pnpm-compose').pipe(
  Cli.Command.withDescription('CLI for composing pnpm workspaces with git submodules'),
  Cli.Command.withSubcommands([checkCommand, installCommand, listCommand]),
)

const cli = Cli.Command.run(command, {
  name: 'pnpm-compose',
  version,
})

pipe(
  cli(process.argv),
  Effect.scoped,
  Effect.provide(PlatformNode.NodeContext.layer),
  PlatformNode.NodeRuntime.runMain,
)
