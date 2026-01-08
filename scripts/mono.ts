#!/usr/bin/env bun

import { Command, Options } from '@effect/cli'
import { FileSystem, Path } from '@effect/platform'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import type { PlatformError } from '@effect/platform/Error'
import type { Scope } from 'effect'
import { Cause, Console, Duration, Effect, Layer, Logger, LogLevel, Schema, Stream } from 'effect'

import { genieCommand } from '@overeng/genie/cli'
import {
  CurrentWorkingDirectory,
  cmd,
  cmdStart,
  printFinalSummary,
  TaskRunner,
} from '@overeng/utils/node'

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

class GenieCoverageError extends Schema.TaggedError<GenieCoverageError>()('GenieCoverageError', {
  missingGenieSources: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `Config files missing genie sources:\n${this.missingGenieSources.map((f) => `  - ${f}`).join('\n')}\n\nCreate corresponding .genie.ts files for these config files.`
  }
}

// -----------------------------------------------------------------------------
// Genie Coverage Check
// -----------------------------------------------------------------------------

/** Directories to scan for config files that should have genie sources */
const GENIE_SCAN_DIRS = ['packages', 'scripts', 'context']

/** Config file patterns that should have genie sources */
const GENIE_CONFIG_PATTERNS = new Set(['package.json', 'tsconfig.json'])

/** Directories to skip when scanning for config files */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.direnv', '.devenv', 'tmp'])

/** Find config files that are missing corresponding .genie.ts sources */
const findMissingGenieSources = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const cwd = process.env.WORKSPACE_ROOT ?? process.cwd()

  const walk = (dir: string): Effect.Effect<string[], PlatformError, never> =>
    Effect.gen(function* () {
      const exists = yield* fs.exists(dir)
      if (!exists) return []

      const entries = yield* fs.readDirectory(dir)
      const results: string[] = []

      for (const entry of entries) {
        if (SKIP_DIRS.has(entry)) continue

        const fullPath = pathService.join(dir, entry)
        const stat = yield* fs.stat(fullPath)

        if (stat.type === 'Directory') {
          const nested = yield* walk(fullPath)
          results.push(...nested)
        } else if (GENIE_CONFIG_PATTERNS.has(entry)) {
          const genieSourcePath = `${fullPath}.genie.ts`
          const hasGenieSource = yield* fs.exists(genieSourcePath)
          if (!hasGenieSource) {
            results.push(pathService.relative(cwd, fullPath))
          }
        }
      }

      return results
    })

  const allMissing: string[] = []
  for (const scanDir of GENIE_SCAN_DIRS) {
    const missing = yield* walk(pathService.join(cwd, scanDir))
    allMissing.push(...missing)
  }

  return allMissing.toSorted()
}).pipe(Effect.withSpan('findMissingGenieSources'))

/** Check that all config files have genie sources, fail if any are missing */
const checkGenieCoverage = Effect.gen(function* () {
  const missing = yield* findMissingGenieSources
  if (missing.length > 0) {
    return yield* new GenieCoverageError({ missingGenieSources: missing })
  }
}).pipe(Effect.withSpan('checkGenieCoverage'))

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
// Atomic Task Effects
// -----------------------------------------------------------------------------

const OXC_CONFIG_PATH = 'packages/@overeng/oxc-config'

/** Format check effect (oxfmt --check) */
const formatCheck = runCommand({
  command: 'oxfmt',
  args: ['-c', `${OXC_CONFIG_PATH}/fmt.jsonc`, '--check', '.'],
}).pipe(Effect.withSpan('formatCheck'))

/** Format fix effect (oxfmt) */
const formatFix = runCommand({
  command: 'oxfmt',
  args: ['-c', `${OXC_CONFIG_PATH}/fmt.jsonc`, '.'],
}).pipe(Effect.withSpan('formatFix'))

/** Lint check effect (oxlint) */
const lintCheck = runCommand({
  command: 'oxlint',
  args: ['-c', `${OXC_CONFIG_PATH}/lint.jsonc`, '--import-plugin', '--deny-warnings'],
}).pipe(Effect.withSpan('lintCheck'))

/** Lint fix effect (oxlint --fix) */
const lintFix = runCommand({
  command: 'oxlint',
  args: ['-c', `${OXC_CONFIG_PATH}/lint.jsonc`, '--import-plugin', '--deny-warnings', '--fix'],
}).pipe(Effect.withSpan('lintFix'))

/** Type check effect */
const typeCheck = runCommand({
  command: 'tsc',
  args: ['--build', 'tsconfig.all.json'],
}).pipe(Effect.withSpan('typeCheck'))

/** Genie check effect (verifies generated files are up to date) */
const genieCheck = runCommand({
  command: 'mono',
  args: ['genie', '--check'],
}).pipe(Effect.withSpan('genieCheck'))

/** Test effect */
const testRun = runCommand({
  command: 'vitest',
  args: ['run'],
}).pipe(Effect.withSpan('testRun'))

/** Combined lint check: format + lint + genie coverage */
const allLintChecks = Effect.all([formatCheck, lintCheck, checkGenieCoverage], {
  concurrency: 'unbounded',
}).pipe(Effect.withSpan('allLintChecks'))

/** Combined lint fix: format + lint */
const allLintFixes = Effect.all([formatFix, lintFix], {
  concurrency: 'unbounded',
}).pipe(Effect.withSpan('allLintFixes'))

// -----------------------------------------------------------------------------
// Lint Command
// -----------------------------------------------------------------------------

const lintFixOption = Options.boolean('fix').pipe(
  Options.withAlias('f'),
  Options.withDescription('Auto-fix formatting and lint issues'),
  Options.withDefault(false),
)

const lintCommand = Command.make('lint', { fix: lintFixOption }, ({ fix }) =>
  Effect.gen(function* () {
    yield* ciGroup(fix ? 'Formatting + Linting (with fixes)' : 'Formatting + Linting')
    yield* fix ? allLintFixes : allLintChecks
    yield* ciGroupEnd
    yield* Console.log('✓ Lint complete')
  }),
).pipe(Command.withDescription('Check formatting, run oxlint, and verify genie coverage'))

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

/**
 * Check command with structured task execution.
 * In CI mode, uses sequential execution with groups. In interactive mode, uses TaskRunner for clean output.
 */
const checkCommand = Command.make('check', {}, () =>
  Effect.gen(function* () {
    if (IS_CI) {
      yield* checkCommandCI
    } else {
      yield* checkCommandInteractive
    }
  }),
).pipe(Command.withDescription('Run all checks (genie + typecheck + format + lint + test)'))

/** CI mode: sequential with groups (GitHub Actions compatible) */
const checkCommandCI = Effect.gen(function* () {
  yield* Console.log('Running all checks...\n')

  yield* ciGroup('Genie check')
  yield* genieCheck
  yield* ciGroupEnd

  yield* ciGroup('Type checking')
  yield* typeCheck
  yield* ciGroupEnd

  yield* ciGroup('Format + Lint + Genie coverage')
  yield* allLintChecks
  yield* ciGroupEnd

  yield* ciGroup('Running tests')
  yield* testRun
  yield* ciGroupEnd

  yield* Console.log('\n✓ All checks passed')
})

/** Interactive mode: concurrent with structured output via TaskRunner */
const checkCommandInteractive = Effect.gen(function* () {
  const runner = yield* TaskRunner

  /** Register all tasks upfront */
  yield* runner.register({ id: 'genie', name: 'Genie check' })
  yield* runner.register({ id: 'tsc', name: 'Type checking' })
  yield* runner.register({ id: 'lint', name: 'Lint (format + oxlint + genie coverage)' })
  yield* runner.register({ id: 'test', name: 'Tests' })

  /** Start render loop in background */
  yield* runner.changes.pipe(
    Stream.debounce('50 millis'),
    Stream.runForEach(() =>
      Effect.gen(function* () {
        const output = yield* runner.render()
        process.stdout.write('\x1B[2J\x1B[H')
        process.stdout.write(output + '\n')
      }),
    ),
    Effect.fork,
  )

  /** Run genie, tsc, and lint in parallel */
  yield* runner.runAll([
    runner.runTask({ id: 'genie', command: 'mono', args: ['genie', '--check'] }),
    runner.runTask({ id: 'tsc', command: 'tsc', args: ['--build', 'tsconfig.all.json'] }),
    runner.runTask({ id: 'lint', command: 'mono', args: ['lint'] }),
  ])

  /** Run tests after other checks pass */
  yield* runner.runTask({ id: 'test', command: 'vitest', args: ['run'] })

  yield* printFinalSummary
}).pipe(Effect.provide(TaskRunner.live))

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
    genieCommand,
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
