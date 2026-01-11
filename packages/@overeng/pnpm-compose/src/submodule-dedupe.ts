/**
 * Submodule deduplication logic for pnpm-compose.
 *
 * Detects duplicate git submodules across nested repos and symlinks them to a
 * single canonical checkout while configuring git to ignore these paths for
 * status/diff operations.
 */
import { Command, Error as PlatformError, FileSystem, Path } from '@effect/platform'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import { Effect, Option } from 'effect'

/** A submodule entry with its URL and path */
export interface SubmoduleEntry {
  /** Name of the submodule (from .gitmodules section) */
  name: string
  /** Path relative to the repo root */
  path: string
  /** Git URL of the submodule */
  url: string
  /** Absolute path to the repo containing this .gitmodules entry */
  repoRoot: string
}

/** A duplicate submodule detected across multiple repos */
export interface DuplicateSubmodule {
  /** Git URL identifying the submodule */
  url: string
  /** All locations where this submodule appears */
  locations: SubmoduleEntry[]
  /** The canonical location (prefer top-level) */
  canonical: SubmoduleEntry
}

/** Parse .gitmodules file including URL information */
export const parseGitmodulesWithUrl = (
  repoRoot: string,
): Effect.Effect<
  SubmoduleEntry[],
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const gitmodulesPath = `${repoRoot}/.gitmodules`

    const exists = yield* fs.exists(gitmodulesPath)
    if (!exists) {
      return []
    }

    const content = yield* fs.readFileString(gitmodulesPath)
    const submodules: SubmoduleEntry[] = []

    let currentName: string | undefined
    let currentPath: string | undefined
    let currentUrl: string | undefined

    const lines = content.split('\n')

    for (const line of lines) {
      const sectionMatch = line.match(/\[submodule\s+"([^"]+)"\]/)
      if (sectionMatch) {
        // Save previous entry if complete
        if (currentName && currentPath && currentUrl) {
          submodules.push({
            name: currentName,
            path: currentPath,
            url: normalizeSubmoduleUrl({
              url: currentUrl,
              repoRoot,
              path,
            }),
            repoRoot,
          })
        }
        currentName = sectionMatch[1]
        currentPath = undefined
        currentUrl = undefined
        continue
      }

      const pathMatch = line.match(/^\s*path\s*=\s*(.+)$/)
      if (pathMatch) {
        currentPath = pathMatch[1]!.trim()
        continue
      }

      const urlMatch = line.match(/^\s*url\s*=\s*(.+)$/)
      if (urlMatch) {
        currentUrl = urlMatch[1]!.trim()
        continue
      }
    }

    // Save last entry if complete
    if (currentName && currentPath && currentUrl) {
      submodules.push({
        name: currentName,
        path: currentPath,
        url: normalizeSubmoduleUrl({
          url: currentUrl,
          repoRoot,
          path,
        }),
        repoRoot,
      })
    }

    return submodules
  }).pipe(Effect.withSpan('parseGitmodulesWithUrl'))

/**
 * Normalize submodule URLs so local relative paths compare consistently.
 */
const normalizeSubmoduleUrl = ({
  url,
  repoRoot,
  path,
}: {
  url: string
  repoRoot: string
  path: Path.Path
}) => {
  const trimmed = url.trim()
  if (trimmed.includes('://') || trimmed.startsWith('git@') || /^[^/]+@[^:]+:.+/.test(trimmed)) {
    return trimmed
  }

  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed)
  }

  return path.normalize(path.resolve(repoRoot, trimmed))
}

/** Scan workspace for all .gitmodules files in nested repos */
export const findAllSubmodules = (
  workspaceRoot: string,
): Effect.Effect<
  SubmoduleEntry[],
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Parse top-level .gitmodules
    const topLevel = yield* parseGitmodulesWithUrl(workspaceRoot)
    const allSubmodules = [...topLevel]

    // Parse .gitmodules in each top-level submodule
    for (const sub of topLevel) {
      const submodulePath = `${workspaceRoot}/${sub.path}`
      const gitmodulesPath = `${submodulePath}/.gitmodules`

      // Check if nested .gitmodules exists
      const exists = yield* fs.exists(gitmodulesPath)
      if (!exists) continue

      const nested = yield* parseGitmodulesWithUrl(submodulePath)
      allSubmodules.push(...nested)
    }

    return allSubmodules
  }).pipe(Effect.withSpan('findAllSubmodules'))

/** Find duplicate submodules by URL */
export const findDuplicates = (submodules: SubmoduleEntry[]): DuplicateSubmodule[] => {
  const byUrl = new Map<string, SubmoduleEntry[]>()

  for (const sub of submodules) {
    const existing = byUrl.get(sub.url) ?? []
    existing.push(sub)
    byUrl.set(sub.url, existing)
  }

  const duplicates: DuplicateSubmodule[] = []

  for (const [url, locations] of byUrl) {
    if (locations.length <= 1) continue

    // Prefer top-level as canonical (shortest repoRoot path)
    const canonical = locations.reduce((a, b) => (a.repoRoot.length < b.repoRoot.length ? a : b))

    duplicates.push({ url, locations, canonical })
  }

  return duplicates
}

/**
 * Pick a canonical submodule location for a duplicate set.
 *
 * Prefers the shallowest repo root and avoids symlinked working trees when possible.
 */
export const pickCanonicalSubmodule = (
  duplicate: DuplicateSubmodule,
): Effect.Effect<SubmoduleEntry, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const locations = [...duplicate.locations].toSorted(
      (a, b) => a.repoRoot.length - b.repoRoot.length,
    )

    for (const loc of locations) {
      const candidatePath = path.join(loc.repoRoot, loc.path)
      const exists = yield* fs.exists(candidatePath)
      if (!exists) continue

      const linkTarget = yield* fs.readLink(candidatePath).pipe(Effect.option)
      if (Option.isNone(linkTarget)) {
        return loc
      }
    }

    return duplicate.canonical
  }).pipe(Effect.withSpan('pickCanonicalSubmodule'))

/**
 * Symlink a duplicate submodule to the canonical working tree.
 *
 * Also configures `submodule.<name>.ignore=all` locally to prevent git status/diff
 * from failing on symlinked submodule paths.
 */
export const updateSubmoduleWithSymlink = ({
  canonical,
  target,
}: {
  canonical: SubmoduleEntry
  target: SubmoduleEntry
}): Effect.Effect<
  void,
  PlatformError.PlatformError,
  CommandExecutor.CommandExecutor | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const targetPath = path.join(target.repoRoot, target.path)
    const canonicalPath = path.join(canonical.repoRoot, canonical.path)

    const canonicalExists = yield* fs.exists(canonicalPath)
    if (!canonicalExists) {
      return yield* Effect.die(`Canonical submodule missing at ${canonicalPath}`)
    }

    const existingLink = yield* fs.readLink(targetPath).pipe(Effect.option)
    if (Option.isSome(existingLink)) {
      const resolved = path.resolve(path.dirname(targetPath), existingLink.value)
      if (resolved === canonicalPath) {
        yield* setSubmoduleIgnoreAll({ repoRoot: target.repoRoot, submoduleName: target.name })
        return
      }
    }

    const targetExists = yield* fs.exists(targetPath)
    if (targetExists) {
      yield* fs.remove(targetPath, { recursive: true })
    }

    yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true })
    const relativeTarget = path.relative(path.dirname(targetPath), canonicalPath)
    yield* fs.symlink(relativeTarget, targetPath)

    yield* setSubmoduleIgnoreAll({ repoRoot: target.repoRoot, submoduleName: target.name })
  }).pipe(Effect.withSpan('updateSubmoduleWithSymlink'))

/**
 * Sync a submodule gitlink entry to the canonical HEAD without touching the working tree.
 */
export const syncSubmoduleGitlink = ({
  canonical,
  target,
}: {
  canonical: SubmoduleEntry
  target: SubmoduleEntry
}): Effect.Effect<void, PlatformError.PlatformError, CommandExecutor.CommandExecutor | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const canonicalPath = path.join(canonical.repoRoot, canonical.path)

    const canonicalHead = yield* Command.string(
      Command.make('git', 'rev-parse', 'HEAD').pipe(Command.workingDirectory(canonicalPath)),
    )

    const updateIndex = Command.make(
      'git',
      'update-index',
      '--cacheinfo',
      `160000,${canonicalHead.trim()},${target.path}`,
    ).pipe(Command.workingDirectory(target.repoRoot))

    yield* Command.exitCode(updateIndex).pipe(Effect.catchAll(() => Effect.void))
  }).pipe(Effect.withSpan('syncSubmoduleGitlink'))

/** Set `submodule.<name>.ignore=all` locally to suppress symlink errors in status/diff. */
const setSubmoduleIgnoreAll = ({
  repoRoot,
  submoduleName,
}: {
  repoRoot: string
  submoduleName: string
}) =>
  Effect.gen(function* () {
    const command = Command.make('git', 'config', `submodule.${submoduleName}.ignore`, 'all').pipe(
      Command.workingDirectory(repoRoot),
    )
    yield* Command.exitCode(command).pipe(Effect.catchAll(() => Effect.void))
  }).pipe(Effect.withSpan('setSubmoduleIgnoreAll'))

/** Remove submodule entry from .gitmodules file */
export const removeFromGitmodules = ({
  repoRoot,
  submodulePath,
}: {
  repoRoot: string
  submodulePath: string
}): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const gitmodulesPath = `${repoRoot}/.gitmodules`

    const exists = yield* fs.exists(gitmodulesPath)
    if (!exists) {
      return // No .gitmodules file
    }

    const content = yield* fs.readFileString(gitmodulesPath)
    const lines = content.split('\n')
    const newLines: string[] = []

    let inTargetSection = false
    let currentPath: string | undefined

    for (const line of lines) {
      // Check for submodule section start
      const sectionMatch = line.match(/\[submodule\s+"([^"]+)"\]/)
      if (sectionMatch) {
        // If we were in target section, don't add it
        inTargetSection = false
        currentPath = undefined
      }

      // Check for path in section
      const pathMatch = line.match(/^\s*path\s*=\s*(.+)$/)
      if (pathMatch) {
        currentPath = pathMatch[1]!.trim()
        if (currentPath === submodulePath) {
          inTargetSection = true
          // Remove the section header line too (go back and remove it)
          if (newLines.length > 0 && newLines[newLines.length - 1]?.includes('[submodule')) {
            newLines.pop()
          }
        }
      }

      // Add line if not in target section
      if (!inTargetSection) {
        newLines.push(line)
      }
    }

    yield* fs.writeFileString(gitmodulesPath, newLines.join('\n'))
  }).pipe(Effect.withSpan('removeFromGitmodules'))

/** Unregister submodule from git index */
export const unregisterSubmodule = ({
  repoRoot,
  submodulePath,
}: {
  repoRoot: string
  submodulePath: string
}): Effect.Effect<void, PlatformError.PlatformError, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    // Use git rm --cached to unregister the submodule from git's index
    const command = Command.make('git', 'rm', '--cached', submodulePath).pipe(
      Command.workingDirectory(repoRoot),
    )

    // Run command and ignore errors (submodule might not be registered)
    yield* Command.exitCode(command).pipe(Effect.catchAll(() => Effect.void))
  }).pipe(Effect.withSpan('unregisterSubmodule'))
