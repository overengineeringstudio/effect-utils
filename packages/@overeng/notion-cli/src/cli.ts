#!/usr/bin/env bun

import { Command } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Cause, Effect, Layer, Option } from 'effect'

import { CurrentWorkingDirectory } from '@overeng/utils/node'

import { dbCommand } from './commands/db/mod.ts'
import { schemaCommand, SchemaDriftDetectedError } from './commands/schema/mod.ts'

// Re-export errors for backwards compatibility
export { GeneratedSchemaFileParseError, SchemaDriftDetectedError } from './commands/schema/mod.ts'

// -----------------------------------------------------------------------------
// Main CLI
// -----------------------------------------------------------------------------

const command = Command.make('notion').pipe(
  Command.withSubcommands([schemaCommand, dbCommand]),
  Command.withDescription('Notion CLI - database operations and schema generation'),
)

const cli = Command.run(command, {
  name: 'notion',
  version: '0.1.0',
})

const hasTag = (u: unknown): u is { readonly _tag: string } =>
  typeof u === 'object' &&
  u !== null &&
  '_tag' in u &&
  typeof (u as { readonly _tag?: unknown })._tag === 'string'

cli(process.argv).pipe(
  Effect.tapErrorCause((cause) => {
    if (Cause.isInterruptedOnly(cause)) {
      return Effect.void
    }

    return Option.match(Cause.failureOption(cause), {
      onNone: () => Effect.logError(cause),
      onSome: (error) => {
        const unknownError: unknown = error
        return hasTag(unknownError) && unknownError._tag === 'SchemaDriftDetectedError'
          ? Effect.void
          : Effect.logError(cause)
      },
    })
  }),
  Effect.provide(Layer.mergeAll(NodeContext.layer, CurrentWorkingDirectory.live)),
  NodeRuntime.runMain({ disableErrorReporting: true }),
)
