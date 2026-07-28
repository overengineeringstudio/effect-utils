#!/usr/bin/env bun

import { Command } from 'effect/unstable/cli'
import { NodeServices, NodeRuntime } from '@effect/platform-node'
import { Cause, Effect, type Exit, Layer, Option, Schema } from 'effect'

import { editorExitCode } from '@overeng/notion-md'
import { ServiceIdentity } from '@overeng/otel-contract'
import { CurrentWorkingDirectory } from '@overeng/utils/node'
import { rewriteHelpSubcommand } from '@overeng/utils/node/cli-help-rewrite'
import { CliVersion, resolveCliVersion } from '@overeng/utils/node/cli-version'
import { otelEndpointFromConfig, withTelemetry } from '@overeng/utils/node/otel'

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

const identity = Schema.decodeSync(ServiceIdentity)({
  name: 'notion-cli',
  namespace: 'overeng',
  version,
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

/**
 * Map the program `Exit` to the editor-surface exit-code contract
 * (notion-md `exit-codes.ts`), mirroring the standalone `notion-md` binary.
 *
 * Without this the umbrella `notion edit` alias would collapse every tagged
 * editor failure (e.g. 3 lossy / 6 schema-drift / 8 abort) to the framework's
 * default exit 1, so `notion edit` and `notion-md edit` would disagree for
 * scripts. Safe for non-editor commands (schema/db/md): `editorExitCode` falls
 * back to 1 for any unmapped failure and 0 on success, matching the previous
 * default teardown (Ctrl+C now maps to 130, consistent with `notion-md`).
 */
// oxlint-disable-next-line overeng/named-args -- implements Effect's `Teardown` interface (fixed `(exit, onExit)` signature) passed to `NodeRuntime.runMain`
const editorTeardown = <E, A>(exit: Exit.Exit<E, A>, onExit: (code: number) => void): void => {
  onExit(editorExitCode(exit))
}

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

  Effect.gen(function* () {
    const endpoint = yield* otelEndpointFromConfig()

    yield* cli(argv).pipe(
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
          NodeServices.layer,
          CurrentWorkingDirectory.live,
          withTelemetry({ identity, shape: 'cli', endpoint }),
        ),
      ),
    )
  }).pipe(NodeRuntime.runMain({ disableErrorReporting: true, teardown: editorTeardown }))
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
