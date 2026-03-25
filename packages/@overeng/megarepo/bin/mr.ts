#!/usr/bin/env bun

import * as Cli from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect, Layer } from 'effect'

import { runTuiMain } from '@overeng/tui-react/node'
import { rewriteHelpSubcommand } from '@overeng/utils/node/cli-help-rewrite'
import { CliVersion, resolveCliVersion } from '@overeng/utils/node/cli-version'
import { makeOtelCliLayer } from '@overeng/utils/node/otel'

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

const baseLayer = Layer.mergeAll(NodeContext.layer, makeOtelCliLayer({ serviceName: 'megarepo' }))

Cli.Command.run(mrCommand, {
  name: 'mr',
  version,
})(rewriteHelpSubcommand(process.argv)).pipe(
  Effect.scoped,
  CliVersion.enrichErrors,
  Effect.provideService(CliVersion, { name: 'mr', version }),
  Effect.provide(baseLayer),
  runTuiMain(NodeRuntime),
)
