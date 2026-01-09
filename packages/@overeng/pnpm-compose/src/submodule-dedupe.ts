/**
 * Submodule deduplication logic for pnpm-compose.
 *
 * Detects duplicate git submodules across nested repos and uses git alternates
 * to deduplicate objects while keeping real submodule directories.
 */
import { Command, FileSystem, Path } from '@effect/platform'
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

/**
 * Ensure duplicate submodule uses git alternates from the canonical copy.
 *
 * Handles two cases:
 * - gitlink entry exists: use `git submodule update --reference` to share objects
 * - gitlink missing: clone a local copy and exclude it from git tracking
 */
export const updateSubmoduleWithReference = ({
  duplicate,
  target,
}: {
  duplicate: DuplicateSubmodule
  target: SubmoduleEntry
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const targetPath = path.join(target.repoRoot, target.path)
    const canonicalPath = path.join(duplicate.canonical.repoRoot, duplicate.canonical.path)

    const linkTarget = yield* fs.readLink(targetPath).pipe(Effect.option)
    if (Option.isSome(linkTarget)) {
      yield* fs.remove(targetPath, { recursive: true })
    }

    /** Use git index to detect whether the path is a tracked submodule (gitlink). */
    const gitlinkCheck = Command.make('git', 'ls-files', '--stage', '--', target.path).pipe(
      Command.workingDirectory(target.repoRoot),
    )
    const gitlinkOutput = yield* Command.string(gitlinkCheck).pipe(
      Effect.catchAll(() => Effect.succeed('')),
    )
    const isGitlink = gitlinkOutput.split('\n').some((line) => line.startsWith('160000 '))

    if (!isGitlink) {
      /** Repo declares the submodule in .gitmodules but doesn't track a gitlink. */
      const targetGitExists = yield* fs.exists(path.join(targetPath, '.git'))
      if (!targetGitExists) {
        const targetExists = yield* fs.exists(targetPath)
        if (!targetExists) {
          yield* fs.makeDirectory(path.dirname(targetPath), { recursive: true })
          const cloneCommand = Command.make(
            'git',
            '-c',
            'protocol.file.allow=always',
            'clone',
            '--reference',
            canonicalPath,
            '--no-checkout',
            canonicalPath,
            targetPath,
          ).pipe(Command.workingDirectory(target.repoRoot))
          yield* Command.string(cloneCommand)

          const canonicalHead = yield* Command.string(
            Command.make('git', 'rev-parse', 'HEAD').pipe(Command.workingDirectory(canonicalPath)),
          )
          yield* Command.string(
            Command.make('git', 'checkout', canonicalHead.trim()).pipe(
              Command.workingDirectory(targetPath),
            ),
          )
        } else {
          yield* addToGitExclude({ repoRoot: target.repoRoot, submodulePath: target.path })
          return
        }
      }

      yield* addToGitExclude({ repoRoot: target.repoRoot, submodulePath: target.path })
    } else {
      /**
       * Use `--reference` to ensure the alternates link is created.
       * `--reference-if-able` is not accepted by `git submodule update`.
       */
      const command = Command.make(
        'git',
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'update',
        '--init',
        '--force',
        '--reference',
        canonicalPath,
        target.path,
      ).pipe(Command.workingDirectory(target.repoRoot))

      yield* Command.string(command)
    }

    const targetGitDir = yield* resolveGitDir(targetPath)
    const canonicalGitDir = yield* resolveGitDir(canonicalPath)
    const targetAlternatesPath = path.join(targetGitDir, 'objects', 'info', 'alternates')
    const canonicalObjectsPath = path.join(canonicalGitDir, 'objects')

    yield* fs.makeDirectory(path.dirname(targetAlternatesPath), { recursive: true })
    const existingAlternates = yield* fs.readFileString(targetAlternatesPath).pipe(Effect.option)
    const existingLines = Option.getOrElse(existingAlternates, () => '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)

    if (!existingLines.includes(canonicalObjectsPath)) {
      const newContent = [...existingLines, canonicalObjectsPath].join('\n') + '\n'
      yield* fs.writeFileString(targetAlternatesPath, newContent)
    }
  }).pipe(Effect.withSpan('updateSubmoduleWithReference'))

/** Resolve actual git directory path (handles both regular repos and submodules) */
const resolveGitDir = (repoRoot: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const gitPath = path.join(repoRoot, '.git')

    const stat = yield* fs.stat(gitPath)

    // If .git is a directory, use it directly
    if (stat.type === 'Directory') {
      return gitPath
    }

    // If .git is a file (gitlink in submodule), parse it to find actual git dir
    const gitlinkContent = yield* fs.readFileString(gitPath)
    const gitdirMatch = gitlinkContent.match(/^gitdir:\s*(.+)$/m)

    if (!gitdirMatch) {
      return yield* Effect.die(`Invalid gitlink file at ${gitPath}`)
    }

    const relativePath = gitdirMatch[1]
    if (!relativePath) {
      return yield* Effect.die(`Invalid gitlink file at ${gitPath}`)
    }

    return path.resolve(repoRoot, relativePath.trim())
  }).pipe(Effect.withSpan('resolveGitDir'))

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
    const path = yield* Path.Path

    const gitDir = yield* resolveGitDir(repoRoot)
    const excludePath = path.join(gitDir, 'info', 'exclude')

    // Ensure .git/info directory exists
    yield* fs.makeDirectory(path.join(gitDir, 'info'), { recursive: true })

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

/** Remove submodule entry from .gitmodules file */
export const removeFromGitmodules = ({
  repoRoot,
  submodulePath,
}: {
  repoRoot: string
  submodulePath: string
}) =>
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
}) =>
  Effect.gen(function* () {
    // Use git rm --cached to unregister the submodule from git's index
    const command = Command.make('git', 'rm', '--cached', submodulePath).pipe(
      Command.workingDirectory(repoRoot),
    )

    // Run command and ignore errors (submodule might not be registered)
    yield* Command.exitCode(command).pipe(Effect.catchAll(() => Effect.void))
  }).pipe(Effect.withSpan('unregisterSubmodule'))
