#!/usr/bin/env bun

import { Command, Options } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import type { PlatformError } from '@effect/platform/Error'
import type { Scope } from 'effect'
import { Cause, Console, Duration, Effect, Layer, Logger, LogLevel, Schema } from 'effect'

import { CurrentWorkingDirectory, cmd, cmdStart } from '@overeng/utils/node'

const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const formatCommandErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const runCommand = (options: {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  shell?: boolean
}): Effect.Effect<void, CommandError, CommandExecutor.CommandExecutor | CurrentWorkingDirectory> =>
  Effect.gen(function* () {
    const defaultCwd = process.env.WORKSPACE_ROOT ?? (yield* CurrentWorkingDirectory)
    const cwd = options.cwd ?? defaultCwd
    const useShell = options.shell ?? true
    const cmdOptions = {
      shell: useShell,
      ...(options.env ? { env: options.env } : {}),
    }

    return yield* cmd([options.command, ...options.args], cmdOptions).pipe(
      Effect.provideService(CurrentWorkingDirectory, cwd),
      Effect.asVoid,
      Effect.catchAll((error) =>
        Effect.fail(
          new CommandError({
            command: `${options.command} ${options.args.join(' ')}`,
            message: formatCommandErrorMessage(error),
          }),
        ),
      ),
    )
  })

const startProcess = (options: {
  command: string
  args: string[]
  cwd?: string
  env?: Record<string, string | undefined>
  shell?: boolean
}): Effect.Effect<
  CommandExecutor.Process,
  PlatformError,
  CommandExecutor.CommandExecutor | CurrentWorkingDirectory | Scope.Scope
> =>
  Effect.gen(function* () {
    const defaultCwd = process.env.WORKSPACE_ROOT ?? (yield* CurrentWorkingDirectory)
    const cwd = options.cwd ?? defaultCwd
    const useShell = options.shell ?? false
    const cmdOptions = {
      shell: useShell,
      ...(options.env ? { env: options.env } : {}),
    }

    return yield* cmdStart([options.command, ...options.args], cmdOptions).pipe(
      Effect.provideService(CurrentWorkingDirectory, cwd),
    )
  })

const ciGroup = (name: string) =>
  IS_CI ? Console.log(`::group::${name}`) : Console.log(`\n▶ ${name}`)

const ciGroupEnd = IS_CI ? Console.log('::endgroup::') : Effect.void

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

class CommandError extends Schema.TaggedError<CommandError>()('CommandError', {
  command: Schema.String,
  message: Schema.String,
}) {}

// -----------------------------------------------------------------------------
// Build Command
// -----------------------------------------------------------------------------

const buildCommand = Command.make('build', {}, () =>
  Effect.gen(function* () {
    yield* ciGroup('Building all packages')
    yield* runCommand({ command: 'tsc', args: ['--build', 'tsconfig.all.json'] })
    yield* ciGroupEnd
    yield* Console.log('✓ Build complete')
  }),
).pipe(Command.withDescription('Build all packages in the monorepo'))

// -----------------------------------------------------------------------------
// Test Command
// -----------------------------------------------------------------------------

const testUnitOption = Options.boolean('unit').pipe(
  Options.withAlias('u'),
  Options.withDescription('Run only unit tests'),
  Options.withDefault(false),
)

const testIntegrationOption = Options.boolean('integration').pipe(
  Options.withAlias('i'),
  Options.withDescription('Run only integration tests'),
  Options.withDefault(false),
)

const testWatchOption = Options.boolean('watch').pipe(
  Options.withAlias('w'),
  Options.withDescription('Run tests in watch mode'),
  Options.withDefault(false),
)

const testCommand = Command.make(
  'test',
  { unit: testUnitOption, integration: testIntegrationOption, watch: testWatchOption },
  ({ unit, integration, watch }) =>
    Effect.gen(function* () {
      const watchArg = watch && !IS_CI ? [] : ['run']
      const reporterArgs = IS_CI ? ['--reporter=verbose'] : []

      if (unit) {
        yield* ciGroup('Running unit tests')
        yield* runCommand({
          command: 'vitest',
          args: [...watchArg, "--exclude='**/integration/**'", ...reporterArgs],
        })
        yield* ciGroupEnd
      } else if (integration) {
        yield* ciGroup('Running integration tests')
        // Run notion-effect-client integration tests
        yield* runCommand({
          command: 'vitest',
          args: [
            ...watchArg,
            'packages/@overeng/notion-effect-client/src/test/integration',
            ...reporterArgs,
          ],
        })
        // Run utils integration tests (browser tests with Playwright)
        yield* runCommand({
          command: 'playwright',
          args: ['test', '--config', 'packages/@overeng/utils/playwright.config.ts'],
        })
        yield* ciGroupEnd
      } else {
        yield* ciGroup('Running all tests')
        yield* runCommand({ command: 'vitest', args: [...watchArg, ...reporterArgs] })
        yield* ciGroupEnd
      }

      yield* Console.log('✓ Tests complete')
    }),
).pipe(Command.withDescription('Run tests across all packages'))

// -----------------------------------------------------------------------------
// Lint Command
// -----------------------------------------------------------------------------

const OXC_CONFIG_PATH = 'packages/@overeng/oxc-config'

const lintFixOption = Options.boolean('fix').pipe(
  Options.withAlias('f'),
  Options.withDescription('Auto-fix formatting and lint issues'),
  Options.withDefault(false),
)

const lintCommand = Command.make('lint', { fix: lintFixOption }, ({ fix }) =>
  Effect.gen(function* () {
    yield* ciGroup(fix ? 'Formatting with oxfmt' : 'Formatting check with oxfmt')
    const oxfmtArgs = ['-c', `${OXC_CONFIG_PATH}/fmt.jsonc`, ...(fix ? ['.'] : ['--check', '.'])]
    yield* runCommand({ command: 'oxfmt', args: oxfmtArgs })
    yield* ciGroupEnd

    yield* ciGroup('Linting with oxlint')
    const oxlintArgs = [
      '-c',
      `${OXC_CONFIG_PATH}/lint.jsonc`,
      '--import-plugin',
      ...(fix ? ['--fix'] : []),
    ]
    yield* runCommand({ command: 'oxlint', args: oxlintArgs })
    yield* ciGroupEnd
    yield* Console.log('✓ Lint complete')
  }),
).pipe(Command.withDescription('Check formatting and run oxlint across the codebase'))

// -----------------------------------------------------------------------------
// TypeScript Command
// -----------------------------------------------------------------------------

const tsWatchOption = Options.boolean('watch').pipe(
  Options.withAlias('w'),
  Options.withDescription('Run in watch mode'),
  Options.withDefault(false),
)

const tsCleanOption = Options.boolean('clean').pipe(
  Options.withAlias('c'),
  Options.withDescription('Clean build artifacts before compilation'),
  Options.withDefault(false),
)

const tsCommand = Command.make(
  'ts',
  { watch: tsWatchOption, clean: tsCleanOption },
  ({ watch, clean }) =>
    Effect.gen(function* () {
      if (clean) {
        yield* Console.log('Cleaning build artifacts...')
        yield* runCommand({
          command: 'find',
          args: [
            'packages',
            '-path',
            '*node_modules*',
            '-prune',
            '-o',
            '\\(',
            '-name',
            'dist',
            '-type',
            'd',
            '-o',
            '-name',
            '*.tsbuildinfo',
            '\\)',
            '-exec',
            'rm',
            '-rf',
            '{}',
            '+',
          ],
        })
      }

      yield* ciGroup('Type checking')
      const args = watch
        ? ['--build', 'tsconfig.all.json', '--watch']
        : ['--build', 'tsconfig.all.json']
      yield* runCommand({ command: 'tsc', args })
      yield* ciGroupEnd
      yield* Console.log('✓ Type check complete')
    }),
).pipe(Command.withDescription('Run TypeScript type checking'))

// -----------------------------------------------------------------------------
// Clean Command
// -----------------------------------------------------------------------------

const cleanCommand = Command.make('clean', {}, () =>
  Effect.gen(function* () {
    yield* ciGroup('Cleaning build artifacts')

    yield* Console.log('Removing dist directories...')
    yield* runCommand({
      command: 'find',
      args: ['.', '-type', 'd', '-name', 'dist', '-prune', '-exec', 'rm', '-rf', '{}', '+'],
    })

    yield* Console.log('Removing .tsbuildinfo files...')
    yield* runCommand({ command: 'find', args: ['.', '-name', '*.tsbuildinfo', '-delete'] })

    yield* Console.log('Removing storybook-static directories...')
    yield* runCommand({
      command: 'find',
      args: [
        '.',
        '-type',
        'd',
        '-name',
        'storybook-static',
        '-prune',
        '-exec',
        'rm',
        '-rf',
        '{}',
        '+',
      ],
    })

    yield* ciGroupEnd
    yield* Console.log('✓ Clean complete')
  }),
).pipe(Command.withDescription('Remove build artifacts (dist, .tsbuildinfo, etc.)'))

// -----------------------------------------------------------------------------
// Check Command
// -----------------------------------------------------------------------------

const checkCommand = Command.make('check', {}, () =>
  Effect.gen(function* () {
    yield* Console.log('Running all checks...\n')

    yield* ciGroup('Type checking')
    yield* runCommand({ command: 'tsc', args: ['--build', 'tsconfig.all.json'] })
    yield* ciGroupEnd

    yield* ciGroup('Format + Lint')
    yield* runCommand({
      command: 'oxfmt',
      args: ['-c', `${OXC_CONFIG_PATH}/fmt.jsonc`, '--check', '.'],
    })
    yield* runCommand({
      command: 'oxlint',
      args: ['-c', `${OXC_CONFIG_PATH}/lint.jsonc`, '--import-plugin'],
    })
    yield* ciGroupEnd

    yield* ciGroup('Running tests')
    yield* runCommand({ command: 'vitest', args: ['run'] })
    yield* ciGroupEnd

    yield* Console.log('\n✓ All checks passed')
  }),
).pipe(Command.withDescription('Run all checks (typecheck + format + lint + test)'))

// -----------------------------------------------------------------------------
// Context Command
// -----------------------------------------------------------------------------

const contextExamplesCommand = Command.make('examples', {}, () =>
  Effect.gen(function* () {
    const workspaceRoot = process.env.WORKSPACE_ROOT ?? (yield* CurrentWorkingDirectory)
    const socketCwd = `${workspaceRoot}/context/effect/socket`

    const runWithServer = <TResult, TError, TContext>(options: {
      label: string
      serverArgs: string[]
      clientEffect: Effect.Effect<TResult, TError, TContext>
    }) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* ciGroup(options.label)

          yield* Effect.acquireRelease(
            startProcess({ command: 'bun', args: options.serverArgs, cwd: socketCwd }),
            (process) => process.kill('SIGTERM').pipe(Effect.catchAll(() => Effect.void)),
          )

          yield* Effect.sleep(Duration.seconds(1))
          return yield* options.clientEffect
        }).pipe(Effect.ensuring(ciGroupEnd)),
      )

    const httpWsClientScript = [
      'const ws = new WebSocket("ws://127.0.0.1:8790")',
      'const timeout = setTimeout(() => { console.error("timeout waiting for message"); ws.close(); process.exit(1) }, 2000)',
      'ws.onopen = () => ws.send("hello")',
      'ws.onmessage = (event) => { console.log("recv", event.data); clearTimeout(timeout); ws.close() }',
      'ws.onclose = () => process.exit(0)',
      'ws.onerror = (error) => { console.error(error); clearTimeout(timeout); process.exit(1) }',
    ].join('; ')

    yield* runWithServer({
      label: 'WS echo',
      serverArgs: ['examples/ws-echo-server.ts'],
      clientEffect: runCommand({
        command: 'bun',
        args: ['examples/ws-echo-client.ts'],
        cwd: socketCwd,
      }),
    })

    yield* runWithServer({
      label: 'WS broadcast',
      serverArgs: ['examples/ws-broadcast-server.ts'],
      clientEffect: runCommand({
        command: 'bun',
        args: ['examples/ws-broadcast-client.ts'],
        cwd: socketCwd,
      }),
    })

    yield* runWithServer({
      label: 'WS JSON',
      serverArgs: ['examples/ws-json-server.ts'],
      clientEffect: runCommand({
        command: 'bun',
        args: ['examples/ws-json-client.ts'],
        cwd: socketCwd,
      }),
    })

    yield* runWithServer({
      label: 'HTTP + WS combined',
      serverArgs: ['examples/http-ws-combined.ts'],
      clientEffect: Effect.gen(function* () {
        yield* runCommand({
          command: 'curl',
          args: ['-s', 'http://127.0.0.1:8788/'],
          cwd: workspaceRoot,
        })
        yield* runCommand({
          command: 'bun',
          args: ['-e', httpWsClientScript],
          cwd: workspaceRoot,
          shell: false,
        })
      }),
    })

    yield* runWithServer({
      label: 'RPC over WebSocket',
      serverArgs: ['examples/rpc-ws-server.ts'],
      clientEffect: runCommand({
        command: 'bun',
        args: ['examples/rpc-ws-client.ts'],
        cwd: socketCwd,
      }),
    })

    yield* runWithServer({
      label: 'TCP echo',
      serverArgs: ['examples/tcp-echo-server.ts'],
      clientEffect: runCommand({
        command: 'bun',
        args: ['examples/tcp-echo-client.ts'],
        cwd: socketCwd,
      }),
    })

    yield* Console.log('✓ Context examples complete')
  }),
).pipe(Command.withDescription('Run all context socket example scripts'))

const contextCommand = Command.make('context').pipe(
  Command.withSubcommands([contextExamplesCommand]),
  Command.withDescription('Run commands for context reference material'),
)

// -----------------------------------------------------------------------------
// Main CLI
// -----------------------------------------------------------------------------

const command = Command.make('mono').pipe(
  Command.withSubcommands([
    buildCommand,
    testCommand,
    lintCommand,
    tsCommand,
    cleanCommand,
    checkCommand,
    contextCommand,
  ]),
  Command.withDescription('Monorepo management CLI'),
)

const cli = Command.run(command, {
  name: 'mono',
  version: '0.1.0',
})

cli(process.argv).pipe(
  Effect.tapErrorCause((cause) => {
    if (Cause.isInterruptedOnly(cause)) {
      return Effect.void
    }
    return Effect.logError(cause)
  }),
  Effect.provide(
    Layer.mergeAll(
      NodeContext.layer,
      CurrentWorkingDirectory.live,
      Logger.minimumLogLevel(LogLevel.Debug),
    ),
  ),
  NodeRuntime.runMain({ disableErrorReporting: true }),
)
