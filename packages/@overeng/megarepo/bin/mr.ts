#!/usr/bin/env bun

import * as Cli from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer } from 'effect'

import { resolveCliVersion } from '@overeng/utils/node/cli-version'

import { Cwd, mrCommand } from '../src/cli/mod.ts'
import { MR_VERSION } from '../src/lib/version.ts'

// Version placeholder replaced by nix build
const buildVersion = '__CLI_VERSION__'
const version = resolveCliVersion({
  baseVersion: MR_VERSION,
  buildVersion,
  runtimeStampEnvVar: 'NIX_CLI_BUILD_STAMP',
})

const baseLayer = Layer.mergeAll(NodeContext.layer, Cwd.live)

Cli.Command.run(mrCommand, {
  name: 'mr',
  version,
})(process.argv).pipe(Effect.provide(baseLayer), NodeRuntime.runMain)
