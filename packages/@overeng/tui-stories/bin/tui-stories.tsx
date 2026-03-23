#!/usr/bin/env bun

import { Command } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'

import { runTuiMain } from '@overeng/tui-react/node'
import { rewriteHelpSubcommand } from '@overeng/utils/node/cli-help-rewrite'

import { tuiStoriesCommand } from '../src/cli/mod.ts'

const cli = Command.run(tuiStoriesCommand, {
  name: 'tui-stories',
  version: '0.1.0',
})

cli(rewriteHelpSubcommand(process.argv)).pipe(
  Effect.scoped,
  Effect.provide(NodeContext.layer),
  runTuiMain(NodeRuntime),
)
