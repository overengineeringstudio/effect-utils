import { Effect, FileSystem, Path } from 'effect'

import { matchesAnyPattern } from '../runtime/package-json/validation.ts'
import { GenieNotImplementedError } from './errors.ts'
import * as Observability from './observability.ts'
import type { WorkspaceProvider, WorkspaceProviderName } from './package-json-context.ts'

const DEFAULT_SKIP_DIRS = new Set([
  'node_modules',
  '.pnpm',
  '.pnpm-store',
  '.git',
  '.devenv',
  'dist',
  'tmp',
  'result',
  'repos',
])

const shouldSkipDir = (name: string): boolean => DEFAULT_SKIP_DIRS.has(name)

const normalizePath = (input: string): string => input.replace(/\\/g, '/')

const findWorkspaceRoot = Effect.fn('workspace/findWorkspaceRoot')(function* ({
  cwd,
}: {
  cwd: string
}) {
  yield* Observability.annotatePath({ label: 'workspace-root', path: cwd })
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path

  let currentDir = cwd
  while (true) {
    const workspaceFile = pathService.join(currentDir, 'pnpm-workspace.yaml')
    const stat = yield* fs.stat(workspaceFile).pipe(Effect.catch(() => Effect.void))
    if (stat?.type === 'File') {
      return currentDir
    }

    const parentDir = pathService.dirname(currentDir)
    if (parentDir === currentDir) {
      return undefined
    }

    currentDir = parentDir
  }
})

/** Directory listings are I/O bound, so the few levels a pattern needs are listed in parallel. */
const LISTING_CONCURRENCY = 32

/**
 * A workspace pattern reduced to the filesystem work it needs: the leading literal segments,
 * which are joined without touching the disk, plus the number of directory-listing levels that
 * follow (`'any'` when the pattern contains `**`).
 */
type PatternPlan = {
  readonly prefix: ReadonlyArray<string>
  readonly levels: number | 'any'
}

/**
 * The cost model of discovery: a pattern's plan says how many directory listings it takes to
 * resolve. `undefined` when the pattern names a skipped directory and is therefore unreachable.
 */
export const planPattern = (pattern: string): PatternPlan | undefined => {
  const segments = normalizePath(pattern)
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
  const firstGlob = segments.findIndex((segment) => segment.includes('*') === true)
  const prefix = firstGlob === -1 ? segments : segments.slice(0, firstGlob)
  if (prefix.some((segment) => shouldSkipDir(segment) === true) === true) return undefined
  if (firstGlob === -1) return { prefix, levels: 0 }
  const rest = segments.slice(firstGlob)
  if (rest.some((segment) => segment.includes('**') === true) === true)
    return { prefix, levels: 'any' }
  return { prefix, levels: rest.length }
}

/**
 * One listing level: the non-skipped entries of every directory in `dirs`, plus the directories
 * among them that hold a `package.json`. Both answers come out of the same `readDirectory`, so
 * neither directory-ness nor manifest presence costs an extra `stat`.
 */
const listLevel = Effect.fnUntraced(function* (dirs: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path

  const listings = yield* Effect.forEach(
    dirs,
    (dir) =>
      // A file, or a path that does not exist, simply has no entries.
      fs.readDirectory(dir).pipe(
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
        Effect.map((entries) => ({ dir, entries })),
      ),
    { concurrency: LISTING_CONCURRENCY },
  )

  return {
    children: listings.flatMap(({ dir, entries }) =>
      entries
        .filter((entry) => shouldSkipDir(entry) === false)
        .map((entry) => pathService.join(dir, entry)),
    ),
    packageDirs: listings
      .filter(({ entries }) => entries.includes('package.json') === true)
      .map(({ dir }) => dir),
  }
})

/**
 * Directories a pattern could name that hold a `package.json`. A superset of the pattern's
 * matches — `*` levels list siblings the pattern may reject — so the caller still matches.
 */
const expandPlan = Effect.fnUntraced(function* (root: string, plan: PatternPlan) {
  const pathService = yield* Path.Path
  const start = plan.prefix.length === 0 ? root : pathService.join(root, ...plan.prefix)

  if (plan.levels === 'any') {
    const packageDirs: string[] = []
    let frontier: ReadonlyArray<string> = [start]
    while (frontier.length > 0) {
      const level = yield* listLevel(frontier)
      packageDirs.push(...level.packageDirs)
      frontier = level.children
    }
    return packageDirs
  }

  let frontier: ReadonlyArray<string> = [start]
  for (let level = 0; level < plan.levels; level++) {
    frontier = (yield* listLevel(frontier)).children
  }
  return (yield* listLevel(frontier)).packageDirs
})

const parsePnpmWorkspacePackages = (content: string): string[] => {
  const lines = content.split(/\r?\n/)
  const patterns: string[] = []
  let inPackages = false
  let packagesIndent = 0

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') === true) continue

    if (inPackages === false) {
      if (/^\s*packages\s*:/.test(line) === true) {
        inPackages = true
        packagesIndent = line.indexOf('p')
      }
      continue
    }

    const listMatch = line.match(/^(\s*)-\s*(.+)$/)
    if (listMatch === null) {
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
    yield* Observability.annotatePath({ label: 'pnpm', path: cwd })
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    const workspaceRoot = yield* findWorkspaceRoot({ cwd })
    if (workspaceRoot === undefined) return []

    const workspaceFile = pathService.join(workspaceRoot, 'pnpm-workspace.yaml')
    const content = yield* fs.readFileString(workspaceFile).pipe(Effect.orElseSucceed(() => ''))
    const patterns = parsePnpmWorkspacePackages(content)
    if (patterns.length === 0) return []

    // Discovery is `pnpm-workspace.yaml` composed with the directories its patterns can name, so
    // only those are listed — never the whole tree.
    const packageDirs = new Set<string>()
    for (const pattern of patterns) {
      const plan = planPattern(pattern)
      if (plan === undefined) continue
      for (const packageDir of yield* expandPlan(workspaceRoot, plan)) packageDirs.add(packageDir)
    }

    return Array.from(packageDirs)
      .filter((packageDir) => {
        const relPath = normalizePath(pathService.relative(workspaceRoot, packageDir)) || '.'
        return matchesAnyPattern({ name: relPath, patterns }) === true
      })
      .map((packageDir) => pathService.join(packageDir, 'package.json'))
      .toSorted()
  },
)

const discoverManualPackageJsonPaths = Effect.fn('workspace/discoverManualPackageJsonPaths')(
  function* ({ cwd }: { cwd: string }) {
    yield* Observability.annotatePath({ label: 'manual', path: cwd })
    const pathService = yield* Path.Path
    // No manifest declares the package set here, so every non-skipped directory is a candidate.
    const packageDirs = yield* expandPlan(cwd, { prefix: [], levels: 'any' })
    return packageDirs.map((packageDir) => pathService.join(packageDir, 'package.json')).toSorted()
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
  yield* Observability.annotatePath({ label: 'provider', path: cwd })
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

  const workspaceRoot = yield* findWorkspaceRoot({ cwd })
  if (workspaceRoot !== undefined) {
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
