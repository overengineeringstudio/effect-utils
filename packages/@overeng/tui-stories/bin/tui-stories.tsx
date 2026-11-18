#!/usr/bin/env bun

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import * as Cli from 'effect/cli'

import { runTuiMain } from '@overeng/tui-react/node'
import { rewriteHelpSubcommand } from '@overeng/utils/node/cli-help-rewrite'
import {
  CliVersion,
  handlerConsoleLayer,
  jsonStdoutGuardLayer,
  resolveCliVersion,
} from '@overeng/utils/node/cli-version'

import packageJson from '../package.json' with { type: 'json' }
import { tuiStoriesCommand } from '../src/cli/mod.ts'

// Build stamp placeholder replaced by nix build with NixStamp JSON
const buildStamp = '__CLI_BUILD_STAMP__'
const version = resolveCliVersion({
  baseVersion: packageJson.version,
  buildStamp,
})

const args = rewriteHelpSubcommand(process.argv.slice(2))

Cli.Command.runWith(Cli.Command.provide(tuiStoriesCommand, handlerConsoleLayer), { version })(
  args,
).pipe(
  Effect.scoped,
  Effect.provide(
    Layer.mergeAll(
      Layer.provide(
        CliVersion.formatterLayer,
        Layer.succeed(CliVersion, { name: 'tui-stories', version }),
      ),
      jsonStdoutGuardLayer(args),
      NodeServices.layer,
    ),
  ),
  runTuiMain(NodeRuntime),
)
