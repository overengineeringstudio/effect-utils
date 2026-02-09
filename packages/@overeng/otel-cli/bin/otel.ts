#!/usr/bin/env bun

import * as Cli from '@effect/cli'
import { FetchHttpClient } from '@effect/platform'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer } from 'effect'

import { runTuiMain } from '@overeng/tui-react/node'
import { makeOtelCliLayer } from '@overeng/utils/node/otel'

import { otelCommand } from '../src/cli.ts'
import { OtelConfig } from '../src/services/OtelConfig.ts'

const baseLayer = Layer.mergeAll(
  NodeContext.layer,
  FetchHttpClient.layer,
  OtelConfig.live,
  makeOtelCliLayer({ serviceName: 'otel-cli' }),
)

Cli.Command.run(otelCommand, {
  name: 'otel',
  version: '0.1.0',
})(process.argv).pipe(Effect.scoped, Effect.provide(baseLayer), runTuiMain(NodeRuntime))
