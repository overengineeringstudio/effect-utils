#!/usr/bin/env bun

import { Command } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Cause, Effect, Layer, Option } from 'effect'

import type { runCliMain as runSqliteCliMain } from '@overeng/notion-datasource-sync/cli'
import { CurrentWorkingDirectory } from '@overeng/utils/node'
import { rewriteHelpSubcommand } from '@overeng/utils/node/cli-help-rewrite'

export { runNotionCliMain }

// -----------------------------------------------------------------------------
// Main CLI
// -----------------------------------------------------------------------------

type DispatchAlias = 'md' | 'sqlite'
type SqliteCliModule = {
  readonly runCliMain: typeof runSqliteCliMain
  readonly renderCliErrorJson: (error: unknown) => string
}

const resolveDispatchSpec = (
  args: ReadonlyArray<string>,
): { alias: DispatchAlias; passthroughArgs: ReadonlyArray<string> } | undefined => {
  const [, , ...rawArgs] = args
  const [alias, ...passthroughArgs] = rawArgs
  if (alias !== 'md' && alias !== 'sqlite') {
    return undefined
  }

  return { alias, passthroughArgs }
}

const runDelegated = async ({
  alias,
  passthroughArgs,
}: {
  readonly alias: DispatchAlias
  readonly passthroughArgs: ReadonlyArray<string>
}) => {
  if (alias === 'md') {
    try {
      const { runCliMain } = await import('@overeng/notion-md/cli')
      runCliMain({ args: passthroughArgs }).pipe(
        NodeRuntime.runMain({ disableErrorReporting: true }),
      )
    } catch (error) {
      process.stderr.write(`notion md dispatch failed: ${String(error)}\n`)
      process.exitCode = 1
    }
    return
  }

  // Keep this as a composed specifier so Bun's static analyzer does not eagerly
  // bundle the full sqlite CLI dependency when producing the compiled artifact.
  const sqliteCliEntry = `@overeng/${'notion-datasource-sync'}/cli`
  let sqliteCli: SqliteCliModule
  try {
    // oxlint-disable-next-line eslint-plugin-import(no-dynamic-require) -- composed specifier intentionally keeps Bun from eagerly bundling sqlite.
    sqliteCli = await import(sqliteCliEntry)
  } catch {
    process.stderr.write(
      'notion sqlite dispatch is unavailable in this build. Use a Node-based runtime to run notion sqlite.\n',
    )
    process.exitCode = 1
    return
  }

  sqliteCli.runCliMain({ argv: passthroughArgs }).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => {
        process.stderr.write(sqliteCli.renderCliErrorJson(error))
      }),
    ),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  )
}

const runRootCli = async (argv: ReadonlyArray<string>) => {
  const [{ dbCommand }, { schemaCommand }] = await Promise.all([
    import('./commands/db/mod.ts'),
    import('./commands/schema/mod.ts'),
  ])
  const command = Command.make('notion').pipe(
    Command.withSubcommands([schemaCommand, dbCommand]),
    Command.withDescription(
      'Notion CLI - database operations, schema generation, and Notion ecosystem dispatch',
    ),
  )
  const cli = Command.run(command, {
    name: 'notion',
    version: '0.1.0',
  })

  cli(argv).pipe(
    Effect.tapErrorCause((cause) => {
      if (Cause.isInterruptedOnly(cause) === true) {
        return Effect.void
      }

      return Option.match(Cause.failureOption(cause), {
        onNone: () => Effect.logError(cause),
        onSome: (error) => {
          const unknownError: unknown = error
          return hasTag(unknownError) === true && unknownError._tag === 'SchemaDriftDetectedError'
            ? Effect.void
            : Effect.logError(cause)
        },
      })
    }),
    Effect.provide(Layer.mergeAll(NodeContext.layer, CurrentWorkingDirectory.live)),
    NodeRuntime.runMain({ disableErrorReporting: true }),
  )
}

const hasTag = (u: unknown): u is { readonly _tag: string } =>
  typeof u === 'object' &&
  u !== null &&
  '_tag' in u &&
  typeof (u as { readonly _tag?: unknown })._tag === 'string'

const runNotionCliMain = async ({
  argv = process.argv,
}: {
  readonly argv?: ReadonlyArray<string>
} = {}) => {
  const rewrittenArgv = rewriteHelpSubcommand(argv)
  const delegated = resolveDispatchSpec(rewrittenArgv)

  if (delegated !== undefined) {
    await runDelegated(delegated)
  } else {
    await runRootCli(rewrittenArgv)
  }
}

if (import.meta.main) {
  void runNotionCliMain()
}
