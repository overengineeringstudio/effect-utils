#!/usr/bin/env bun

import * as Cli from '@effect/cli'
import * as PlatformNode from '@effect/platform-node'
import { Effect, pipe } from 'effect'

import { checkCommand } from './commands/check.ts'
import { installCommand } from './commands/install.ts'
import { listCommand } from './commands/list.ts'

const command = Cli.Command.make('bun-compose').pipe(
  Cli.Command.withDescription('CLI for composing bun workspaces with git submodules'),
  Cli.Command.withSubcommands([checkCommand, installCommand, listCommand]),
)

const cli = Cli.Command.run(command, {
  name: 'bun-compose',
  version: '0.1.0',
})

pipe(
  cli(process.argv),
  Effect.scoped,
  Effect.provide(PlatformNode.NodeContext.layer),
  PlatformNode.NodeRuntime.runMain,
)
