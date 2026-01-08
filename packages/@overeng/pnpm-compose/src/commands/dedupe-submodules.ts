import * as Cli from '@effect/cli'
import { Console, Effect } from 'effect'

import {
  addToGitExclude,
  createSubmoduleSymlink,
  findAllSubmodules,
  findDuplicates,
} from '../submodule-dedupe.ts'

/** Dedupe-submodules command: creates symlinks for duplicate submodules */
export const dedupeSubmodulesCommand = Cli.Command.make('dedupe-submodules', {}, () =>
  Effect.gen(function* () {
    const cwd = process.cwd()

    yield* Console.log('Scanning for duplicate submodules...\n')

    // Find all submodules across workspace
    const allSubmodules = yield* findAllSubmodules(cwd)

    if (allSubmodules.length === 0) {
      yield* Console.log('No submodules found in workspace')
      return
    }

    yield* Console.log(`Found ${allSubmodules.length} total submodule reference(s)\n`)

    // Find duplicates
    const duplicates = findDuplicates(allSubmodules)

    if (duplicates.length === 0) {
      yield* Console.log('✓ No duplicate submodules found')
      return
    }

    yield* Console.log(`Found ${duplicates.length} duplicate submodule(s):\n`)

    // Report duplicates (use relative paths from workspace root)
    for (const dup of duplicates) {
      yield* Console.log(`  ${dup.url}`)
      const canonicalRelPath =
        dup.canonical.repoRoot === cwd
          ? dup.canonical.path
          : `${dup.canonical.repoRoot.replace(cwd + '/', '')}/${dup.canonical.path}`
      yield* Console.log(`    Canonical: ${canonicalRelPath}`)
      for (const loc of dup.locations) {
        if (loc === dup.canonical) continue
        const locRelPath =
          loc.repoRoot === cwd ? loc.path : `${loc.repoRoot.replace(cwd + '/', '')}/${loc.path}`
        yield* Console.log(`    Duplicate: ${locRelPath}`)
      }
      yield* Console.log('')
    }

    yield* Console.log('Creating symlinks...\n')

    // Create symlinks for non-canonical locations
    for (const dup of duplicates) {
      for (const loc of dup.locations) {
        if (loc === dup.canonical) continue

        yield* Console.log(`  ${loc.path} -> ${dup.canonical.path}`)
        yield* createSubmoduleSymlink(cwd, dup, loc)

        // Add to .git/info/exclude so git doesn't track the symlink
        yield* addToGitExclude(loc.repoRoot, loc.path)
      }
    }

    yield* Console.log('\n✓ Submodule deduplication complete')
    yield* Console.log(
      `  Created ${duplicates.flatMap((d) => d.locations.filter((l) => l !== d.canonical)).length} symlink(s)`,
    )
  }).pipe(Effect.withSpan('dedupe-submodules')),
).pipe(
  Cli.Command.withDescription(
    'Deduplicate git submodules by creating symlinks to canonical locations',
  ),
)
