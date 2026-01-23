import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { type Error as PlatformError, FileSystem, Path } from '@effect/platform'
import { Effect } from 'effect'

import { resolveImportMapSpecifierForImporterSync } from './import-map/mod.ts'
import type { StatResult } from './types.ts'

let importMapResolverRegistered = false

/** Detect if we're running as a compiled Bun binary (bunfs paths indicate compiled binary) */
const isCompiledBinary = (): boolean => {
  try {
    return process.argv[1]?.includes('/$bunfs/') ?? false
  } catch {
    return false
  }
}

/** Normalize Bun importer paths to absolute filesystem paths when possible. */
const normalizeImporterPath = (importer: string): string | undefined => {
  if (importer.startsWith('file://')) {
    return fileURLToPath(importer)
  }

  if (importer.startsWith('data:')) {
    return undefined
  }

  if (!path.isAbsolute(importer)) {
    return undefined
  }

  return importer
}

type BunResolveArgs = {
  importer: string
  path: string
}

type BunResolveResult = { path: string } | undefined

type BunPluginBuilder = {
  onResolve: (
    options: { filter: RegExp },
    handler: (args: BunResolveArgs) => BunResolveResult,
  ) => void
}

/**
 * Register a Bun import resolver so `#...` specifiers use the import map closest
 * to the importing file. This avoids temp file generation and fixes transitive imports.
 *
 * Note: In compiled Bun binaries, the Bun.plugin API causes class identity mismatches
 * with Bun internals (ResolveMessage instanceof checks fail). We skip plugin registration
 * entirely in compiled binaries - files using `#...` imports need to be run with `bun run`.
 */
export const ensureImportMapResolver = Effect.sync(() => {
  if (importMapResolverRegistered) return
  importMapResolverRegistered = true

  // Skip Bun.plugin in compiled binaries to avoid ResolveMessage class identity issues
  if (isCompiledBinary()) return

  Bun.plugin({
    name: 'genie-import-map',
    // Bun type definitions are not guaranteed inside Nix builds, so we keep a local shape.
    setup: (builder: BunPluginBuilder) => {
      builder.onResolve({ filter: /^#/ }, (args: BunResolveArgs) => {
        // Bun resolver hooks can't await promises, so import map resolution is sync.
        const importerPath = normalizeImporterPath(args.importer)
        if (importerPath === undefined) {
          return undefined
        }

        const resolved = resolveImportMapSpecifierForImporterSync({
          specifier: args.path,
          importerPath,
        })

        if (resolved === undefined) return undefined

        return { path: resolved }
      })
    },
  })
}).pipe(Effect.withSpan('genie.registerImportMapResolver'))

/** Directories to skip when searching for .genie.ts files */
const shouldSkipDirectory = (name: string): boolean => {
  if (name === 'node_modules' || name === 'dist' || name === 'tmp') return true
  if (name === '.git' || name === '.devenv' || name === '.direnv') return true
  // Megarepo member root (symlinked peer repos).
  if (name === 'repos') return true
  // Nix build output symlink (points to /nix/store/...)
  if (name === 'result') return true
  return false
}

/** Check if a filename is a genie template file (*.genie.ts) */
export const isGenieFile = (file: string): boolean => file.endsWith('.genie.ts')

/**
 * Find all .genie.ts files under a root directory.
 *
 * Implementation notes:
 * - We resolve the root path once and use it as a boundary so that
 *   symlinked submodule duplicates pointing back into the root are skipped.
 * - This keeps output stable when symlinks are used to dedupe submodules,
 *   avoiding double generation and racey writes/chmod.
 */
export const findGenieFiles = Effect.fn('discovery/findGenieFiles')(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const warnings: string[] = []
  // Prefer the canonical root when available; fall back to input on failure.
  const rootDir = yield* fs.realPath(dir).pipe(Effect.catchAll(() => Effect.succeed(dir)))
  const rootPrefix = rootDir.endsWith(path.sep) ? rootDir : `${rootDir}${path.sep}`
  const seenDirectories = new Set<string>()

  const resolveSymlinkTarget = (
    fullPath: string,
  ): Effect.Effect<string | undefined, never, never> =>
    fs.readLink(fullPath).pipe(
      Effect.map((target) =>
        pathService.isAbsolute(target)
          ? target
          : pathService.resolve(pathService.dirname(fullPath), target),
      ),
      // readLink fails for non-symlinks; treat those as "no target".
      Effect.catchAll(() => Effect.succeed(undefined)),
    )

  const isWithinRoot = (target: string): boolean =>
    target === rootDir || target.startsWith(rootPrefix)

  const safeStat = (fullPath: string): Effect.Effect<StatResult, never, never> =>
    fs.stat(fullPath).pipe(
      Effect.map(
        (stat): StatResult => ({ type: stat.type === 'Directory' ? 'directory' : 'file' }),
      ),
      Effect.catchTag('SystemError', (e) => {
        // Handle broken symlinks and other stat failures gracefully
        if (e.reason === 'NotFound') {
          warnings.push(`Skipping broken symlink: ${fullPath}`)
          return Effect.succeed({ type: 'skip', reason: 'broken symlink' } as StatResult)
        }
        warnings.push(`Skipping ${fullPath}: ${e.message}`)
        return Effect.succeed({ type: 'skip', reason: e.message } as StatResult)
      }),
      Effect.catchTag('BadArgument', (e) => {
        warnings.push(`Skipping ${fullPath}: ${e.message}`)
        return Effect.succeed({ type: 'skip', reason: e.message } as StatResult)
      }),
    )

  const walk: (currentDir: string) => Effect.Effect<string[], PlatformError.PlatformError> =
    Effect.fnUntraced(function* (currentDir: string) {
      const entries = yield* fs.readDirectory(currentDir)
      const results: string[] = []

      for (const entry of entries) {
        if (shouldSkipDirectory(entry)) {
          continue
        }

        const fullPath = pathService.join(currentDir, entry)
        const stat = yield* safeStat(fullPath)

        if (stat.type === 'directory') {
          const symlinkTarget = yield* resolveSymlinkTarget(fullPath)

          if (symlinkTarget !== undefined) {
            /**
             * Skip symlinked directories that point back inside the root.
             * This avoids duplicate traversal when submodules are symlinked
             * to a canonical working tree.
             */
            if (isWithinRoot(symlinkTarget)) {
              continue
            }

            if (seenDirectories.has(symlinkTarget)) {
              continue
            }
            seenDirectories.add(symlinkTarget)
          } else {
            if (seenDirectories.has(fullPath)) {
              continue
            }
            seenDirectories.add(fullPath)
          }

          const nested = yield* walk(fullPath)
          results.push(...nested)
        } else if (stat.type === 'file' && isGenieFile(entry)) {
          results.push(fullPath)
        }
        // skip broken symlinks silently (already logged warning)
      }

      return results
    })

  const files = yield* walk(dir)
  const seen = new Set<string>()
  const uniqueFiles: string[] = []

  for (const file of files) {
    const resolvedPath = yield* fs.realPath(file).pipe(
      Effect.catchTag('SystemError', (e) => {
        warnings.push(`Skipping ${file}: ${e.message}`)
        return Effect.succeed(null)
      }),
      Effect.catchTag('BadArgument', (e) => {
        warnings.push(`Skipping ${file}: ${e.message}`)
        return Effect.succeed(null)
      }),
    )

    if (resolvedPath === null) continue
    if (seen.has(resolvedPath)) continue
    seen.add(resolvedPath)
    uniqueFiles.push(resolvedPath)
  }

  // Log warnings about skipped files
  for (const warning of warnings) {
    yield* Effect.logWarning(warning)
  }

  return uniqueFiles
})
