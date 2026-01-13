import os from 'node:os'
import path from 'node:path'

import { Command, Options } from '@effect/cli'
import { Command as PlatformCommand, FileSystem } from '@effect/platform'
import type { CommandExecutor } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import { Chunk, Console, Effect, Logger, LogLevel, Option, Schema, Stream } from 'effect'

import type { CommandError } from '@overeng/mono'
import { runCommand } from '@overeng/mono'
import { CmdError, cmdText, CurrentWorkingDirectory } from '@overeng/utils/node'

/** Error when hash extraction fails during nix build */
class HashExtractionError extends Schema.TaggedError<HashExtractionError>()('HashExtractionError', {
  packageName: Schema.String,
  message: Schema.String,
}) {}

/** Error when hash pattern is not found in build.nix */
class HashPatternNotFoundError extends Schema.TaggedError<HashPatternNotFoundError>()(
  'HashPatternNotFoundError',
  {
    buildNixPath: Schema.String,
    message: Schema.String,
  },
) {}

type NixPackageSpec = {
  path: string
  flakeRef: string
  flakeDir?: string
  noWriteLock?: boolean
  workspaceInput?: string
  binaryName?: string
}

class UnsupportedSystemError extends Schema.TaggedError<UnsupportedSystemError>()('UnsupportedSystemError', {
  platform: Schema.String,
  arch: Schema.String,
  message: Schema.String,
}) {}

class NixStatusParseError extends Schema.TaggedError<NixStatusParseError>()('NixStatusParseError', {
  message: Schema.String,
  cause: Schema.Defect,
}) {}

/** Known Nix packages in this monorepo */
const NIX_PACKAGES = {
  genie: { path: 'packages/@overeng/genie', flakeRef: '.#genie', flakeDir: '.' },
  dotdot: { path: 'packages/@overeng/dotdot', flakeRef: '.#dotdot', flakeDir: '.' },
  mono: {
    path: 'scripts',
    flakeRef: '.#mono',
    flakeDir: '.',
    noWriteLock: true,
    binaryName: 'mono',
  },
} as const satisfies Record<string, NixPackageSpec>

type NixPackageName = keyof typeof NIX_PACKAGES

const allPackageNames = Object.keys(NIX_PACKAGES) as NixPackageName[]

const getPackageSpec = (name: NixPackageName): NixPackageSpec => NIX_PACKAGES[name]

const getBinaryName = (name: NixPackageName): string => getPackageSpec(name).binaryName ?? name

const resolveWorkspacePath = (relativePath: string): string => {
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd()
  return path.resolve(workspaceRoot, relativePath)
}

const resolveFlakeDir = (packageSpec: NixPackageSpec): string =>
  resolveWorkspacePath(packageSpec.flakeDir ?? packageSpec.path)

/**
 * Determinate Nix supports eval-cores for parallel evaluation:
 * https://manual.determinate.systems/command-ref/conf-file.html#conf-eval-cores
 */
const resolveEvalCores = (): number => {
  const parallelism =
    typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length
  return Math.max(1, parallelism)
}

const evalCoresArgs = (): string[] => ['--option', 'eval-cores', String(resolveEvalCores())]
/** Use max-jobs to parallelize builds; keep it aligned with eval-cores for simplicity. */
const buildParallelismArgs = (): string[] => ['--option', 'max-jobs', String(resolveEvalCores())]

const resolveNixSystem = (): Effect.Effect<string, UnsupportedSystemError> => {
  const platform = process.platform
  const arch = process.arch

  if (platform === 'darwin' && arch === 'arm64') return Effect.succeed('aarch64-darwin')
  if (platform === 'darwin' && arch === 'x64') return Effect.succeed('x86_64-darwin')
  if (platform === 'linux' && arch === 'arm64') return Effect.succeed('aarch64-linux')
  if (platform === 'linux' && arch === 'x64') return Effect.succeed('x86_64-linux')

  return Effect.fail(
    new UnsupportedSystemError({
      platform,
      arch,
      message: `Unsupported system for nix status: ${platform}/${arch}`,
    }),
  )
}

const getWorkspaceOverrideArgs = (packageSpec: NixPackageSpec): string[] => {
  if (packageSpec.workspaceInput === undefined) {
    return []
  }

  const workspaceRoot = process.env.WORKSPACE_ROOT
  if (workspaceRoot === undefined || workspaceRoot.length === 0) {
    return []
  }

  const workspaceRef = workspaceRoot.startsWith('path:') ? workspaceRoot : `path:${workspaceRoot}`

  return ['--override-input', packageSpec.workspaceInput, workspaceRef]
}

const packageOption = Options.choice('package', ['genie', 'dotdot', 'mono', 'all'] as const).pipe(
  Options.withAlias('p'),
  Options.withDescription('Package to operate on'),
  Options.withDefault('all' as const),
)

const reloadOption = Options.boolean('reload').pipe(
  Options.withDescription('Reload direnv after build to update PATH'),
  Options.withDefault(false),
)

const PackagesOutPathsSchema = Schema.Record({ key: Schema.String, value: Schema.String })
type PackagesOutPaths = typeof PackagesOutPathsSchema.Type

const resolveExpectedOutPaths = Effect.fn('nix-status-expected-out-paths')(function* () {
  const system = yield* resolveNixSystem()
  const args = ['eval', '--json', ...evalCoresArgs(), `.#packages.${system}`]
  const output = yield* cmdText(['nix', ...args], { stderr: 'pipe' }).pipe(
    Effect.provideService(CurrentWorkingDirectory, resolveWorkspacePath('.')),
  )
  return yield* Schema.decodeUnknown(Schema.parseJson(PackagesOutPathsSchema))(output).pipe(
    Effect.mapError(
      (cause) =>
        new NixStatusParseError({
          message: 'Failed to decode nix status output',
          cause,
        }),
    ),
  )
})

const resolveActualBinaryPath = Effect.fn('nix-status-actual-binary-path')(function* (binaryName: string) {
  const cwd = process.env.WORKSPACE_ROOT ?? process.cwd()
  const output = yield* cmdText(['which', binaryName], { stderr: 'pipe' }).pipe(
    Effect.provideService(CurrentWorkingDirectory, cwd),
  )
  return output.trim()
})

const printStatus = (name: NixPackageName, expected: string | undefined) =>
  Effect.gen(function* () {
    const actualResult = yield* Effect.either(
      resolveActualBinaryPath(getBinaryName(name)).pipe(Effect.provide(Logger.minimumLogLevel(LogLevel.Info))),
    )
    const actual = actualResult._tag === 'Right' ? actualResult.right : undefined
    const refreshHint = `mono nix build --package ${name} --reload`

    if (expected === undefined) {
      yield* Console.log(`- ${name}: expected output missing from flake packages`)
      return
    }

    const isUpToDate =
      actual !== undefined && actual.length > 0 && actual.startsWith(`${expected}/`)

    if (actual === undefined || actual.length === 0) {
      yield* Console.log(`- ${name}: missing (expected ${expected}, refresh: ${refreshHint})`)
      return
    }

    if (isUpToDate) {
      yield* Console.log(`- ${name}: up-to-date (${actual})`)
      return
    }

    // Compare the active PATH binary to the expected Nix output path.
    yield* Console.log(`- ${name}: stale (expected ${expected}, actual ${actual}, refresh: ${refreshHint})`)
  })

/** Build a single Nix package */
const buildPackage = (name: NixPackageName) =>
  Effect.gen(function* () {
    const packageSpec = getPackageSpec(name)
    yield* Console.log(`Building ${name}...`)
    const args = ['build', ...evalCoresArgs(), ...buildParallelismArgs(), packageSpec.flakeRef, '-L']
    if (packageSpec.noWriteLock) {
      args.push('--no-write-lock-file')
    }
    args.push(...getWorkspaceOverrideArgs(packageSpec))
    yield* runCommand({
      command: 'nix',
      args,
      cwd: resolveFlakeDir(packageSpec),
    })
    yield* Console.log(`✓ ${name} built successfully`)
  })

const buildPackages = (names: NixPackageName[]) =>
  Effect.gen(function* () {
    if (names.length === 0) {
      return
    }
    const packageSpecs = names.map(getPackageSpec)
    const firstSpec = packageSpecs[0]
    if (firstSpec === undefined) {
      return
    }
    const flakeRefs = packageSpecs.map((spec) => spec.flakeRef)
    const needsNoWriteLock = packageSpecs.some((spec) => spec.noWriteLock === true)

    yield* Console.log(`Building ${names.join(', ')}...`)
    const args = ['build', ...evalCoresArgs(), ...buildParallelismArgs(), ...flakeRefs, '-L']
    if (needsNoWriteLock) {
      args.push('--no-write-lock-file')
    }
    yield* runCommand({
      command: 'nix',
      args,
      cwd: resolveFlakeDir(firstSpec),
    })
    yield* Console.log('✓ build completed')
  })

/** Get packages to operate on based on --package option */
const getPackages = (pkg: 'genie' | 'dotdot' | 'mono' | 'all'): NixPackageName[] =>
  pkg === 'all' ? allPackageNames : [pkg]

/** Build subcommand - rebuilds Nix packages */
const buildSubcommand = Command.make(
  'build',
  { package: packageOption, reload: reloadOption },
  ({ package: pkg, reload }) =>
    Effect.gen(function* () {
      const packages = getPackages(pkg)

      if (packages.length > 1) {
        yield* buildPackages(packages)
      } else {
        for (const name of packages) {
          yield* buildPackage(name)
        }
      }

      if (reload) {
        yield* Console.log('\nReloading direnv...')
        yield* runCommand({ command: 'direnv', args: ['reload'] })
        yield* Console.log('✓ direnv reloaded')
      }

      yield* Console.log(`\n✓ All done`)
    }),
).pipe(Command.withDescription('Build Nix packages (genie, dotdot, mono)'))

/** Update bunDepsHash in build.nix after bun.lock change */
const updateHash = (name: NixPackageName) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const packageSpec = getPackageSpec(name)
    const buildNixPath = path.join(resolveWorkspacePath(packageSpec.path), 'nix', 'build.nix')

    yield* Console.log(`Updating hash for ${name}...`)

    const args = ['build', ...evalCoresArgs(), ...buildParallelismArgs(), packageSpec.flakeRef, '-L']
    if (packageSpec.noWriteLock) {
      args.push('--no-write-lock-file')
    }
    args.push(...getWorkspaceOverrideArgs(packageSpec))
    // Run nix build and capture the hash mismatch error
    const command = PlatformCommand.make('nix', ...args).pipe(
      PlatformCommand.workingDirectory(resolveFlakeDir(packageSpec)),
      PlatformCommand.stderr('pipe'),
    )

    // Read stderr and wait for exit concurrently, scoped to manage stream resources
    const [stderrChunks, exitCode] = yield* Effect.scoped(
      Effect.gen(function* () {
        const process = yield* PlatformCommand.start(command)
        return yield* Effect.all([Stream.runCollect(process.stderr), process.exitCode])
      }),
    )

    // If build succeeded, hash is already correct
    if (exitCode === 0) {
      yield* Console.log(`✓ ${name} hash is already up to date`)
      return
    }

    // Decode stderr bytes to string
    const stderrText = new TextDecoder().decode(
      Chunk.toReadonlyArray(stderrChunks).reduce((acc, chunk) => {
        const result = new Uint8Array(acc.length + chunk.length)
        result.set(acc)
        result.set(chunk, acc.length)
        return result
      }, new Uint8Array()),
    )

    // Extract the "got: sha256-..." from stderr
    const hashMatch = stderrText.match(/got:\s+(sha256-[A-Za-z0-9+/=]+)/)
    if (!hashMatch) {
      yield* Console.error(`Could not extract hash from nix build output for ${name}`)
      yield* Console.error('Build may have failed for a different reason.')
      return yield* new HashExtractionError({
        packageName: name,
        message: `Hash extraction failed for ${name}`,
      })
    }

    const newHash = hashMatch[1]
    yield* Console.log(`Found new hash: ${newHash}`)

    // Read and update build.nix
    const buildNix = yield* fs.readFileString(buildNixPath)
    const updatedBuildNix = buildNix.replace(
      /bunDepsHash\s*=\s*(?:"sha256-[A-Za-z0-9+/=]+"|pkgs\.lib\.fakeHash|lib\.fakeHash);/,
      `bunDepsHash = "${newHash}";`,
    )

    if (buildNix === updatedBuildNix) {
      yield* Console.error(`Could not find bunDepsHash pattern in ${buildNixPath}`)
      return yield* new HashPatternNotFoundError({
        buildNixPath,
        message: `bunDepsHash pattern not found in ${buildNixPath}`,
      })
    }

    yield* fs.writeFileString(buildNixPath, updatedBuildNix)
    yield* Console.log(`✓ Updated ${buildNixPath}`)

    // Verify the build now works
    yield* Console.log(`Verifying build...`)
    yield* buildPackage(name)
  })

/** Hash subcommand - updates bunDepsHash after bun.lock changes */
const hashSubcommand = Command.make('hash', { package: packageOption }, ({ package: pkg }) =>
  Effect.gen(function* () {
    const packages = getPackages(pkg)

    for (const name of packages) {
      yield* updateHash(name)
    }

    yield* Console.log(`\n✓ Hash update complete`)
  }),
).pipe(Command.withDescription('Update bunDepsHash in build.nix after bun.lock changes'))

/** Reload subcommand - reloads direnv to pick up rebuilt binaries */
const reloadSubcommand = Command.make('reload', {}, () =>
  Effect.gen(function* () {
    yield* Console.log('Reloading direnv...')
    yield* runCommand({ command: 'direnv', args: ['reload'] })
    yield* Console.log('✓ direnv reloaded - Nix binaries updated in PATH')
  }),
).pipe(Command.withDescription('Reload direnv to update Nix binaries in PATH'))

/** Status subcommand - compare PATH binaries to expected Nix outputs */
const statusSubcommand = Command.make('status', { package: packageOption }, ({ package: pkg }) =>
  Effect.gen(function* () {
    const packages = getPackages(pkg)
    yield* Console.log('Nix CLI status:')

    const expectedOutPaths = yield* resolveExpectedOutPaths().pipe(
      Effect.provide(Logger.minimumLogLevel(LogLevel.Info)),
    )

    for (const name of packages) {
      yield* printStatus(name, expectedOutPaths[name])
    }
  }),
).pipe(Command.withDescription('Show whether Nix binaries match the current flake output'))

/** Main nix command with subcommands */
export const nixCommand: Command.Command<
  'nix',
  CommandExecutor.CommandExecutor | FileSystem.FileSystem | CurrentWorkingDirectory,
  | CommandError
  | PlatformError
  | CmdError
  | HashExtractionError
  | HashPatternNotFoundError
  | UnsupportedSystemError
  | NixStatusParseError,
  {
    readonly subcommand: Option.Option<
      | { readonly package: 'genie' | 'dotdot' | 'mono' | 'all'; readonly reload: boolean }
      | { readonly package: 'genie' | 'dotdot' | 'mono' | 'all' }
      | Record<string, never>
      | { readonly package: 'genie' | 'dotdot' | 'mono' | 'all' }
    >
  }
> = Command.make('nix').pipe(
  Command.withSubcommands([buildSubcommand, hashSubcommand, reloadSubcommand, statusSubcommand]),
  Command.withDescription('Manage Nix-bundled binaries (genie, dotdot, mono)'),
)
