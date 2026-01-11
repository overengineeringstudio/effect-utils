import * as Cli from '@effect/cli'
import { Error as PlatformError, FileSystem } from '@effect/platform'
import { Console, Effect, Option, Schema } from 'effect'

import {
  CatalogReadError,
  findCatalogConflicts,
  readRepoCatalog,
  type RepoCatalog,
} from '../catalog.ts'
import { ConfigLoadError, ConfigValidationError, detectComposedRepos } from '../config.ts'

/** Check command: validates catalog alignment across composed repos */
type CheckCommandEnv = FileSystem.FileSystem

type CheckCommandError =
  | CheckFailedError
  | CatalogReadError
  | ConfigLoadError
  | ConfigValidationError
  | PlatformError.PlatformError

export const checkCommand: Cli.Command.Command<'check', CheckCommandEnv, CheckCommandError, {}> =
  Cli.Command.make('check', {}, () =>
    Effect.gen(function* () {
      const cwd = process.cwd()
      const fs = yield* FileSystem.FileSystem

      // Auto-detect composed repos from .gitmodules
      const composedRepos = yield* detectComposedRepos(cwd)

      yield* Console.log('Checking catalog alignment...\n')

      // Read catalogs from all composed repos
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
        return yield* new CheckFailedError({
          conflictCount: 0,
          missingPaths,
        })
      }

      // Find conflicts
      const conflicts = findCatalogConflicts(catalogs)

      if (conflicts.length === 0) {
        yield* Console.log('✓ All catalogs are aligned')
        return
      }

      // Report conflicts
      yield* Console.log(`✗ Found ${conflicts.length} catalog conflict(s):\n`)

      for (const conflict of conflicts) {
        yield* Console.log(`  ${conflict.packageName}:`)
        for (const { repoName, version } of conflict.versions) {
          const marker = version === conflict.highestVersion ? '→' : ' '
          yield* Console.log(`    ${marker} ${repoName}: ${version}`)
        }
        yield* Console.log(`    Suggestion: update all to ${conflict.highestVersion}\n`)
      }

      return yield* new CheckFailedError({ conflictCount: conflicts.length, missingPaths: [] })
    }).pipe(Effect.withSpan('check')),
  ).pipe(Cli.Command.withDescription('Check catalog alignment across composed repos'))

/** Error when check fails due to conflicts or missing paths */
export class CheckFailedError extends Schema.TaggedError<CheckFailedError>()('CheckFailedError', {
  conflictCount: Schema.Number,
  missingPaths: Schema.Array(Schema.String),
}) {
  override get message(): string {
    if (this.missingPaths.length > 0) {
      return `Check failed: ${this.missingPaths.length} composed repo path(s) not found: ${this.missingPaths.join(', ')}`
    }
    return `Catalog check failed: ${this.conflictCount} conflict(s) found`
  }
}
