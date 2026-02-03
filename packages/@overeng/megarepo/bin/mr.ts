#!/usr/bin/env bun

import * as Cli from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer } from 'effect'

import { runTuiMain } from '@overeng/tui-react'
import { resolveCliVersion } from '@overeng/utils/node/cli-version'

import { Cwd, mrCommand } from '../src/cli/mod.ts'
import { MR_VERSION } from '../src/lib/version.ts'

// Build stamp placeholder replaced by nix build with NixStamp JSON
const buildStamp = '__CLI_BUILD_STAMP__'
const version = resolveCliVersion({
  baseVersion: MR_VERSION,
  buildStamp,
})

const baseLayer = Layer.mergeAll(NodeContext.layer, Cwd.live)

const program = Cli.Command.run(mrCommand, {
  name: 'mr',
  version,
})(process.argv).pipe(Effect.scoped, Effect.provide(baseLayer))

// Use runTuiMain for proper error handling (errors go to stderr, not stdout)
runTuiMain(NodeRuntime)(program)
