#!/usr/bin/env bun

import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer } from 'effect'

import { makeOtelCliLayer } from '@overeng/utils/node/otel'

import { cli, renderCliError } from './cli-program.ts'

const toEffectCliArgv = ({
  binaryName,
  args,
}: {
  readonly binaryName: string
  readonly args: ReadonlyArray<string>
}) => ['node', binaryName, ...args]

/** Run the notion-md CLI from user-facing arguments. */
export const runCliMain = ({
  args = process.argv.slice(2),
}: {
  readonly args?: ReadonlyArray<string>
} = {}) =>
  cli(toEffectCliArgv({ binaryName: 'notion-md', args })).pipe(
    Effect.tapErrorCause(renderCliError),
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(NodeContext.layer, makeOtelCliLayer({ serviceName: 'notion-md-cli' })),
    ),
  )

if (import.meta.main) {
  runCliMain().pipe(NodeRuntime.runMain({ disableErrorReporting: true }))
}
