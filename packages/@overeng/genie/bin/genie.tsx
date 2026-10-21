#!/usr/bin/env bun

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Layer, Schema } from 'effect'
import * as Cli from 'effect/cli'

import { ServiceIdentity } from '@overeng/otel-contract'
import { runTuiMain } from '@overeng/tui-react/node'
import { CurrentWorkingDirectory } from '@overeng/utils/node'
import { rewriteHelpSubcommand } from '@overeng/utils/node/cli-help-rewrite'
import {
  CliVersion,
  handlerConsoleLayer,
  jsonStdoutGuardLayer,
  resolveCliVersion,
} from '@overeng/utils/node/cli-version'
import { otelEndpointFromConfig, withTelemetry } from '@overeng/utils/node/otel'

import { genieCommand } from '../src/build/mod.tsx'
import { isCompiledBinary } from '../src/core/discovery.ts'
import { GenieRuntimeTranspilerCacheError } from '../src/core/errors.ts'

// The packaged wrapper sets this before Bun starts. Unwrapped source invocations
// replace themselves once: a late environment assignment cannot invalidate Bun's
// memoized cache configuration, and cached plugin output can contain another pin.
if (isCompiledBinary() === false && process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH === undefined) {
  if (process.execve === undefined) {
    throw new GenieRuntimeTranspilerCacheError({
      message:
        'This runtime cannot replace the current process. Start Genie with BUN_RUNTIME_TRANSPILER_CACHE_PATH=0.',
    })
  }
  process.execve(
    process.execPath,
    [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
    { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
  )
}

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

const command = Cli.Command.provide(
  Cli.Command.provide(genieCommand, CurrentWorkingDirectory.live),
  handlerConsoleLayer,
)

const program = Effect.gen(function* () {
  const endpoint = yield* otelEndpointFromConfig()

  const args = rewriteHelpSubcommand(process.argv.slice(2))

  yield* Cli.Command.runWith(command, { version })(args).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        Layer.provide(
          CliVersion.formatterLayer,
          Layer.succeed(CliVersion, { name: 'genie', version }),
        ),
        jsonStdoutGuardLayer(args),
        NodeServices.layer,
        withTelemetry({ identity, shape: 'cli', endpoint }),
      ),
    ),
  )
})

program.pipe(runTuiMain(NodeRuntime))
