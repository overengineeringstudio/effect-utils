#!/usr/bin/env bun

import { spawn } from 'node:child_process'
import { Command, Options } from '@effect/cli'
import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Cause, Console, Effect, Schema } from 'effect'

const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? process.cwd()
const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true'

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const runCommand = (cmd: string, args: string[], options?: { cwd?: string }) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const proc = spawn(cmd, args, {
          cwd: options?.cwd ?? WORKSPACE_ROOT,
          stdio: 'inherit',
          shell: true,
        })
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`Command "${cmd} ${args.join(' ')}" exited with code ${code}`))
        })
        proc.on('error', reject)
      }),
    catch: (error) =>
      new CommandError({
        command: `${cmd} ${args.join(' ')}`,
        message: error instanceof Error ? error.message : String(error),
      }),
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
    yield* runCommand('pnpm', ['-r', 'build'])
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
      const ciArgs = IS_CI ? ['--', '--reporter=verbose'] : []
      const scriptName = watch && !IS_CI ? 'test:watch' : 'test'

      if (unit) {
        yield* ciGroup('Running unit tests')
        yield* runCommand('pnpm', ['-r', scriptName, ...ciArgs])
        yield* ciGroupEnd
      } else if (integration) {
        yield* ciGroup('Running integration tests')
        yield* runCommand('pnpm', [
          '-r',
          '--filter',
          '@overeng/notion-effect-client',
          'test:integration',
          ...ciArgs,
        ])
        yield* ciGroupEnd
      } else {
        yield* ciGroup('Running all tests')
        yield* runCommand('pnpm', ['-r', scriptName, ...ciArgs])
        yield* ciGroupEnd
      }

      yield* Console.log('✓ Tests complete')
    }),
).pipe(Command.withDescription('Run tests across all packages'))

// -----------------------------------------------------------------------------
// Lint Command
// -----------------------------------------------------------------------------

const lintFixOption = Options.boolean('fix').pipe(
  Options.withAlias('f'),
  Options.withDescription('Auto-fix linting issues'),
  Options.withDefault(false),
)

const lintCommand = Command.make('lint', { fix: lintFixOption }, ({ fix }) =>
  Effect.gen(function* () {
    yield* ciGroup('Linting codebase')
    const args = fix ? ['check', '--write', '.'] : ['check', '.']
    yield* runCommand('biome', args)
    yield* ciGroupEnd
    yield* Console.log('✓ Lint complete')
  }),
).pipe(Command.withDescription('Run Biome linter across the codebase'))

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
        yield* runCommand('find', [
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
        ])
      }

      yield* ciGroup('Type checking')
      const args = watch
        ? ['--build', 'tsconfig.all.json', '--watch']
        : ['--build', 'tsconfig.all.json']
      yield* runCommand('tsc', args)
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
    yield* runCommand('find', [
      '.',
      '-type',
      'd',
      '-name',
      'dist',
      '-prune',
      '-exec',
      'rm',
      '-rf',
      '{}',
      '+',
    ])

    yield* Console.log('Removing .tsbuildinfo files...')
    yield* runCommand('find', ['.', '-name', '*.tsbuildinfo', '-delete'])

    yield* Console.log('Removing storybook-static directories...')
    yield* runCommand('find', [
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
    ])

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
    yield* runCommand('tsc', ['--build', 'tsconfig.all.json'])
    yield* ciGroupEnd

    yield* ciGroup('Linting')
    yield* runCommand('biome', ['check', '.'])
    yield* ciGroupEnd

    yield* ciGroup('Running tests')
    yield* runCommand('pnpm', ['-r', 'test', '--', 'run'])
    yield* ciGroupEnd

    yield* Console.log('\n✓ All checks passed')
  }),
).pipe(Command.withDescription('Run all checks (typecheck + lint + test)'))

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
  ]),
  Command.withDescription('Monorepo management CLI for kabul'),
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
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain({ disableErrorReporting: true }),
)
