#!/usr/bin/env bun

import { Command } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Cause, Effect, Layer, Logger, LogLevel } from 'effect'

import { genieCommand } from '@overeng/genie/cli'
import { CurrentWorkingDirectory } from '@overeng/utils/node'

import {
  buildCommand,
  checkCommand,
  cleanCommand,
  contextCommand,
  lintCommand,
  nixCommand,
  testCommand,
  tsCommand,
} from './commands/index.js'

const command = Command.make('mono').pipe(
  Command.withSubcommands([
    buildCommand,
    testCommand,
    lintCommand,
    tsCommand,
    cleanCommand,
    checkCommand,
    genieCommand,
    nixCommand,
    contextCommand,
  ]),
  Command.withDescription('Monorepo management CLI'),
)

const cli = Command.run(command, {
  name: 'mono',
  version: '0.1.0',
})

cli(process.argv).pipe(
  Effect.tapErrorCause((cause) => {
    if (Cause.isInterruptedOnly(cause)) {
      return Effect.void
    }
    return Effect.logError(cause)
  }),
  Effect.provide(
    Layer.mergeAll(
      NodeContext.layer,
      CurrentWorkingDirectory.live,
      Logger.minimumLogLevel(LogLevel.Debug),
    ),
  ),
  NodeRuntime.runMain({ disableErrorReporting: true }),
)
