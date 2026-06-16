#!/usr/bin/env bun

import { Command } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Cause, Effect, Layer, Option } from 'effect'

import { CurrentWorkingDirectory } from '@overeng/utils/node'
import { rewriteHelpSubcommand } from '@overeng/utils/node/cli-help-rewrite'
import { CliVersion, resolveCliVersion } from '@overeng/utils/node/cli-version'
import { makeOtelCliLayer } from '@overeng/utils/node/otel'

export { runNotionCliMain }
export { makeNotionRootCommand }

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

/** Composes the root Notion Effect CLI command from package-owned command trees. */
const makeNotionRootCommand = <
  SchemaName extends string,
  SchemaRequirements,
  SchemaError,
  SchemaConfig,
  DbName extends string,
  DbRequirements,
  DbError,
  DbConfig,
  MdName extends string,
  MdRequirements,
  MdError,
  MdConfig,
  EditName extends string,
  EditRequirements,
  EditError,
  EditConfig,
>({
  schemaCommand,
  dbCommand,
  notionMdDispatchCommand,
  notionEditAliasCommand,
}: {
  readonly schemaCommand: Command.Command<SchemaName, SchemaRequirements, SchemaError, SchemaConfig>
  readonly dbCommand: Command.Command<DbName, DbRequirements, DbError, DbConfig>
  readonly notionMdDispatchCommand: Command.Command<MdName, MdRequirements, MdError, MdConfig>
  readonly notionEditAliasCommand: Command.Command<
    EditName,
    EditRequirements,
    EditError,
    EditConfig
  >
}) =>
  Command.make('notion').pipe(
    // `edit` is the top-level marquee alias for `md edit` (R18); it is the only
    // first-level command outside the md/schema/db namespaces.
    Command.withSubcommands([
      notionEditAliasCommand,
      schemaCommand,
      dbCommand,
      notionMdDispatchCommand,
    ]),
    Command.withDescription(
      'Notion CLI - database operations, schema generation, and markdown sync',
    ),
  )

const runRootCli = async (argv: ReadonlyArray<string>) => {
  /*
   * These trees are imported CONCURRENTLY. That concurrency is what triggers the
   * upstream Bun bug oven-sh/bun#30634 (TDZ on a re-exported `const` read during
   * parallel dynamic `import()`, Node-fine) — which is why every renderer's TUI
   * app is built lazily via `get*App()` instead of at module top level (#787).
   * TODO(bun#30634): once the Bun fix (PR oven-sh/bun#30656) ships and we pin a
   * Bun version that includes it, the lazy `get*App()` workaround can be reverted
   * to plain top-level `const *App = createTuiApp(...)`. See
   * `concurrent-import.unit.test.ts` (the regression guard).
   */
  const [{ notionMdDispatchCommand, notionEditAliasCommand }, { dbCommand }, { schemaCommand }] =
    await Promise.all([
      import('@overeng/notion-md/cli-program'),
      import('./commands/db/mod.ts'),
      import('./commands/schema/mod.ts'),
    ])
  const command = makeNotionRootCommand({
    schemaCommand,
    dbCommand,
    notionMdDispatchCommand,
    notionEditAliasCommand,
  })
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
  await runRootCli(rewrittenArgv)
}

if (import.meta.main) {
  void runNotionCliMain()
}
