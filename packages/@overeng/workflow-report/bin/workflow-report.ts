#!/usr/bin/env bun

import * as Cli from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer, Schema } from 'effect'

import { ServiceIdentity } from '@overeng/otel-contract'
import { rewriteHelpSubcommand } from '@overeng/utils/node/cli-help-rewrite'
import { CliVersion, resolveCliVersion } from '@overeng/utils/node/cli-version'
import { otelEndpointFromConfig, withTelemetry } from '@overeng/utils/node/otel'

import { workflowReportCommand } from '../src/cli-command.ts'

const buildStamp = '__CLI_BUILD_STAMP__'
const version = resolveCliVersion({
  baseVersion: '0.1.0',
  buildStamp,
})

const identity = Schema.decodeSync(ServiceIdentity)({
  name: 'workflow-report-cli',
  namespace: 'overeng',
  version,
})

const program = Effect.gen(function* () {
  const endpoint = yield* otelEndpointFromConfig()

  yield* Cli.Command.run(workflowReportCommand, {
    name: 'workflow-report',
    version,
  })(rewriteHelpSubcommand(process.argv)).pipe(
    Effect.scoped,
    CliVersion.enrichErrors,
    Effect.provideService(CliVersion, { name: 'workflow-report', version }),
    Effect.provide(
      Layer.mergeAll(NodeContext.layer, withTelemetry({ identity, shape: 'cli', endpoint })),
    ),
  )
})

program.pipe(NodeRuntime.runMain({ disableErrorReporting: true }))
