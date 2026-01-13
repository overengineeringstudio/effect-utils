import { Command, Options } from '@effect/cli'
import { Command as PlatformCommand, FileSystem } from '@effect/platform'
import { Chunk, Console, Effect, Schema, Stream } from 'effect'

import { runCommand } from '@overeng/mono'

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
  noWriteLock?: boolean
  workspaceInput?: string
}

/** Known Nix packages in this monorepo */
const NIX_PACKAGES = {
  genie: { path: 'packages/@overeng/genie', flakeRef: '.#default' },
  dotdot: { path: 'packages/@overeng/dotdot', flakeRef: '.#default' },
  mono: {
    path: 'scripts',
    flakeRef: 'path:..#mono',
    noWriteLock: true,
  },
} as const satisfies Record<string, NixPackageSpec>

type NixPackageName = keyof typeof NIX_PACKAGES

const allPackageNames = Object.keys(NIX_PACKAGES) as NixPackageName[]

const getPackageSpec = (name: NixPackageName): NixPackageSpec => NIX_PACKAGES[name]

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

/** Build a single Nix package */
const buildPackage = (name: NixPackageName) =>
  Effect.gen(function* () {
    const packageSpec = getPackageSpec(name)
    yield* Console.log(`Building ${name}...`)
    const args = ['build', packageSpec.flakeRef, '-L']
    if (packageSpec.noWriteLock) {
      args.push('--no-write-lock-file')
    }
    args.push(...getWorkspaceOverrideArgs(packageSpec))
    yield* runCommand({
      command: 'nix',
      args,
      cwd: packageSpec.path,
    })
    yield* Console.log(`✓ ${name} built successfully`)
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

      for (const name of packages) {
        yield* buildPackage(name)
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
    const buildNixPath = `${packageSpec.path}/nix/build.nix`

    yield* Console.log(`Updating hash for ${name}...`)

    const args = ['build', packageSpec.flakeRef, '-L']
    if (packageSpec.noWriteLock) {
      args.push('--no-write-lock-file')
    }
    args.push(...getWorkspaceOverrideArgs(packageSpec))
    // Run nix build and capture the hash mismatch error
    const command = PlatformCommand.make('nix', ...args).pipe(
      PlatformCommand.workingDirectory(packageSpec.path),
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

/** Main nix command with subcommands */
export const nixCommand = Command.make('nix').pipe(
  Command.withSubcommands([buildSubcommand, hashSubcommand, reloadSubcommand]),
  Command.withDescription('Manage Nix-bundled binaries (genie, dotdot, mono)'),
)
