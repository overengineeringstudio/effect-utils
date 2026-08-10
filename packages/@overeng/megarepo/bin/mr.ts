#!/usr/bin/env bun

import * as Cli from 'effect/unstable/cli'
import { NodeServices, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer, Schema } from 'effect'

import { ServiceIdentity } from '@overeng/otel-contract'
import { runTuiMain } from '@overeng/tui-react/node'
import { rewriteHelpSubcommand } from '@overeng/utils/node/cli-help-rewrite'
import { CliVersion, resolveCliVersion } from '@overeng/utils/node/cli-version'
import { makeOtelCliLayer, otelEndpointFromConfig } from '@overeng/utils/node/otel'

import { mrCommand } from '../src/cli/mod.ts'
import { MR_VERSION } from '../src/lib/version.ts'

/**
 * Clear git environment variables that leak when `mr` runs inside a git hook
 * (e.g. pre-commit). Without this, GIT_DIR/GIT_WORK_TREE etc. cause all child
 * git processes to operate on the parent repo instead of the intended bare repos,
 * resulting in every member resolving to the same commit hash.
 * See: https://github.com/overengineeringstudio/effect-utils/issues/390
 */
for (const key of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_QUARANTINE_PATH',
]) {
  delete process.env[key]
}

// Build stamp placeholder replaced by nix build with NixStamp JSON
const buildStamp = '__CLI_BUILD_STAMP__'
const version = resolveCliVersion({
  baseVersion: MR_VERSION,
  buildStamp,
})

/**
 * Resolve the OTLP endpoint at the composition root via Effect `Config`, then
 * build the OTEL layer from that explicit endpoint and provide it to the command.
 * Resolving here (not inside `makeOtelCliLayer`) keeps the layer a pure function
 * of its input and confines env access to the edge. `Effect.provide` bounds the
 * layer's scope to the command effect, so the still-sync `Layer.suspend` exporter
 * finalizers still flush on shutdown (no `Layer.unwrapEffect`).
 */
const identity = Schema.decodeSync(ServiceIdentity)({
  name: 'megarepo',
  namespace: 'overeng',
  version,
})

const program = Effect.gen(function* () {
  const endpoint = yield* otelEndpointFromConfig()

  const otelLayer = makeOtelCliLayer({
    identity,
    endpoint,
    exportInterval: 50,
    // Mid-run granularity only: sample the `megarepo_store_gc_rss_bytes` gauge
    // often enough to plot RSS-vs-time on a ~10s gc run (decision 0007); the
    // final value flushes on shutdown regardless of this interval. Only gc
    // registers a metric, so it's a no-op for other `mr` commands. shutdownTimeout
    // is intentionally left at the safe TTY-aware default (never a small override,
    // which would interrupt and drop the final flush).
    metricsExportInterval: 1000,
  })

  yield* Cli.Command.run(mrCommand, {
    name: 'mr',
    version,
  })(rewriteHelpSubcommand(process.argv)).pipe(
    Effect.scoped,
    CliVersion.enrichErrors,
    Effect.provideService(CliVersion, { name: 'mr', version }),
    Effect.provide(Layer.mergeAll(NodeServices.layer, otelLayer)),
  )
})

program.pipe(runTuiMain(NodeRuntime))
