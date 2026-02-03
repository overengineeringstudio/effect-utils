#!/usr/bin/env bun

import * as Cli from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Chunk, Effect, Layer, Logger, Cause } from 'effect'

import { resolveCliVersion } from '@overeng/utils/node/cli-version'

import { Cwd, mrCommand } from '../src/cli/mod.ts'
import { MR_VERSION } from '../src/lib/version.ts'

// Build stamp placeholder replaced by nix build with NixStamp JSON
const buildStamp = '__CLI_BUILD_STAMP__'
const version = resolveCliVersion({
  baseVersion: MR_VERSION,
  buildStamp,
})

// Use a logger that writes to stderr to avoid polluting stdout (important for JSON output)
const stderrLogger = Logger.prettyLogger().pipe(Logger.withConsoleError)
const loggerLayer = Logger.replace(Logger.defaultLogger, stderrLogger)

const baseLayer = Layer.mergeAll(NodeContext.layer, Cwd.live, loggerLayer)

const program = Cli.Command.run(mrCommand, {
  name: 'mr',
  version,
})(process.argv).pipe(
  Effect.scoped,
  Effect.provide(baseLayer),
  // Catch SyncFailedError and re-fail without logging (the error is already in JSON output)
  // This prevents double-logging while still preserving the error exit code
  Effect.catchTag('SyncFailedError', (e) => Effect.fail(e)),
)

// Use runMain with disableErrorReporting since we handle specific errors above
// and use our stderr logger for regular logging
program.pipe(
  // Custom error reporting that writes to stderr
  Effect.tapErrorCause((cause) =>
    Effect.sync(() => {
      // Skip SyncFailedError since its details are already in the JSON output
      const failures = Cause.failures(cause)
      const isSyncFailedError = Chunk.some(
        failures,
        (f): boolean =>
          f !== null && typeof f === 'object' && '_tag' in f && f._tag === 'SyncFailedError',
      )
      if (!isSyncFailedError) {
        // Format and write to stderr for non-SyncFailedError errors
        const pretty = Cause.pretty(cause, { renderErrorCause: true })
        process.stderr.write(pretty + '\n')
      }
    }),
  ),
  NodeRuntime.runMain({ disableErrorReporting: true }),
)
