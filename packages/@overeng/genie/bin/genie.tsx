#!/usr/bin/env bun

import * as Cli from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer } from 'effect'

import { runTuiMain } from '@overeng/tui-react'
import { CurrentWorkingDirectory } from '@overeng/utils/node'
import { resolveCliVersion } from '@overeng/utils/node/cli-version'

import { genieCommand } from '../src/build/mod.tsx'

// Build stamp placeholder replaced by nix build with NixStamp JSON
const buildStamp = '__CLI_BUILD_STAMP__'
const version = resolveCliVersion({
  baseVersion: '0.1.0',
  buildStamp,
})

const baseLayer = Layer.mergeAll(NodeContext.layer, CurrentWorkingDirectory.live)

const program = Cli.Command.run(genieCommand, {
  name: 'genie',
  version,
})(process.argv).pipe(Effect.scoped, Effect.provide(baseLayer))

// Use runTuiMain for proper error handling (errors go to stderr, not stdout)
runTuiMain(NodeRuntime)(program)
