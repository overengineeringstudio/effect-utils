import * as Cli from '@effect/cli'
import { Command, FileSystem } from '@effect/platform'
import { Console, Effect, Option, Schema } from 'effect'

import { findCatalogConflicts, readRepoCatalog, type RepoCatalog } from '../catalog.ts'
import { detectComposedRepos } from '../config.ts'

/**
 * Install command: runs bun install with catalog alignment check.
 *
 * Unlike pnpm-compose, bun-compose's install is significantly simpler:
 * - No symlink dance needed (bun handles workspace packages correctly)
 * - No node_modules corruption cleanup needed (bun's isolated linker is safe)
 * - Just validates catalog alignment and runs `bun install`
 */
export const installCommand = Cli.Command.make(
  'install',
  {
    skipCatalogCheck: Cli.Options.boolean('skip-catalog-check').pipe(
      Cli.Options.withDescription('Skip catalog alignment check'),
      Cli.Options.withDefault(false),
    ),
    frozen: Cli.Options.boolean('frozen').pipe(
      Cli.Options.withDescription('Use frozen lockfile (--frozen-lockfile)'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ skipCatalogCheck, frozen }) =>
    Effect.gen(function* () {
      const cwd = process.cwd()
      const fs = yield* FileSystem.FileSystem

      // Step 1: Check catalog alignment (unless skipped)
      if (!skipCatalogCheck) {
        yield* Console.log('Checking catalog alignment...\n')

        const composedRepos = yield* detectComposedRepos(cwd)
        const catalogs: RepoCatalog[] = []
        const missingPaths: string[] = []

        // Read main repo catalog
        const mainCatalog = yield* readRepoCatalog({ repoName: 'main', repoPath: cwd })
        if (Option.isSome(mainCatalog)) {
          catalogs.push(mainCatalog.value)
          yield* Console.log(`✓ main (${mainCatalog.value.source})`)
        } else {
          yield* Console.log('⚠ main: no catalog found')
        }

        // Read each composed repo's catalog
        for (const repo of composedRepos) {
          const repoPath = `${cwd}/${repo.path}`

          const exists = yield* fs.exists(repoPath)
          if (!exists) {
            yield* Console.log(`✗ ${repo.name}: path not found (${repo.path})`)
            missingPaths.push(repo.path)
            continue
          }

          const repoCatalog = yield* readRepoCatalog({ repoName: repo.name, repoPath })
          if (Option.isSome(repoCatalog)) {
            catalogs.push(repoCatalog.value)
            yield* Console.log(`✓ ${repo.name} (${repoCatalog.value.source})`)
          } else {
            yield* Console.log(`⚠ ${repo.name}: no catalog found`)
          }
        }

        yield* Console.log('')

        // Fail if any composed repo paths are missing
        if (missingPaths.length > 0) {
          return yield* new InstallFailedError({
            reason: `Composed repo path(s) not found: ${missingPaths.join(', ')}`,
          })
        }

        // Find and report conflicts
        const conflicts = findCatalogConflicts(catalogs)
        if (conflicts.length > 0) {
          yield* Console.log(`✗ Found ${conflicts.length} catalog conflict(s):\n`)

          for (const conflict of conflicts) {
            yield* Console.log(`  ${conflict.packageName}:`)
            for (const { repoName, version } of conflict.versions) {
              const marker = version === conflict.highestVersion ? '→' : ' '
              yield* Console.log(`    ${marker} ${repoName}: ${version}`)
            }
            yield* Console.log(`    Suggestion: update all to ${conflict.highestVersion}\n`)
          }

          return yield* new InstallFailedError({
            reason: `Catalog alignment failed: ${conflicts.length} conflict(s) found. Fix conflicts and retry.`,
          })
        }

        yield* Console.log('✓ All catalogs are aligned\n')
      }

      // Step 2: Run bun install
      yield* Console.log('Running bun install...\n')

      const args = frozen ? ['install', '--frozen-lockfile'] : ['install']
      const command = Command.make('bun', ...args).pipe(Command.workingDirectory(cwd))

      const exitCode = yield* Command.exitCode(command)

      if (exitCode !== 0) {
        return yield* new InstallFailedError({
          reason: `bun install failed with exit code ${exitCode}`,
        })
      }

      yield* Console.log('\n✓ Install complete')
    }).pipe(Effect.withSpan('install')),
).pipe(Cli.Command.withDescription('Install dependencies with catalog alignment check'))

/** Error when install fails */
class InstallFailedError extends Schema.TaggedError<InstallFailedError>()('InstallFailedError', {
  reason: Schema.String,
}) {
  override get message(): string {
    return `Install failed: ${this.reason}`
  }
}
