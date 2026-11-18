#!/usr/bin/env bun

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer } from 'effect'
import * as Cli from 'effect/cli'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'

import { rewriteHelpSubcommand } from '@overeng/utils/node/cli-help-rewrite'
import { CliVersion, resolveCliIdentity } from '@overeng/utils/node/cli-version'
import { otelEndpointFromConfig, withTelemetry } from '@overeng/utils/node/otel'

import packageJson from '../package.json' with { type: 'json' }
import { ciToolsCommand } from '../src/cli-command.ts'

const buildStamp = '__CLI_BUILD_STAMP__'
const { displayVersion: version, serviceIdentity: identity } = resolveCliIdentity({
  name: 'ci-tools-cli',
  namespace: 'overeng',
  baseVersion: packageJson.version,
  buildStamp,
})

const program = Effect.gen(function* () {
  const endpoint = yield* otelEndpointFromConfig()

  yield* Cli.Command.runWith(ciToolsCommand, { version })(
    rewriteHelpSubcommand(process.argv.slice(2)),
  ).pipe(
    Effect.scoped,
    Effect.annotateLogs({ 'service.version': identity.version }),
    Effect.provide(CliVersion.formatterLayer),
    Effect.provideService(CliVersion, { name: 'ci-tools', version }),
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, withTelemetry({ identity, shape: 'cli', endpoint })),
    ),
  )
}).pipe(Effect.provide(FetchHttpClient.layer))

program.pipe(NodeRuntime.runMain({ disableErrorReporting: true }))
