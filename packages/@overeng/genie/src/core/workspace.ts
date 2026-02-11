import { FileSystem, Path } from '@effect/platform'
import { Effect } from 'effect'

import { matchesAnyPattern } from '../runtime/package-json/validation.ts'
import { GenieNotImplementedError } from './errors.ts'
import type { WorkspaceProvider, WorkspaceProviderName } from './package-json-context.ts'

const DEFAULT_SKIP_DIRS = new Set([
  'node_modules',
  '.pnpm',
  '.pnpm-store',
  '.git',
  '.direnv',
  '.devenv',
  'dist',
  'tmp',
  'result',
  'repos',
])

const shouldSkipDir = (name: string): boolean => DEFAULT_SKIP_DIRS.has(name)

const normalizePath = (input: string): string => input.replace(/\\/g, '/')

const findFiles = Effect.fn('workspace/findFiles')(function* ({
  root,
  fileName,
}: {
  root: string
  fileName: string
}) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const results: string[] = []

  const walk: (dir: string) => Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path> =
    Effect.fnUntraced(function* (dir) {
      const entries = yield* fs.readDirectory(dir).pipe(Effect.catchAll(() => Effect.succeed([])))
      for (const entry of entries) {
        if (shouldSkipDir(entry)) continue
        const fullPath = pathService.join(dir, entry)
        const stat = yield* fs.stat(fullPath).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
        if (!stat) continue
        if (stat.type === 'Directory') {
          yield* walk(fullPath)
          continue
        }
        if (entry === fileName) {
          results.push(fullPath)
        }
      }
    })

  yield* walk(root)
  return results
})

const findPackageJsonDirs = Effect.fn('workspace/findPackageJsonDirs')(function* ({
  root,
}: {
  root: string
}) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const results: string[] = []

  const walk: (dir: string) => Effect.Effect<void, Error, FileSystem.FileSystem | Path.Path> =
    Effect.fnUntraced(function* (dir) {
      const entries = yield* fs.readDirectory(dir).pipe(Effect.catchAll(() => Effect.succeed([])))
      for (const entry of entries) {
        if (shouldSkipDir(entry)) continue
        const fullPath = pathService.join(dir, entry)
        const stat = yield* fs.stat(fullPath).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
        if (!stat) continue
        if (stat.type === 'Directory') {
          yield* walk(fullPath)
          continue
        }
        if (entry === 'package.json') {
          results.push(pathService.dirname(fullPath))
        }
      }
    })

  yield* walk(root)
  return results
})

const parsePnpmWorkspacePackages = (content: string): string[] => {
  const lines = content.split(/\r?\n/)
  const patterns: string[] = []
  let inPackages = false
  let packagesIndent = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    if (!inPackages) {
      if (/^\s*packages\s*:/.test(line)) {
        inPackages = true
        packagesIndent = line.indexOf('p')
      }
      continue
    }

    const listMatch = line.match(/^(\s*)-\s*(.+)$/)
    if (!listMatch) {
      if (line.search(/\S/) <= packagesIndent) break
      continue
    }

    if (listMatch[2] === undefined) continue
    const rawValue = listMatch[2].trim()
    const unquoted = rawValue.replace(/^['"]|['"]$/g, '')
    patterns.push(unquoted)
  }

  return patterns
}

const discoverPnpmPackageJsonPaths = Effect.fn('workspace/discoverPnpmPackageJsonPaths')(
  function* ({ cwd }: { cwd: string }) {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    const workspaceFiles = yield* findFiles({ root: cwd, fileName: 'pnpm-workspace.yaml' })
    if (workspaceFiles.length === 0) return []

    const packageDirs = yield* findPackageJsonDirs({ root: cwd })
    const matched = new Set<string>()

    for (const workspaceFile of workspaceFiles) {
      const workspaceDir = pathService.dirname(workspaceFile)
      const content = yield* fs
        .readFileString(workspaceFile)
        .pipe(Effect.catchAll(() => Effect.succeed('')))
      const patterns = parsePnpmWorkspacePackages(content)
      if (patterns.length === 0) continue

      for (const packageDir of packageDirs) {
        const relPath = normalizePath(pathService.relative(workspaceDir, packageDir)) || '.'
        if (matchesAnyPattern({ name: relPath, patterns })) {
          matched.add(pathService.join(packageDir, 'package.json'))
        }
      }
    }

    return Array.from(matched)
  },
)

const discoverManualPackageJsonPaths = Effect.fn('workspace/discoverManualPackageJsonPaths')(
  function* ({ cwd }: { cwd: string }) {
    const pathService = yield* Path.Path
    const packageDirs = yield* findPackageJsonDirs({ root: cwd })
    return packageDirs.map((dir) => pathService.join(dir, 'package.json'))
  },
)

const createProvider = ({
  name,
  discover,
}: {
  name: WorkspaceProviderName
  discover: WorkspaceProvider['discoverPackageJsonPaths']
}) => ({
  name,
  discoverPackageJsonPaths: discover,
})

/** Detect the workspace package manager (pnpm, bun, manual) and return the matching provider. */
export const resolveWorkspaceProvider = Effect.fn('workspace/resolveWorkspaceProvider')(function* ({
  cwd,
}: {
  cwd: string
}) {
  const providerName = (process.env.GENIE_WORKSPACE_PROVIDER ?? '').toLowerCase()

  if (providerName === 'bun') {
    return createProvider({
      name: 'bun',
      discover: () =>
        Effect.fail(
          new GenieNotImplementedError({
            message: 'Bun workspace provider is not implemented yet.',
          }),
        ),
    })
  }
  if (providerName === 'manual') {
    return createProvider({
      name: 'manual',
      discover: ({ cwd: root }) => discoverManualPackageJsonPaths({ cwd: root }),
    })
  }
  if (providerName === 'pnpm') {
    return createProvider({
      name: 'pnpm',
      discover: ({ cwd: root }) => discoverPnpmPackageJsonPaths({ cwd: root }),
    })
  }

  const pnpmWorkspaceFiles = yield* findFiles({ root: cwd, fileName: 'pnpm-workspace.yaml' })
  if (pnpmWorkspaceFiles.length > 0) {
    return createProvider({
      name: 'pnpm',
      discover: ({ cwd: root }) => discoverPnpmPackageJsonPaths({ cwd: root }),
    })
  }

  return createProvider({
    name: 'manual',
    discover: ({ cwd: root }) => discoverManualPackageJsonPaths({ cwd: root }),
  })
})
