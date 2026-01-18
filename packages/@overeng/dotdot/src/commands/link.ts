/**
 * Symlink management helpers
 *
 * Internal module for managing package symlinks. Used by sync and status commands.
 */

import path from 'node:path'

import { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

import type { PackageIndexEntry } from '../lib/mod.ts'

/** Error during link operation */
export class LinkError extends Schema.TaggedError<LinkError>()('LinkError', {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

/** Package mapping info */
export type PackageMapping = {
  /** Source path (absolute) */
  source: string
  /** Target path at workspace root (absolute) */
  target: string
  /** Target name (symlink name at workspace root) */
  targetName: string
  /** Repo that contains the source */
  sourceRepo: string
}

/** Symlink status */
export type SymlinkStatus = 'linked' | 'not-linked' | 'blocked' | 'source-missing'

/** Collect all package mappings from root config packages index */
export const collectPackageMappings = ({
  workspaceRoot,
  packages,
}: {
  workspaceRoot: string
  packages: Record<string, PackageIndexEntry>
}): PackageMapping[] => {
  const mappings: PackageMapping[] = []

  for (const [packageName, pkgConfig] of Object.entries(packages)) {
    // Source is the path within the repo
    const sourceFull = path.join(workspaceRoot, pkgConfig.repo, pkgConfig.path)

    // Target uses the package name (key) as the symlink name
    const targetFull = path.join(workspaceRoot, packageName)

    mappings.push({
      source: sourceFull,
      target: targetFull,
      targetName: packageName,
      sourceRepo: pkgConfig.repo,
    })
  }

  return mappings
}

/** Check for conflicts in package mappings (different sources for same target) */
export const findConflicts = (mappings: PackageMapping[]): Map<string, PackageMapping[]> => {
  const byTarget = new Map<string, PackageMapping[]>()

  for (const mapping of mappings) {
    const existing = byTarget.get(mapping.targetName) ?? []
    existing.push(mapping)
    byTarget.set(mapping.targetName, existing)
  }

  // Return only those with actual conflicts (different source paths)
  // Duplicates (same source path) are not conflicts
  const conflicts = new Map<string, PackageMapping[]>()
  for (const [targetName, sources] of byTarget) {
    if (sources.length > 1) {
      // Check if all sources point to the same path
      const uniqueSources = new Set(sources.map((s) => s.source))
      if (uniqueSources.size > 1) {
        conflicts.set(targetName, sources)
      }
    }
  }

  return conflicts
}

/** Get unique mappings (first one wins in case of conflicts) */
export const getUniqueMappings = (mappings: PackageMapping[]): Map<string, PackageMapping> => {
  const uniqueMappings = new Map<string, PackageMapping>()
  for (const mapping of mappings) {
    if (!uniqueMappings.has(mapping.targetName)) {
      uniqueMappings.set(mapping.targetName, mapping)
    }
  }
  return uniqueMappings
}

/** Get symlink status for a package mapping */
export const getSymlinkStatus = Effect.fnUntraced(function* (mapping: PackageMapping) {
  const fs = yield* FileSystem.FileSystem

  const sourceExists = yield* fs.exists(mapping.source)
  if (!sourceExists) {
    return 'source-missing' as const
  }

  const targetExists = yield* fs.exists(mapping.target)
  if (!targetExists) {
    return 'not-linked' as const
  }

  // Check if it's a symlink
  const isSymlink = yield* fs.readLink(mapping.target).pipe(
    Effect.map(() => true),
    Effect.catchAll(() => Effect.succeed(false)),
  )

  return isSymlink ? ('linked' as const) : ('blocked' as const)
})

/** Result of syncing symlinks */
export type SyncSymlinksResult = {
  created: string[]
  skipped: string[]
  overwritten: string[]
  conflicts: Map<string, PackageMapping[]>
}

/** Sync symlinks for packages - create/update symlinks based on packages config */
export const syncSymlinks = Effect.fn('dotdot/syncSymlinks')(function* ({
  workspaceRoot,
  packages,
  dryRun,
  force,
}: {
  workspaceRoot: string
  packages: Record<string, PackageIndexEntry>
  dryRun: boolean
  force: boolean
}) {
  const fs = yield* FileSystem.FileSystem

  const mappings = collectPackageMappings({ workspaceRoot, packages })
  const conflicts = findConflicts(mappings)

  const result: SyncSymlinksResult = {
    created: [],
    skipped: [],
    overwritten: [],
    conflicts,
  }

  // If there are conflicts and not forcing, just report them
  if (conflicts.size > 0 && !force) {
    return result
  }

  const uniqueMappings = getUniqueMappings(mappings)

  for (const [targetName, mapping] of uniqueMappings) {
    const sourceExists = yield* fs.exists(mapping.source)
    if (!sourceExists) {
      result.skipped.push(targetName)
      continue
    }

    const targetExists = yield* fs.exists(mapping.target)
    if (targetExists) {
      if (force) {
        if (!dryRun) {
          yield* fs.remove(mapping.target)
        }
        result.overwritten.push(targetName)
      } else {
        // Check if it's already correctly linked
        const linkTarget = yield* fs
          .readLink(mapping.target)
          .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
        const parentDir = path.dirname(mapping.target)
        const expectedRelPath = path.relative(parentDir, mapping.source)

        if (linkTarget === expectedRelPath) {
          // Already correctly linked, skip
          continue
        }
        result.skipped.push(targetName)
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

    if (!dryRun) {
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
    }

    if (!result.overwritten.includes(targetName)) {
      result.created.push(targetName)
    }
  }

  return result
})

/** Result of pruning stale symlinks */
export type PruneSymlinksResult = {
  removed: string[]
  skipped: string[]
}

/** Prune stale symlinks - remove symlinks that are not in current packages config */
export const pruneStaleSymlinks = Effect.fn('dotdot/pruneStaleSymlinks')(function* ({
  workspaceRoot,
  packages,
  dryRun,
}: {
  workspaceRoot: string
  packages: Record<string, PackageIndexEntry>
  dryRun: boolean
}) {
  const fs = yield* FileSystem.FileSystem

  const result: PruneSymlinksResult = {
    removed: [],
    skipped: [],
  }

  // Get current package target names
  const currentTargets = new Set(Object.keys(packages))

  // Scan workspace root for symlinks
  const entries = yield* fs.readDirectory(workspaceRoot)

  for (const entry of entries) {
    // Skip hidden files and directories
    if (entry.startsWith('.')) continue

    const entryPath = path.join(workspaceRoot, entry)

    // Check if it's a symlink
    const linkTarget = yield* fs
      .readLink(entryPath)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)))

    if (!linkTarget) {
      // Not a symlink, check if it's a directory that might contain scoped packages
      if (entry.startsWith('@')) {
        // Scoped package directory - check contents
        const scopedEntries = yield* fs
          .readDirectory(entryPath)
          .pipe(Effect.catchAll(() => Effect.succeed([] as string[])))

        for (const scopedEntry of scopedEntries) {
          const scopedPath = path.join(entryPath, scopedEntry)
          const scopedName = `${entry}/${scopedEntry}`

          const scopedLinkTarget = yield* fs
            .readLink(scopedPath)
            .pipe(Effect.catchAll(() => Effect.succeed(undefined)))

          if (scopedLinkTarget && !currentTargets.has(scopedName)) {
            // Stale scoped symlink
            if (!dryRun) {
              yield* fs.remove(scopedPath)
            }
            result.removed.push(scopedName)
          }
        }

        // Clean up empty scoped directories
        const remainingEntries = yield* fs
          .readDirectory(entryPath)
          .pipe(Effect.catchAll(() => Effect.succeed([] as string[])))
        if (remainingEntries.length === 0 && !dryRun) {
          yield* fs.remove(entryPath)
        }
      }
      continue
    }

    // It's a symlink at workspace root - check if it's stale
    if (!currentTargets.has(entry)) {
      if (!dryRun) {
        yield* fs.remove(entryPath)
      }
      result.removed.push(entry)
    }
  }

  return result
})
