/**
 * dotdot link command
 *
 * Manage symlinks based on packages configuration
 */

import path from 'node:path'

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import {
  type ConfigSource,
  CurrentWorkingDirectory,
  collectAllConfigs,
  findWorkspaceRoot,
} from '../lib/mod.ts'

/** Error during link operation */
export class LinkError extends Schema.TaggedError<LinkError>()('LinkError', {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Package mapping info */
type PackageMapping = {
  /** Source path (absolute) */
  source: string
  /** Target path at workspace root (absolute) */
  target: string
  /** Target name (symlink name at workspace root) */
  targetName: string
  /** Repo that declares this package */
  declaredBy: string
  /** Repo that contains the source */
  sourceRepo: string
}

/** Collect all package mappings from configs */
const collectPackageMappings = (
  workspaceRoot: string,
  configs: ConfigSource[],
): PackageMapping[] => {
  const mappings: PackageMapping[] = []

  for (const source of configs) {
    const sourceRepoName = source.isRoot ? null : path.basename(source.dir)

    for (const [repoName, config] of Object.entries(source.config.repos)) {
      if (!config.packages) continue

      for (const [packageName, packageConfig] of Object.entries(config.packages)) {
        // Source is the path within the repo
        const sourceFull = path.join(workspaceRoot, repoName, packageConfig.path)

        // Target uses the package name (key) as the symlink name
        const targetFull = path.join(workspaceRoot, packageName)

        mappings.push({
          source: sourceFull,
          target: targetFull,
          targetName: packageName,
          declaredBy: source.isRoot ? '(root)' : sourceRepoName!,
          sourceRepo: repoName,
        })
      }
    }
  }

  return mappings
}

/** Check for conflicts in package mappings */
const findConflicts = (mappings: PackageMapping[]): Map<string, PackageMapping[]> => {
  const byTarget = new Map<string, PackageMapping[]>()

  for (const mapping of mappings) {
    const existing = byTarget.get(mapping.targetName) ?? []
    existing.push(mapping)
    byTarget.set(mapping.targetName, existing)
  }

  // Return only those with conflicts
  const conflicts = new Map<string, PackageMapping[]>()
  for (const [targetName, sources] of byTarget) {
    if (sources.length > 1) {
      conflicts.set(targetName, sources)
    }
  }

  return conflicts
}

/** Get unique mappings (first one wins in case of conflicts) */
const getUniqueMappings = (mappings: PackageMapping[]): Map<string, PackageMapping> => {
  const uniqueMappings = new Map<string, PackageMapping>()
  for (const mapping of mappings) {
    if (!uniqueMappings.has(mapping.targetName)) {
      uniqueMappings.set(mapping.targetName, mapping)
    }
  }
  return uniqueMappings
}

/** Show status of all package mappings */
const linkStatusCommand = Cli.Command.make('status', {}, () =>
  Effect.gen(function* () {
    const cwd = yield* CurrentWorkingDirectory
    const fs = yield* FileSystem.FileSystem

    const workspaceRoot = yield* findWorkspaceRoot(cwd)

    yield* Effect.log(`dotdot workspace: ${workspaceRoot}`)
    yield* Effect.log('')

    const configs = yield* collectAllConfigs(workspaceRoot)
    const mappings = collectPackageMappings(workspaceRoot, configs)

    if (mappings.length === 0) {
      yield* Effect.log('No packages configurations found')
      return
    }

    // Check for conflicts
    const conflicts = findConflicts(mappings)
    if (conflicts.size > 0) {
      yield* Effect.log('Conflicts:')
      for (const [targetName, sources] of conflicts) {
        yield* Effect.log(`  ${targetName}:`)
        for (const source of sources) {
          yield* Effect.log(
            `    - ${source.sourceRepo}/${path.relative(path.join(workspaceRoot, source.sourceRepo), source.source)} (from ${source.declaredBy})`,
          )
        }
      }
      yield* Effect.log('')
    }

    yield* Effect.log('Package mappings:')

    const uniqueMappings = getUniqueMappings(mappings)

    for (const [targetName, mapping] of uniqueMappings) {
      const targetExists = yield* fs.exists(mapping.target)
      const sourceExists = yield* fs.exists(mapping.source)
      const relativePath = path.relative(workspaceRoot, mapping.source)

      let status: string
      if (!sourceExists) {
        status = 'source missing'
      } else if (!targetExists) {
        status = 'not linked'
      } else {
        // Use readLink to check if it's a symlink
        const isSymlink = yield* fs.readLink(mapping.target).pipe(
          Effect.map(() => true),
          Effect.catchAll(() => Effect.succeed(false)),
        )
        if (isSymlink) {
          status = 'linked'
        } else {
          status = 'blocked (not a symlink)'
        }
      }

      yield* Effect.log(`  ${targetName} -> ${relativePath} [${status}]`)
    }
  }).pipe(Effect.withSpan('dotdot/link/status')),
)

/** Create symlinks handler - extracted for reuse */
const createSymlinksHandler = ({ dryRun, force }: { dryRun: boolean; force: boolean }) =>
  Effect.gen(function* () {
    const cwd = yield* CurrentWorkingDirectory
    const fs = yield* FileSystem.FileSystem

    const workspaceRoot = yield* findWorkspaceRoot(cwd)

    yield* Effect.log(`dotdot workspace: ${workspaceRoot}`)
    yield* Effect.log('')

    const configs = yield* collectAllConfigs(workspaceRoot)
    const mappings = collectPackageMappings(workspaceRoot, configs)

    if (mappings.length === 0) {
      yield* Effect.log('No packages configurations found')
      return
    }

    // Check for conflicts
    const conflicts = findConflicts(mappings)
    if (conflicts.size > 0 && !force) {
      yield* Effect.log('Package conflicts detected:')
      yield* Effect.log('')

      for (const [targetName, sources] of conflicts) {
        yield* Effect.log(`  ${targetName}:`)
        for (const source of sources) {
          yield* Effect.log(
            `    - ${source.sourceRepo}/${path.relative(path.join(workspaceRoot, source.sourceRepo), source.source)} (from ${source.declaredBy})`,
          )
        }
      }

      yield* Effect.log('')
      yield* Effect.log('Use --force to overwrite with the first match')
      return
    }

    if (dryRun) {
      yield* Effect.log('Dry run - no changes will be made')
      yield* Effect.log('')
    }

    yield* Effect.log('Creating symlinks...')

    const created: string[] = []
    const skipped: string[] = []

    const uniqueMappings = getUniqueMappings(mappings)

    for (const [targetName, mapping] of uniqueMappings) {
      const sourceExists = yield* fs.exists(mapping.source)
      if (!sourceExists) {
        yield* Effect.log(`  Skipped: ${targetName} (source does not exist)`)
        skipped.push(targetName)
        continue
      }

      const targetExists = yield* fs.exists(mapping.target)
      if (targetExists) {
        if (force) {
          if (!dryRun) {
            yield* fs.remove(mapping.target)
          }
        } else {
          yield* Effect.log(`  Skipped: ${targetName} (target already exists)`)
          skipped.push(targetName)
          continue
        }
      }

      // Create parent directory if needed (for package names like @org/utils)
      const parentDir = path.dirname(mapping.target)
      if (parentDir !== workspaceRoot) {
        if (!dryRun) {
          yield* fs.makeDirectory(parentDir, { recursive: true })
        }
      }

      // Calculate relative path from symlink location to source
      const relativePath = path.relative(parentDir, mapping.source)

      if (dryRun) {
        yield* Effect.log(`  Would create: ${targetName} -> ${relativePath}`)
        created.push(targetName)
      } else {
        yield* fs.symlink(relativePath, mapping.target).pipe(
          Effect.mapError(
            (cause) =>
              new LinkError({
                path: mapping.target,
                message: `Failed to create symlink`,
                cause,
              }),
          ),
        )
        yield* Effect.log(`  Created: ${targetName} -> ${relativePath}`)
        created.push(targetName)
      }
    }

    yield* Effect.log('')

    const summary: string[] = []
    if (created.length > 0) summary.push(`${created.length} created`)
    if (skipped.length > 0) summary.push(`${skipped.length} skipped`)

    yield* Effect.log(`Done: ${summary.join(', ')}`)
  }).pipe(Effect.withSpan('dotdot/link/create'))

/** Create symlinks for all package mappings */
const linkCreateCommand = Cli.Command.make(
  'create',
  {
    dryRun: Cli.Options.boolean('dry-run').pipe(
      Cli.Options.withDescription('Show what would be done without making changes'),
      Cli.Options.withDefault(false),
    ),
    force: Cli.Options.boolean('force').pipe(
      Cli.Options.withDescription('Overwrite existing files/symlinks'),
      Cli.Options.withDefault(false),
    ),
  },
  createSymlinksHandler,
)

/** Remove symlinks handler - extracted for reuse */
const removeSymlinksHandler = ({ dryRun }: { dryRun: boolean }) =>
  Effect.gen(function* () {
    const cwd = yield* CurrentWorkingDirectory
    const fs = yield* FileSystem.FileSystem

    const workspaceRoot = yield* findWorkspaceRoot(cwd)

    yield* Effect.log(`dotdot workspace: ${workspaceRoot}`)
    yield* Effect.log('')

    const configs = yield* collectAllConfigs(workspaceRoot)
    const mappings = collectPackageMappings(workspaceRoot, configs)

    if (mappings.length === 0) {
      yield* Effect.log('No packages configurations found')
      return
    }

    if (dryRun) {
      yield* Effect.log('Dry run - no changes will be made')
      yield* Effect.log('')
    }

    yield* Effect.log('Removing symlinks...')

    const removed: string[] = []
    const skipped: string[] = []

    const seenTargets = new Set(mappings.map((m) => m.targetName))

    for (const targetName of seenTargets) {
      const targetPath = path.join(workspaceRoot, targetName)

      // Use readLink to check if it's a symlink (will fail if not a symlink)
      const isSymlink = yield* fs.readLink(targetPath).pipe(
        Effect.map(() => true),
        Effect.catchAll(() => Effect.succeed(false)),
      )

      if (!isSymlink) {
        const exists = yield* fs.exists(targetPath)
        if (exists) {
          yield* Effect.log(`  Skipped: ${targetName} (not a symlink)`)
        }
        skipped.push(targetName)
        continue
      }

      if (dryRun) {
        yield* Effect.log(`  Would remove: ${targetName}`)
        removed.push(targetName)
      } else {
        yield* fs.remove(targetPath)
        yield* Effect.log(`  Removed: ${targetName}`)
        removed.push(targetName)
      }
    }

    yield* Effect.log('')

    const summary: string[] = []
    if (removed.length > 0) summary.push(`${removed.length} removed`)
    if (skipped.length > 0) summary.push(`${skipped.length} skipped`)

    yield* Effect.log(`Done: ${summary.join(', ')}`)
  }).pipe(Effect.withSpan('dotdot/link/remove'))

/** Remove all symlinks created by packages config */
const linkRemoveCommand = Cli.Command.make(
  'remove',
  {
    dryRun: Cli.Options.boolean('dry-run').pipe(
      Cli.Options.withDescription('Show what would be done without making changes'),
      Cli.Options.withDefault(false),
    ),
  },
  removeSymlinksHandler,
)

/** Root link command - defaults to create behavior */
const linkRoot = Cli.Command.make(
  'link',
  {
    dryRun: Cli.Options.boolean('dry-run').pipe(
      Cli.Options.withDescription('Show what would be done without making changes'),
      Cli.Options.withDefault(false),
    ),
    force: Cli.Options.boolean('force').pipe(
      Cli.Options.withDescription('Overwrite existing files/symlinks'),
      Cli.Options.withDefault(false),
    ),
  },
  createSymlinksHandler,
)

/** Link command with subcommands: status, create, remove */
export const linkCommand = linkRoot.pipe(
  Cli.Command.withSubcommands([linkStatusCommand, linkCreateCommand, linkRemoveCommand]),
)

/** Exported subcommands for testing */
export const linkSubcommands = {
  status: { command: linkStatusCommand },
  create: { command: linkCreateCommand, handler: createSymlinksHandler },
  remove: { command: linkRemoveCommand, handler: removeSymlinksHandler },
}
