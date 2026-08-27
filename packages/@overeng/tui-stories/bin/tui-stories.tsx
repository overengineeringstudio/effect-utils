#!/usr/bin/env bun

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import * as Cli from 'effect/unstable/cli'

import { runTuiMain } from '@overeng/tui-react/node'
import { rewriteHelpSubcommand } from '@overeng/utils/node/cli-help-rewrite'
import {
  CliVersion,
  handlerConsoleLayer,
  jsonStdoutGuardLayer,
  resolveCliVersion,
} from '@overeng/utils/node/cli-version'

import { tuiStoriesCommand } from '../src/cli/mod.ts'

// Build stamp placeholder replaced by nix build with NixStamp JSON
const buildStamp = '__CLI_BUILD_STAMP__'
const version = resolveCliVersion({
  baseVersion: '0.1.0',
  buildStamp,
})

const args = rewriteHelpSubcommand(process.argv.slice(2))

Cli.Command.runWith(Cli.Command.provide(tuiStoriesCommand, handlerConsoleLayer), { version })(
  args,
).pipe(
  Effect.scoped,
  Effect.provide(CliVersion.formatterLayer),
  Effect.provide(jsonStdoutGuardLayer(args)),
  Effect.provideService(CliVersion, { name: 'tui-stories', version }),
  Effect.provide(NodeServices.layer),
  runTuiMain(NodeRuntime),
)
