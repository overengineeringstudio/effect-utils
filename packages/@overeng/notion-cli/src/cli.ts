#!/usr/bin/env bun

import { Command } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Cause, Effect, Layer, Option } from 'effect'

import { CurrentWorkingDirectory } from '@overeng/utils/node'
import { rewriteHelpSubcommand } from '@overeng/utils/node/cli-help-rewrite'
import { CliVersion, resolveCliVersion } from '@overeng/utils/node/cli-version'
import { makeOtelCliLayer } from '@overeng/utils/node/otel'

export { runNotionCliMain }

// -----------------------------------------------------------------------------
// Main CLI
// -----------------------------------------------------------------------------

const buildStamp = '__CLI_BUILD_STAMP__'
const version = resolveCliVersion({
  baseVersion: '0.1.0',
  buildStamp,
})

const isRootVersionArgv = (argv: ReadonlyArray<string>): boolean => {
  const [, , ...rawArgs] = argv
  return rawArgs.length === 1 && rawArgs[0] === '--version'
}

const isSqliteArgv = (args: ReadonlyArray<string>): boolean => {
  const [, , ...rawArgs] = args
  return rawArgs[0] === 'sqlite'
}

const writeSqliteRuntimeUnavailable = () => {
  process.stderr.write(
    'notion sqlite requires the packaged Nix/devenv Node-backed runtime because the SQLite sync implementation imports node:sqlite. Use `devenv shell` or the flake-built `notion` binary.\n',
  )
  process.exitCode = 1
}

const runRootCli = async (argv: ReadonlyArray<string>) => {
  const [{ notionMdDispatchCommand }, { dbCommand }, { schemaCommand }] = await Promise.all([
    import('@overeng/notion-md/cli-program'),
    import('./commands/db/mod.ts'),
    import('./commands/schema/mod.ts'),
  ])
  const command = Command.make('notion').pipe(
    Command.withSubcommands([schemaCommand, dbCommand, notionMdDispatchCommand]),
    Command.withDescription(
      'Notion CLI - database operations, schema generation, and markdown sync',
    ),
  )
  const cli = Command.run(command, {
    name: 'notion',
    version,
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
    CliVersion.enrichErrors,
    Effect.provideService(CliVersion, { name: 'notion', version }),
    Effect.provide(
      Layer.mergeAll(
        NodeContext.layer,
        CurrentWorkingDirectory.live,
        makeOtelCliLayer({ serviceName: 'notion-cli' }),
      ),
    ),
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
  if (isRootVersionArgv(argv) === true) {
    process.stdout.write(`${version}\n`)
    return
  }

  const rewrittenArgv = rewriteHelpSubcommand(argv)

  if (isSqliteArgv(rewrittenArgv) === true) {
    writeSqliteRuntimeUnavailable()
    return
  }

  await runRootCli(rewrittenArgv)
}

if (import.meta.main) {
  void runNotionCliMain()
}
