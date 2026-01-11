#!/usr/bin/env bun

import * as Cli from '@effect/cli'
import * as PlatformNode from '@effect/platform-node'
import { Effect, Option, pipe } from 'effect'
import type { Scope } from 'effect/Scope'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import type { Error as PlatformError, FileSystem, Path } from '@effect/platform'
import type { Terminal } from '@effect/platform/Terminal'

import { resolveCliVersion } from '@overeng/utils/node/cli-version'

import { CatalogReadError } from './catalog.ts'
import { CheckFailedError, checkCommand } from './commands/check.ts'
import { InstallFailedError, PackageJsonParseError, installCommand } from './commands/install.ts'
import type { InstallCommandConfig } from './commands/install.ts'
import { listCommand } from './commands/list.ts'
import { ConfigLoadError, ConfigValidationError } from './config.ts'

const baseVersion = '0.1.0'
const buildVersion = '__CLI_VERSION__'
const version = resolveCliVersion({
  baseVersion,
  buildVersion,
  runtimeStampEnvVar: 'NIX_CLI_BUILD_STAMP',
})

type PnpmComposeError =
  | CatalogReadError
  | ConfigLoadError
  | ConfigValidationError
  | CheckFailedError
  | InstallFailedError
  | PackageJsonParseError
  | PlatformError.PlatformError

type PnpmComposeConfig = {
  readonly subcommand: Option.Option<InstallCommandConfig | {}>
}

type PnpmComposeEnv =
  | CommandExecutor.CommandExecutor
  | FileSystem.FileSystem
  | Path.Path
  | Terminal
  | Scope

const command: Cli.Command.Command<
  'pnpm-compose',
  PnpmComposeEnv,
  PnpmComposeError,
  PnpmComposeConfig
> =
  Cli.Command.make('pnpm-compose').pipe(
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
