#!/usr/bin/env bun

import { NodeServices, NodeRuntime } from '@effect/platform-node'
import { Effect, type Exit, Layer, Schema } from 'effect'

import { ServiceIdentity } from '@overeng/otel-contract'
import { otelEndpointFromConfig, withTelemetry } from '@overeng/utils/node/otel'

import { cli, cliVersion, renderCliError } from './cli-program.ts'
import { editorExitCode } from './exit-codes.ts'

/** Run the notion-md CLI from user-facing arguments. */
export const runCliMain = ({
  args = process.argv.slice(2),
}: {
  readonly args?: ReadonlyArray<string>
} = {}) =>
  Effect.gen(function* () {
    const endpoint = yield* otelEndpointFromConfig()

    yield* cli(toEffectCliArgv({ binaryName: 'notion-md', args })).pipe(
      Effect.tapErrorCause(renderCliError),
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, withTelemetry({ identity, shape: 'cli', endpoint })),
      ),
    )
  })

/**
 * Map the program `Exit` to the editor-surface exit-code contract (exit-codes.ts).
 * Runs after every scope/finalizer closes, so `edit`'s temp-dir cleanup is safe.
 */
// oxlint-disable-next-line overeng/named-args -- implements the Effect `Teardown` interface (positional `(exit, onExit)` signature required by NodeRuntime.runMain)
const editorTeardown = <E, A>(exit: Exit.Exit<E, A>, onExit: (code: number) => void): void => {
  onExit(editorExitCode(exit))
}

const toEffectCliArgv = ({
  binaryName,
  args,
}: {
  readonly binaryName: string
  readonly args: ReadonlyArray<string>
}) => ['node', binaryName, ...args]

const identity = Schema.decodeSync(ServiceIdentity)({
  name: 'notion-md-cli',
  namespace: 'overeng',
  version: cliVersion,
})

if (import.meta.main) {
  NodeRuntime.runMain({ disableErrorReporting: true, teardown: editorTeardown })(runCliMain())
}
