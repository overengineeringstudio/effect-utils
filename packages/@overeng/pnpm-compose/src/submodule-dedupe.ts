/**
 * Submodule deduplication logic for pnpm-compose.
 *
 * Detects duplicate git submodules across nested repos and creates symlinks
 * to deduplicate them, preferring the top-level copy.
 */
import { FileSystem, Path } from '@effect/platform'
import { Effect } from 'effect'

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
export const parseGitmodulesWithUrl = (repoRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
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
            url: currentUrl,
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
        url: currentUrl,
        repoRoot,
      })
    }

    return submodules
  }).pipe(Effect.withSpan('parseGitmodulesWithUrl'))

/** Scan workspace for all .gitmodules files in nested repos */
export const findAllSubmodules = (workspaceRoot: string) =>
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

/** Create symlink for a nested submodule pointing to canonical location */
export const createSubmoduleSymlink = ({
  duplicate,
  target,
}: {
  duplicate: DuplicateSubmodule
  target: SubmoduleEntry
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const symlinkPath = `${target.repoRoot}/${target.path}`
    const canonicalPath = `${duplicate.canonical.repoRoot}/${duplicate.canonical.path}`

    // Calculate relative path from symlink to target
    const relativePath = path.relative(path.dirname(symlinkPath), canonicalPath)

    // Remove existing directory if it exists (may be real submodule clone)
    // Use catchAll to handle ENOENT gracefully
    yield* fs.remove(symlinkPath, { recursive: true }).pipe(Effect.catchAll(() => Effect.void))

    // Create parent directory if needed
    yield* fs.makeDirectory(path.dirname(symlinkPath), { recursive: true })

    // Create symlink
    yield* fs.symlink(relativePath, symlinkPath)
  }).pipe(Effect.withSpan('createSubmoduleSymlink'))

/** Add symlink path to .git/info/exclude (local gitignore) */
export const addToGitExclude = ({
  repoRoot,
  submodulePath,
}: {
  repoRoot: string
  submodulePath: string
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const excludePath = `${repoRoot}/.git/info/exclude`

    // Ensure .git/info directory exists
    yield* fs.makeDirectory(`${repoRoot}/.git/info`, { recursive: true })

    // Read existing exclude file if it exists
    const exists = yield* fs.exists(excludePath)
    const content = exists ? yield* fs.readFileString(excludePath) : ''

    // Check if path already excluded
    const lines = content.split('\n')
    if (lines.some((line) => line.trim() === submodulePath)) {
      return // Already excluded
    }

    // Add path to exclude
    const newContent = `${content.trim()}\n\n# Submodule symlink managed by pnpm-compose\n${submodulePath}\n`

    yield* fs.writeFileString(excludePath, newContent)
  }).pipe(Effect.withSpan('addToGitExclude'))
