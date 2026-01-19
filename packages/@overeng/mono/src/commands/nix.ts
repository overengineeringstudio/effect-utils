import os from 'node:os'
import path from 'node:path'

import { Command, Options } from '@effect/cli'
import { Command as PlatformCommand, FileSystem } from '@effect/platform'
import { Chunk, Console, Effect, Logger, LogLevel, Schema, Stream } from 'effect'

import { shouldNeverHappen } from '@overeng/utils'
import { cmdText, CurrentWorkingDirectory } from '@overeng/utils/node'


import { CommandError } from '../errors.ts'
import { runCommand } from '../utils.ts'

/** Specification for a Nix package managed by the mono nix command */
export type NixPackageSpec = {
  name: string
  flakeRef: string
  flakeDir?: string
  noWriteLock?: boolean
  workspaceInput?: string
  binaryName?: string
  buildNixPath?: string
}

/** Configuration for the mono nix command */
export type NixCommandConfig = {
  packages: readonly NixPackageSpec[]
  description?: string
}

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

class UnsupportedSystemError extends Schema.TaggedError<UnsupportedSystemError>()(
  'UnsupportedSystemError',
  {
    platform: Schema.String,
    arch: Schema.String,
    message: Schema.String,
  },
) {}

class NixStatusParseError extends Schema.TaggedError<NixStatusParseError>()('NixStatusParseError', {
  message: Schema.String,
  cause: Schema.Defect,
}) {}

class NixStatusCheckFailedError extends Schema.TaggedError<NixStatusCheckFailedError>()(
  'NixStatusCheckFailedError',
  {
    message: Schema.String,
    staleCount: Schema.Number,
    missingCount: Schema.Number,
  },
) {}

class MissingBuildNixPathError extends Schema.TaggedError<MissingBuildNixPathError>()(
  'MissingBuildNixPathError',
  {
    packageName: Schema.String,
    message: Schema.String,
  },
) {}

type StatusScope = 'auto' | 'flake' | 'devenv'

type ExpectedPath = { _tag: 'flake'; outputRoot: string } | { _tag: 'devenv'; binaryPath: string }

type StatusState = 'up-to-date' | 'stale' | 'missing' | 'expected-missing'

type StatusEntry = {
  name: string
  state: StatusState
  expected?: string
  actual?: string
  refreshHint: string
}

const toPackageMap = (packages: readonly NixPackageSpec[]) => {
  const entries = packages.map((pkg) => [pkg.name, pkg] as const)
  return new Map(entries)
}

const resolveWorkspacePath = (relativePath: string): string => {
  const workspaceRoot = process.env.WORKSPACE_ROOT ?? process.cwd()
  return path.resolve(workspaceRoot, relativePath)
}

const resolveFlakeDir = (packageSpec: NixPackageSpec): string =>
  resolveWorkspacePath(packageSpec.flakeDir ?? '.')

const resolveBuildNixPath = (packageSpec: NixPackageSpec): string => {
  if (!packageSpec.buildNixPath) {
    return shouldNeverHappen(`buildNixPath missing for package ${packageSpec.name}`)
  }
  return resolveWorkspacePath(packageSpec.buildNixPath)
}

const decodeChunks = (chunks: Chunk.Chunk<Uint8Array>): string =>
  new TextDecoder().decode(
    Chunk.toReadonlyArray(chunks).reduce((acc, chunk) => {
      const result = new Uint8Array(acc.length + chunk.length)
      result.set(acc)
      result.set(chunk, acc.length)
      return result
    }, new Uint8Array()),
  )

const warnIfStaleBunDeps = Effect.fn('nix.warnIfStaleBunDeps')(function* (
  stderrText: string,
  packageNames: readonly string[],
) {
  if (!stderrText.includes('hash mismatch in fixed-output derivation')) {
    return
  }
  yield* Console.error('nix reported a fixed-output hash mismatch; bunDepsHash is likely stale.')
  for (const name of packageNames) {
    yield* Console.error(`- ${name}: run mono nix hash --package ${name}`)
  }
})

const runNixBuild = Effect.fn('nix.runNixBuild')(function* (opts: {
  args: readonly string[]
  cwd: string
  packageNames: readonly string[]
}) {
  const { args, cwd, packageNames } = opts
  const command = PlatformCommand.make('nix', ...args).pipe(
    PlatformCommand.workingDirectory(cwd),
    PlatformCommand.stdout('inherit'),
    PlatformCommand.stderr('pipe'),
  )
  const [stderrChunks, exitCode] = yield* Effect.scoped(
    Effect.gen(function* () {
      const process = yield* PlatformCommand.start(command)
      const chunks = yield* process.stderr.pipe(
        Stream.tap((chunk) => Effect.sync(() => globalThis.process.stderr.write(chunk))),
        Stream.runCollect,
      )
      return [chunks, yield* process.exitCode] as const
    }),
  )
  if (exitCode !== 0) {
    const stderrText = decodeChunks(stderrChunks)
    yield* warnIfStaleBunDeps(stderrText, packageNames)
    return yield* new CommandError({
      command: `nix ${args.join(' ')}`,
      message: 'nix build failed',
    })
  }
})

const getBinaryName = (packageSpec: NixPackageSpec): string =>
  packageSpec.binaryName ?? packageSpec.name

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

const resolveNixSystem = Effect.fn('resolveNixSystem')(function* () {
  const platform = process.platform
  const arch = process.arch

  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-darwin'
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-darwin'
  if (platform === 'linux' && arch === 'arm64') return 'aarch64-linux'
  if (platform === 'linux' && arch === 'x64') return 'x86_64-linux'

  return yield* new UnsupportedSystemError({
    platform,
    arch,
    message: `Unsupported system for nix status: ${platform}/${arch}`,
  })
})

const resolveExpectedOutPaths = Effect.fn('nix-status-expected-out-paths')(function* () {
  const system = yield* resolveNixSystem()
  const args = ['eval', '--json', ...evalCoresArgs(), `.#packages.${system}`]
  const output = yield* cmdText(['nix', ...args], { stderr: 'pipe' }).pipe(
    Effect.provideService(CurrentWorkingDirectory, resolveWorkspacePath('.')),
  )
  const parsed = yield* Schema.decodeUnknown(
    Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.String })),
  )(output).pipe(
    Effect.mapError(
      (cause) =>
        new NixStatusParseError({
          message: 'Failed to decode nix status output',
          cause,
        }),
    ),
  )
  return parsed
})

const resolveActualBinaryPath = Effect.fn('nix-status-actual-binary-path')(function* (
  binaryName: string,
) {
  const cwd = process.env.WORKSPACE_ROOT ?? process.cwd()
  const output = yield* cmdText(['which', binaryName], { stderr: 'pipe' }).pipe(
    Effect.provideService(CurrentWorkingDirectory, cwd),
  )
  return output.trim()
})

/** Resolve the store path behind the devenv profile symlink for consistent comparisons. */
const resolveDevenvBinaryPath = Effect.fn('nix-status-devenv-binary-path')(function* (
  binaryName: string,
) {
  const profile = process.env.DEVENV_PROFILE
  if (profile === undefined || profile.length === 0) {
    return undefined
  }

  const candidate = path.join(profile, 'bin', binaryName)
  const result = yield* Effect.either(
    cmdText(['realpath', candidate], { stderr: 'pipe' }).pipe(
      Effect.provideService(CurrentWorkingDirectory, profile),
      Effect.provide(Logger.minimumLogLevel(LogLevel.Info)),
    ),
  )
  if (result._tag === 'Left') {
    return undefined
  }
  return result.right.trim()
})

const resolveStatusScope = (scope: StatusScope): StatusScope => {
  if (scope !== 'auto') {
    return scope
  }
  return process.env.DEVENV_PROFILE ? 'devenv' : 'flake'
}

const toFlakeExpected = (outputRoot: string): ExpectedPath => ({ _tag: 'flake', outputRoot })

const toDevenvExpected = (binaryPath: string): ExpectedPath => ({ _tag: 'devenv', binaryPath })

const resolveStatusEntry = Effect.fn('nix.resolveStatusEntry')(function* (opts: {
  packageSpec: NixPackageSpec
  expected: ExpectedPath | undefined
}) {
  const { packageSpec, expected } = opts
  const actualResult = yield* Effect.either(
    resolveActualBinaryPath(getBinaryName(packageSpec)).pipe(
      Effect.provide(Logger.minimumLogLevel(LogLevel.Info)),
    ),
  )
  const actual = actualResult._tag === 'Right' ? actualResult.right : undefined
  const refreshHint = `mono nix build --package ${packageSpec.name} --reload`

  if (expected === undefined) {
    return {
      name: packageSpec.name,
      state: 'expected-missing',
      refreshHint,
    } satisfies StatusEntry
  }

  const expectedLabel = expected._tag === 'flake' ? expected.outputRoot : expected.binaryPath
  const isUpToDate =
    actual !== undefined &&
    actual.length > 0 &&
    (expected._tag === 'flake'
      ? actual.startsWith(`${expected.outputRoot}/`)
      : actual === expected.binaryPath)

  if (actual === undefined || actual.length === 0) {
    return {
      name: packageSpec.name,
      state: 'missing',
      expected: expectedLabel,
      refreshHint,
    } satisfies StatusEntry
  }

  if (isUpToDate) {
    return {
      name: packageSpec.name,
      state: 'up-to-date',
      actual,
      refreshHint,
    } satisfies StatusEntry
  }

  return {
    name: packageSpec.name,
    state: 'stale',
    expected: expectedLabel,
    actual,
    refreshHint,
  } satisfies StatusEntry
})

const printStatusEntry = Effect.fn('nix.printStatusEntry')(function* (entry: StatusEntry) {
  if (entry.state === 'expected-missing') {
    yield* Console.log(`- ${entry.name}: expected output missing`)
    return
  }

  if (entry.state === 'missing') {
    yield* Console.log(
      `- ${entry.name}: missing (expected ${entry.expected}, refresh: ${entry.refreshHint})`,
    )
    return
  }

  if (entry.state === 'up-to-date') {
    yield* Console.log(`- ${entry.name}: up-to-date (${entry.actual})`)
    return
  }

  yield* Console.log(
    `- ${entry.name}: stale (expected ${entry.expected}, actual ${entry.actual}, refresh: ${entry.refreshHint})`,
  )
})

const resolveWorkspaceOverrideArgs = (packageSpec: NixPackageSpec): string[] => {
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

const buildPackage = Effect.fn('nix.buildPackage')(function* (packageSpec: NixPackageSpec) {
  yield* Console.log(`Building ${packageSpec.name}...`)
  const args = [
    'build',
    ...evalCoresArgs(),
    ...buildParallelismArgs(),
    packageSpec.flakeRef,
    '-L',
  ]
  if (packageSpec.noWriteLock) {
    args.push('--no-write-lock-file')
  }
  // Avoid creating ./result symlinks when running from direnv or scripts.
  args.push('--no-link')
  args.push(...resolveWorkspaceOverrideArgs(packageSpec))
  yield* runNixBuild({
    args,
    cwd: resolveFlakeDir(packageSpec),
    packageNames: [packageSpec.name],
  })
  yield* Console.log(`✓ ${packageSpec.name} built successfully`)
})

const buildPackages = Effect.fn('nix.buildPackages')(function* (
  packageSpecs: readonly NixPackageSpec[],
) {
  if (packageSpecs.length === 0) {
    return
  }
  const firstSpec = packageSpecs[0]
  if (firstSpec === undefined) {
    return
  }
  const flakeRefs = packageSpecs.map((spec) => spec.flakeRef)
  const needsNoWriteLock = packageSpecs.some((spec) => spec.noWriteLock === true)

  yield* Console.log(`Building ${packageSpecs.map((spec) => spec.name).join(', ')}...`)
  const args = ['build', ...evalCoresArgs(), ...buildParallelismArgs(), ...flakeRefs, '-L']
  if (needsNoWriteLock) {
    args.push('--no-write-lock-file')
  }
  // Avoid creating ./result symlinks when building multiple packages.
  args.push('--no-link')
  yield* runNixBuild({
    args,
    cwd: resolveFlakeDir(firstSpec),
    packageNames: packageSpecs.map((spec) => spec.name),
  })
  yield* Console.log('✓ build completed')
})

const updateHash = Effect.fn('nix.updateHash')(function* (packageSpec: NixPackageSpec) {
  const fs = yield* FileSystem.FileSystem
  const buildNixPath = resolveBuildNixPath(packageSpec)

  yield* Console.log(`Updating hash for ${packageSpec.name}...`)

  const args = [
    'build',
    ...evalCoresArgs(),
    ...buildParallelismArgs(),
    packageSpec.flakeRef,
    '-L',
  ]
  if (packageSpec.noWriteLock) {
    args.push('--no-write-lock-file')
  }
  args.push(...resolveWorkspaceOverrideArgs(packageSpec))
  const command = PlatformCommand.make('nix', ...args).pipe(
    PlatformCommand.workingDirectory(resolveFlakeDir(packageSpec)),
    PlatformCommand.stderr('pipe'),
  )

  const [stderrChunks, exitCode] = yield* Effect.scoped(
    Effect.gen(function* () {
      const process = yield* PlatformCommand.start(command)
      return yield* Effect.all([Stream.runCollect(process.stderr), process.exitCode])
    }),
  )

  if (exitCode === 0) {
    yield* Console.log(`✓ ${packageSpec.name} hash is already up to date`)
    return
  }

  const stderrText = decodeChunks(stderrChunks)

  const hashMatch = stderrText.match(/got:\s+(sha256-[A-Za-z0-9+/=]+)/)
  if (!hashMatch) {
    yield* Console.error(`Could not extract hash from nix build output for ${packageSpec.name}`)
    yield* Console.error('Build may have failed for a different reason.')
    return yield* new HashExtractionError({
      packageName: packageSpec.name,
      message: `Hash extraction failed for ${packageSpec.name}`,
    })
  }

  const newHash = hashMatch[1]
  yield* Console.log(`Found new hash: ${newHash}`)

  const buildNix = yield* fs.readFileString(buildNixPath)
  const updatedBuildNix = buildNix.replace(
    /bunDepsHash\s*=\s*(?:"sha256-[A-Za-z0-9+/=]+"|lib\.fakeHash|pkgs\.lib\.fakeHash);/,
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

  yield* Console.log('Verifying build...')
  yield* buildPackage(packageSpec)
})

const resolvePackageNames = (packages: readonly NixPackageSpec[]): readonly string[] =>
  packages.map((pkg) => pkg.name)

const resolvePackageSpec = ({
  packageMap,
  name,
}: {
  packageMap: Map<string, NixPackageSpec>
  name: string
}): NixPackageSpec => {
  const spec = packageMap.get(name)
  return spec ?? shouldNeverHappen(`Unknown package: ${name}`)
}

/** Create a nix command for managing Nix packages in the workspace */
export const nixCommand = (config: NixCommandConfig) => {
  const packageMap = toPackageMap(config.packages)
  const packageNames = resolvePackageNames(config.packages)
  const hashablePackages = config.packages.filter((pkg) => pkg.buildNixPath !== undefined)

  const packageOption = Options.choice('package', [...packageNames, 'all']).pipe(
    Options.withAlias('p'),
    Options.withDescription('Package to operate on'),
    Options.withDefault('all'),
  )

  const hashPackageOption = Options.choice('package', [
    ...hashablePackages.map((pkg) => pkg.name),
    'all',
  ] as const).pipe(
    Options.withAlias('p'),
    Options.withDescription('Package to operate on'),
    Options.withDefault('all'),
  )

  const scopeOption = Options.choice('scope', ['auto', 'flake', 'devenv'] as const).pipe(
    Options.withDescription('Which outputs to compare against (defaults to auto)'),
    Options.withDefault('auto' as const),
  )

  const statusCheckOption = Options.boolean('check').pipe(
    Options.withDescription('Exit non-zero if any binaries are stale or missing'),
    Options.withDefault(false),
  )

  const reloadOption = Options.boolean('reload').pipe(
    Options.withDescription('Reload direnv after build to update PATH'),
    Options.withDefault(false),
  )

  const getPackages = (pkg: string): NixPackageSpec[] =>
    pkg === 'all' ? [...config.packages] : [resolvePackageSpec({ packageMap, name: pkg })]

  const getHashablePackages = (pkg: string): NixPackageSpec[] => {
    if (pkg === 'all') {
      return hashablePackages
    }
    const spec = resolvePackageSpec({ packageMap, name: pkg })
    if (!spec.buildNixPath) {
      return []
    }
    return [spec]
  }

  const buildSubcommand = Command.make(
    'build',
    { package: packageOption, reload: reloadOption },
    ({ package: pkg, reload }) =>
      Effect.gen(function* () {
        const packages = getPackages(pkg)

        if (packages.length > 1) {
          yield* buildPackages(packages)
        } else if (packages[0]) {
          yield* buildPackage(packages[0])
        }

        if (reload) {
          yield* Console.log('\nReloading direnv...')
          yield* runCommand({ command: 'direnv', args: ['reload'] })
          yield* Console.log('✓ direnv reloaded')
        }

        yield* Console.log('\n✓ All done')
      }),
  ).pipe(Command.withDescription('Build Nix packages'))

  const hashSubcommand =
    hashablePackages.length === 0
      ? undefined
      : Command.make('hash', { package: hashPackageOption }, ({ package: pkg }) =>
          Effect.gen(function* () {
            const packages = getHashablePackages(pkg)
            if (packages.length === 0) {
              return yield* new MissingBuildNixPathError({
                packageName: pkg,
                message: `Package ${pkg} does not define buildNixPath`,
              })
            }

            for (const packageSpec of packages) {
              yield* updateHash(packageSpec)
            }

            yield* Console.log('\n✓ Hash update complete')
          }),
        ).pipe(Command.withDescription('Update bunDepsHash in build.nix after bun.lock changes'))

  const reloadSubcommand = Command.make('reload', {}, () =>
    Effect.gen(function* () {
      yield* Console.log('Reloading direnv...')
      yield* runCommand({ command: 'direnv', args: ['reload'] })
      yield* Console.log('✓ direnv reloaded - Nix binaries updated in PATH')
    }),
  ).pipe(Command.withDescription('Reload direnv to update Nix binaries in PATH'))

  const statusSubcommand = Command.make(
    'status',
    { package: packageOption, scope: scopeOption, check: statusCheckOption },
    ({ package: pkg, scope, check }) =>
      Effect.gen(function* () {
        const packages = getPackages(pkg)
        const resolvedScope = resolveStatusScope(scope)
        yield* Console.log(`Nix CLI status (${resolvedScope}):`)

        const expectedOutPaths =
          resolvedScope === 'flake'
            ? yield* resolveExpectedOutPaths().pipe(
                Effect.provide(Logger.minimumLogLevel(LogLevel.Info)),
              )
            : undefined

        const entries = []
        for (const packageSpec of packages) {
          if (resolvedScope === 'devenv') {
            const devenvPath = yield* resolveDevenvBinaryPath(getBinaryName(packageSpec))
            const expected = devenvPath ? toDevenvExpected(devenvPath) : undefined
            entries.push(yield* resolveStatusEntry({ packageSpec, expected }))
          } else {
            const expectedPath = expectedOutPaths?.[packageSpec.name]
            const expected = expectedPath ? toFlakeExpected(expectedPath) : undefined
            entries.push(yield* resolveStatusEntry({ packageSpec, expected }))
          }
        }

        for (const entry of entries) {
          yield* printStatusEntry(entry)
        }

        if (check) {
          const staleCount = entries.filter((entry) => entry.state === 'stale').length
          const missingCount = entries.filter(
            (entry) => entry.state === 'missing' || entry.state === 'expected-missing',
          ).length
          if (staleCount > 0 || missingCount > 0) {
            return yield* new NixStatusCheckFailedError({
              message: 'Nix CLI status check failed',
              staleCount,
              missingCount,
            })
          }
        }
      }),
  ).pipe(Command.withDescription('Show whether Nix binaries match the current outputs'))

  const subcommands = hashSubcommand
    ? ([buildSubcommand, hashSubcommand, reloadSubcommand, statusSubcommand] as const)
    : ([buildSubcommand, reloadSubcommand, statusSubcommand] as const)

  const description =
    config.description ?? `Manage Nix-bundled binaries (${packageNames.join(', ')})`

  return Command.make('nix').pipe(
    Command.withSubcommands(subcommands),
    Command.withDescription(description),
  )
}
