#!/usr/bin/env bun

import * as Cli from 'effect/unstable/cli'
import { NodeServices, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer, Schema } from 'effect'

import { ServiceIdentity } from '@overeng/otel-contract'
import { runTuiMain } from '@overeng/tui-react/node'
import { CurrentWorkingDirectory } from '@overeng/utils/node'
import { rewriteHelpSubcommand } from '@overeng/utils/node/cli-help-rewrite'
import { CliVersion, resolveCliVersion } from '@overeng/utils/node/cli-version'
import { otelEndpointFromConfig, withTelemetry } from '@overeng/utils/node/otel'

import { genieCommand } from '../src/build/mod.tsx'

// Build stamp placeholder replaced by nix build with NixStamp JSON
const buildStamp = '__CLI_BUILD_STAMP__'
const version = resolveCliVersion({
  baseVersion: '0.1.0',
  buildStamp,
})

const identity = Schema.decodeSync(ServiceIdentity)({
  name: 'genie',
  namespace: 'overeng',
  version,
})

const command = Cli.Command.provide(genieCommand, CurrentWorkingDirectory.live)

const program = Effect.gen(function* () {
  const endpoint = yield* otelEndpointFromConfig()

  yield* Cli.Command.runWith(command, {
    name: 'genie',
    version,
  })(rewriteHelpSubcommand(process.argv)).pipe(
    Effect.scoped,
    CliVersion.enrichErrors,
    Effect.provideService(CliVersion, { name: 'genie', version }),
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, withTelemetry({ identity, shape: 'cli', endpoint })),
    ),
  )
})

program.pipe(runTuiMain(NodeRuntime))
