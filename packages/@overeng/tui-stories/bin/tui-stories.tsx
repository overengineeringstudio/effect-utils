#!/usr/bin/env bun

import { Command } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'

import { runTuiMain } from '@overeng/tui-react/node'
import { rewriteHelpSubcommand } from '@overeng/utils/node/cli-help-rewrite'
import { CliVersion, resolveCliVersion } from '@overeng/utils/node/cli-version'

import { tuiStoriesCommand } from '../src/cli/mod.ts'

// Build stamp placeholder replaced by nix build with NixStamp JSON
const buildStamp = '__CLI_BUILD_STAMP__'
const version = resolveCliVersion({
  baseVersion: '0.1.0',
  buildStamp,
})

const cli = Command.run(tuiStoriesCommand, {
  name: 'tui-stories',
  version,
})

cli(rewriteHelpSubcommand(process.argv)).pipe(
  Effect.scoped,
  CliVersion.enrichErrors('tui-stories'),
  Effect.provideService(CliVersion, version),
  Effect.provide(NodeContext.layer),
  runTuiMain(NodeRuntime),
)
