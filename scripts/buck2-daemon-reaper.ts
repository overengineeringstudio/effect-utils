#!/usr/bin/env bun

/** Script adapter; all maintenance policy lives in the shared mr runtime. */
import { parseArgs } from 'node:util'

import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Console, Effect, Schema } from 'effect'

import { runBuckMaintain } from '../packages/@overeng/megarepo/src/store/store-buck-maintain.ts'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    config: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: false,
})

Effect.gen(function* () {
  const receipt = yield* runBuckMaintain({
    configPath: values.config,
    dryRun: values['dry-run'] === true,
  })
  if (values.json === true) {
    yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(receipt))
  } else {
    yield* Console.log(
      `Buck maintenance${receipt.dryRun === true ? ' (dry run)' : ''}: ${receipt.summary.worktrees} worktrees · ${receipt.summary.actions} actions · ${receipt.summary.skipped} skipped`,
    )
  }
}).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain)
