#!/usr/bin/env bun

import * as Cli from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer } from 'effect'

import { Cwd } from '../src/cli/mod.ts'
import { mrCommand } from '../src/cli/mod.ts'

// Version placeholder replaced by nix build
const buildVersion = '__CLI_VERSION__'

const baseLayer = Layer.mergeAll(NodeContext.layer, Cwd.live)

Cli.Command.run(mrCommand, {
  name: 'mr',
  version: buildVersion,
})(process.argv).pipe(Effect.provide(baseLayer), NodeRuntime.runMain)
