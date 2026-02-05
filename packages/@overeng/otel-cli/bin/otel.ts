#!/usr/bin/env bun

import * as Cli from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer } from 'effect'

import { runTuiMain } from '@overeng/tui-react'

import { otelCommand } from '../src/cli.ts'

const baseLayer = Layer.mergeAll(NodeContext.layer)

Cli.Command.run(otelCommand, {
  name: 'otel',
  version: '0.1.0',
})(process.argv).pipe(Effect.scoped, Effect.provide(baseLayer), runTuiMain(NodeRuntime))
