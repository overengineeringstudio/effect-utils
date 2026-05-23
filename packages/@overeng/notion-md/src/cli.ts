#!/usr/bin/env bun

import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer } from 'effect'

import { makeOtelCliLayer } from '@overeng/utils/node/otel'

import { cli, renderCliError } from './cli-program.ts'

cli(process.argv).pipe(
  Effect.tapErrorCause(renderCliError),
  Effect.scoped,
  Effect.provide(
    Layer.mergeAll(NodeContext.layer, makeOtelCliLayer({ serviceName: 'notion-md-cli' })),
  ),
  NodeRuntime.runMain({ disableErrorReporting: true }),
)
