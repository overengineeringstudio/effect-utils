import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Console, Effect, Option } from 'effect'

import { readRepoCatalog } from '../catalog.ts'
import { detectComposedRepos } from '../config.ts'

/** List command: shows composed repos and their catalog status */
export const listCommand = Cli.Command.make('list', {}, () =>
  Effect.gen(function* () {
    const cwd = process.cwd()
    const fs = yield* FileSystem.FileSystem

    // Auto-detect composed repos from .gitmodules
    const composedRepos = yield* detectComposedRepos(cwd)

    yield* Console.log('Composed repos:\n')

    // Show main repo
    const mainCatalog = yield* readRepoCatalog('main', cwd)
    if (Option.isSome(mainCatalog)) {
      const count = Object.keys(mainCatalog.value.catalog).length
      yield* Console.log(`  main (root)`)
      yield* Console.log(`    catalog: ${mainCatalog.value.source} (${count} packages)`)
    } else {
      yield* Console.log(`  main (root)`)
      yield* Console.log(`    catalog: none`)
    }

    yield* Console.log('')

    if (composedRepos.length === 0) {
      yield* Console.log('  No composed repos detected (no git submodules found)')
      return
    }

    // Show each composed repo
    for (const repo of composedRepos) {
      const repoPath = `${cwd}/${repo.path}`

      yield* Console.log(`  ${repo.name}`)
      yield* Console.log(`    path: ${repo.path}`)

      const exists = yield* fs.exists(repoPath)
      if (!exists) {
        yield* Console.log(`    status: ✗ not found`)
        yield* Console.log('')
        continue
      }

      const repoCatalog = yield* readRepoCatalog(repo.name, repoPath)
      if (Option.isSome(repoCatalog)) {
        const count = Object.keys(repoCatalog.value.catalog).length
        yield* Console.log(`    catalog: ${repoCatalog.value.source} (${count} packages)`)
      } else {
        yield* Console.log(`    catalog: none`)
      }

      yield* Console.log('')
    }
  }).pipe(Effect.withSpan('list')),
).pipe(Cli.Command.withDescription('List composed repos and their catalog status'))
