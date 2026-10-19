#!/usr/bin/env bun

/** Thin CLI adapter: receipt output and failure exit status are owned by mr. */
import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'

import { runTuiMain } from '@overeng/tui-react/node'

import { cli } from '../packages/@overeng/megarepo/src/cli/mod.ts'

cli(['store', 'buck-maintain', ...process.argv.slice(2)]).pipe(
  Effect.provide(NodeServices.layer),
  runTuiMain(NodeRuntime),
)
