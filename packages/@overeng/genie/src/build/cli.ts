import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Cli from '@effect/cli'
import { Command, Error as PlatformError, FileSystem, Path } from '@effect/platform'
import * as PlatformNode from '@effect/platform-node'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import { Array as A, Effect, Either, Layer, pipe, Schema, Stream } from 'effect'

import { CurrentWorkingDirectory } from '@overeng/utils/node'
import { resolveCliVersion } from '@overeng/utils/node/cli-version'

import { resolveImportMapSpecifierForImporterSync } from './import-map/mod.ts'

/** Context passed to genie generator functions */
type GenieContext = {
  /** Repo-relative path to the directory containing this genie file (e.g., 'packages/@overeng/utils') */
  location: string
  /** Absolute path to the working directory (repo root) */
  cwd: string
}

const baseVersion = '0.1.0'
const buildVersion = '__CLI_VERSION__'
const version = resolveCliVersion({
  baseVersion,
  buildVersion,
  runtimeStampEnvVar: 'NIX_CLI_BUILD_STAMP',
})

let importMapResolverRegistered = false

/** Detect if we're running as a compiled Bun binary (bunfs paths indicate compiled binary) */
const isCompiledBinary = (): boolean => {
  try {
    return process.argv[1]?.includes('/$bunfs/') ?? false
  } catch {
    return false
  }
}

/**
 * Safely convert error to string.
 * In compiled Bun binaries, String(error) can throw for Bun's internal error types
 * due to class identity mismatches. We catch and return a fallback.
 */
const safeErrorString = (error: unknown): string => {
  try {
    return String(error)
  } catch {
    // Bun compiled binary issue - just return the constructor name
    if (error && typeof error === 'object') {
      return `[${error.constructor?.name ?? 'Error'}]`
    }
    return '[Error]'
  }
}

/** Error when importing a .genie.ts file fails */
export class GenieImportError extends Schema.TaggedError<GenieImportError>()('GenieImportError', {
  genieFilePath: Schema.String,
  message: Schema.String,
}) {}

/** Error when generated file content doesn't match (in check mode) */
export class GenieCheckError extends Schema.TaggedError<GenieCheckError>()('GenieCheckError', {
  targetFilePath: Schema.String,
  message: Schema.String,
}) {}

/** Error when one or more files failed to generate */
export class GenieGenerationFailedError extends Schema.TaggedError<GenieGenerationFailedError>()(
  'GenieGenerationFailedError',
  {
    failedCount: Schema.Number,
    message: Schema.String,
  },
) {}

/** Error when a single file fails to generate */
export class GenieFileError extends Schema.TaggedError<GenieFileError>()('GenieFileError', {
  targetFilePath: Schema.String,
  message: Schema.String,
}) {}

type GenieCommandConfig = {
  cwd: string
  watch: boolean
  writeable: boolean
  check: boolean
  dryRun: boolean
}

type GenieCommandEnv =
  | FileSystem.FileSystem
  | Path.Path
  | CommandExecutor.CommandExecutor
  | CurrentWorkingDirectory

type GenieCommandError =
  | GenieCheckError
  | GenieGenerationFailedError
  | GenieImportError
  | PlatformError.PlatformError

/** Successful generation of a single file */
type GenerateSuccess =
  | { _tag: 'created'; targetFilePath: string }
  | { _tag: 'updated'; targetFilePath: string }
  | { _tag: 'unchanged'; targetFilePath: string }
  | { _tag: 'skipped'; targetFilePath: string; reason: string }

/** Warning info for tsconfig references that don't match workspace dependencies */
type TsconfigReferencesWarning = {
  tsconfigPath: string
  missingReferences: string[]
  extraReferences: string[]
}

/** File extensions that oxfmt can format */
const oxfmtSupportedExtensions = new Set(['.json', '.jsonc', '.yml', '.yaml'])

/**
 * Get the appropriate header comment for a generated file based on its extension.
 *
 * The source file reference uses just the basename (e.g., `package.json.genie.ts`) rather than
 * a path relative to the working directory. This design choice avoids ambiguity when genie runs
 * in a monorepo with git submodules: if the source path were relative to cwd, running genie from
 * the parent repo would produce paths like `submodules/child-repo/packages/.../file.genie.ts`,
 * while running from the child repo would produce `packages/.../file.genie.ts`. Using basename
 * ensures consistent output regardless of where genie is invoked, since the `.genie.ts` source
 * file is always a sibling of the generated file.
 */
// oxlint-disable-next-line overeng/named-args -- simple internal helper
const getHeaderComment = (targetFilePath: string, sourceFile: string): string => {
  const ext = path.extname(targetFilePath)
  const basename = path.basename(targetFilePath)

  // tsconfig*.json files support JS-style comments
  if (basename.startsWith('tsconfig') && ext === '.json') {
    return `// Generated file - DO NOT EDIT\n// Source: ${sourceFile}\n`
  }

  // JSONC files support JS-style comments
  if (ext === '.jsonc') {
    return `// Generated file - DO NOT EDIT\n// Source: ${sourceFile}\n`
  }

  // Regular JSON files don't support comments - rely on read-only permissions + .gitattributes
  if (ext === '.json') {
    return ''
  }

  if (ext === '.yml' || ext === '.yaml') {
    return `# Generated file - DO NOT EDIT\n# Source: ${sourceFile}\n\n`
  }

  // Default to JS/TS style comments
  return `// Generated file - DO NOT EDIT\n// Source: ${sourceFile}\n`
}

/** Possible oxfmt config file paths to search for (in order of preference) */
const OXFMT_CONFIG_PATHS = [
  'packages/@overeng/oxc-config/fmt.jsonc',
  'submodules/effect-utils/packages/@overeng/oxc-config/fmt.jsonc',
] as const

/** Cached oxfmt config path (undefined = not yet searched, null = not found) */
let oxfmtConfigCache: string | null | undefined = undefined

/** Find oxfmt config file, caching the result */
const findOxfmtConfig = Effect.gen(function* () {
  if (oxfmtConfigCache !== undefined) {
    return oxfmtConfigCache
  }

  const fs = yield* FileSystem.FileSystem

  for (const configPath of OXFMT_CONFIG_PATHS) {
    const exists = yield* fs.exists(configPath)
    if (exists) {
      oxfmtConfigCache = configPath
      return configPath
    }
  }

  yield* Effect.logWarning(
    `oxfmt config not found at any of: ${OXFMT_CONFIG_PATHS.join(', ')}. Skipping formatting.`,
  )
  oxfmtConfigCache = null
  return null
})

/** Format content using oxfmt if the file type is supported and config is available */
// oxlint-disable-next-line overeng/named-args -- simple internal helper
const formatWithOxfmt = (targetFilePath: string, content: string) =>
  Effect.gen(function* () {
    const ext = path.extname(targetFilePath)

    if (!oxfmtSupportedExtensions.has(ext)) {
      return content
    }

    const configPath = yield* findOxfmtConfig
    if (configPath === null) {
      return content
    }

    const result = yield* Command.make(
      'oxfmt',
      '-c',
      configPath,
      '--stdin-filepath',
      targetFilePath,
    ).pipe(
      Command.feed(content),
      Command.string,
      Effect.catchAll(() => Effect.succeed(content)),
    )

    return result
  }).pipe(Effect.withSpan('formatWithOxfmt'))

const isGenieFile = (file: string) => file.endsWith('.genie.ts')

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
const ensureImportMapResolver = Effect.sync(() => {
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
  return false
}

/** Result of attempting to stat a file - handles broken symlinks gracefully */
type StatResult = { type: 'directory' } | { type: 'file' } | { type: 'skip'; reason: string }

/**
 * Find all .genie.ts files under a root directory.
 *
 * Implementation notes:
 * - We resolve the root path once and use it as a boundary so that
 *   symlinked submodule duplicates pointing back into the root are skipped.
 * - This keeps output stable when symlinks are used to dedupe submodules,
 *   avoiding double generation and racey writes/chmod.
 */
const findGenieFiles = (dir: string) =>
  Effect.gen(function* () {
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

    const walk = (
      currentDir: string,
    ): Effect.Effect<string[], PlatformError.PlatformError, never> =>
      Effect.gen(function* () {
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
  }).pipe(Effect.withSpan('findGenieFiles'))

/**
 * Compute the package location from a genie file path.
 * Example: '/repo/packages/@overeng/utils/package.json.genie.ts' with cwd '/repo'
 *          → 'packages/@overeng/utils'
 */
const computeLocationFromPath = ({
  genieFilePath,
  cwd,
}: {
  genieFilePath: string
  cwd: string
}): string => {
  const targetFilePath = genieFilePath.replace('.genie.ts', '')
  const targetDir = path.dirname(targetFilePath)
  const relativePath = path.relative(cwd, targetDir)
  // Normalize to forward slashes and handle root case
  return relativePath === '' ? '.' : relativePath.split(path.sep).join('/')
}

/**
 * Import a genie file and return its default export (the raw content string).
 *
 * A Bun import resolver is registered once so `#...` specifiers are resolved
 * using the import map closest to the importing file (including transitive imports).
 *
 * All genie files must export a function that takes GenieContext and returns a string.
 */
const importGenieFile = ({ genieFilePath, cwd }: { genieFilePath: string; cwd: string }) =>
  Effect.gen(function* () {
    yield* ensureImportMapResolver

    const importPath = `${genieFilePath}?import=${Date.now()}`

    const module = yield* Effect.tryPromise({
      // oxlint-disable-next-line eslint-plugin-import/no-dynamic-require -- dynamic import path required for genie
      try: () => import(importPath),
      catch: (error) =>
        new GenieImportError({
          genieFilePath,
          message: `Failed to import ${genieFilePath}: ${safeErrorString(error)}`,
        }),
    })

    const exported = module.default

    // Genie files must export a GenieOutput object with { data, stringify }
    if (
      typeof exported !== 'object' ||
      exported === null ||
      !('stringify' in exported) ||
      typeof exported.stringify !== 'function'
    ) {
      return yield* new GenieImportError({
        genieFilePath,
        message: `Genie file must export a GenieOutput object with { data, stringify }, got ${typeof exported}`,
      })
    }

    // Create context and call the stringify function
    const location = computeLocationFromPath({ genieFilePath, cwd })
    const ctx: GenieContext = { location, cwd }

    return exported.stringify(ctx) as string
  })

/**
 * For package.json files, enrich the $genie marker with source file information.
 * This transforms the simple string marker into an object with structured metadata.
 */
const enrichPackageJsonMarker = ({
  content,
  sourceFile,
}: {
  content: string
  sourceFile: string
}): string => {
  try {
    const parsed = JSON.parse(content)
    if (typeof parsed === 'object' && parsed !== null && '$genie' in parsed) {
      parsed.$genie = {
        source: sourceFile,
        warning: 'DO NOT EDIT - changes will be overwritten',
      }
      return JSON.stringify(parsed, null, 2)
    }
  } catch {
    // Not valid JSON or parsing failed, return original
  }
  return content
}

/** Generate expected content for a genie file (shared between generate and dry-run) */
const getExpectedContent = ({ genieFilePath, cwd }: { genieFilePath: string; cwd: string }) =>
  Effect.gen(function* () {
    const targetFilePath = genieFilePath.replace('.genie.ts', '')
    const sourceFile = path.basename(genieFilePath)
    let rawContent = yield* importGenieFile({ genieFilePath, cwd })

    // For package.json files, enrich the $genie marker with source info
    if (path.basename(targetFilePath) === 'package.json') {
      rawContent = enrichPackageJsonMarker({ content: rawContent, sourceFile })
    }

    const header = getHeaderComment(targetFilePath, sourceFile)
    const formattedContent = yield* formatWithOxfmt(targetFilePath, rawContent)
    return { targetFilePath, content: header + formattedContent }
  })

/** Generate a brief diff summary showing line count changes */
const generateDiffSummary = ({
  oldContent,
  newContent,
}: {
  oldContent: string
  newContent: string
}): string => {
  if (oldContent === newContent) return ''

  const oldLines = oldContent.split('\n').length
  const newLines = newContent.split('\n').length
  const diff = newLines - oldLines

  if (diff > 0) {
    return `  (+${diff} lines)`
  } else if (diff < 0) {
    return `  (${diff} lines)`
  }
  return '  (content changed)'
}

/**
 * Atomically write a file by writing to a temp file first, then renaming.
 * This prevents file corruption if an error occurs during write.
 */
const atomicWriteFile = ({
  targetFilePath,
  content,
  mode,
}: {
  targetFilePath: string
  content: string
  mode?: number
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const tempPath = `${targetFilePath}.genie.tmp`

    // Make target writable if it exists (for read-only files)
    const targetExists = yield* fs.exists(targetFilePath)
    if (targetExists) {
      yield* fs.chmod(targetFilePath, 0o644).pipe(Effect.catchAll(() => Effect.void))
    }

    // Write to temp file first
    yield* fs.writeFileString(tempPath, content)

    // Set permissions on temp file before rename
    if (mode !== undefined) {
      yield* fs.chmod(tempPath, mode)
    }

    // Atomic rename - either fully succeeds or original file remains untouched
    yield* fs.rename(tempPath, targetFilePath)
  }).pipe(
    Effect.catchAll((error) =>
      Effect.gen(function* () {
        // Clean up temp file on failure
        const fs = yield* FileSystem.FileSystem
        const tempPath = `${targetFilePath}.genie.tmp`
        yield* fs.remove(tempPath, { force: true }).pipe(Effect.catchAll(() => Effect.void))
        return yield* error
      }),
    ),
    Effect.withSpan('atomicWriteFile'),
  )

const generateFile = ({
  genieFilePath,
  cwd,
  readOnly,
  dryRun = false,
}: {
  genieFilePath: string
  cwd: string
  readOnly: boolean
  dryRun?: boolean
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const targetFilePath = genieFilePath.replace('.genie.ts', '')
    const targetDir = path.dirname(targetFilePath)

    const { content: fileContentString } = yield* getExpectedContent({ genieFilePath, cwd })

    const targetDirExists = yield* fs.exists(targetDir)
    if (!targetDirExists) {
      const reason = `Parent directory missing: ${targetDir}`
      yield* Effect.logWarning(`Skipping ${targetFilePath}: ${reason}`)
      return { _tag: 'skipped', targetFilePath, reason } as const
    }

    // Check if file exists and get current content
    const fileExists = yield* fs.exists(targetFilePath)
    const currentContent = fileExists
      ? yield* fs.readFileString(targetFilePath).pipe(Effect.catchAll(() => Effect.succeed('')))
      : ''

    const isUnchanged = fileExists && currentContent === fileContentString

    if (dryRun) {
      if (!fileExists) {
        yield* Effect.log(`Would create: ${targetFilePath}`)
        return { _tag: 'created', targetFilePath } as const
      }
      if (isUnchanged) {
        return { _tag: 'unchanged', targetFilePath } as const
      }
      // Show diff summary
      const diffSummary = generateDiffSummary({
        oldContent: currentContent,
        newContent: fileContentString,
      })
      yield* Effect.log(`Would update: ${targetFilePath}${diffSummary}`)
      return { _tag: 'updated', targetFilePath } as const
    }

    // Atomically write the file (write to temp, then rename)
    yield* atomicWriteFile({
      targetFilePath,
      content: fileContentString,
      ...(readOnly && { mode: 0o444 }),
    })

    // Determine result status
    if (!fileExists) {
      yield* Effect.log(`✓ Created ${targetFilePath}`)
      return { _tag: 'created', targetFilePath } as const
    }
    if (isUnchanged) {
      return { _tag: 'unchanged', targetFilePath } as const
    }

    // Show diff summary for changed files
    const diffSummary = generateDiffSummary({
      oldContent: currentContent,
      newContent: fileContentString,
    })
    yield* Effect.log(`✓ Updated ${targetFilePath}${diffSummary}`)
    return { _tag: 'updated', targetFilePath } as const
  }).pipe(
    Effect.mapError((cause) => {
      const targetFilePath = genieFilePath.replace('.genie.ts', '')
      return new GenieFileError({
        targetFilePath,
        message: `Failed to generate ${targetFilePath}: ${safeErrorString(cause)}`,
      })
    }),
    Effect.catchAllDefect((defect) => {
      const targetFilePath = genieFilePath.replace('.genie.ts', '')
      return Effect.fail(
        new GenieFileError({
          targetFilePath,
          message: `Failed to generate ${targetFilePath}: ${safeErrorString(defect)}`,
        }),
      )
    }),
    Effect.withSpan('generateFile'),
  )

const checkFile = ({ genieFilePath, cwd }: { genieFilePath: string; cwd: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const { targetFilePath, content: expectedContent } = yield* getExpectedContent({
      genieFilePath,
      cwd,
    })

    const fileExists = yield* fs.exists(targetFilePath)
    if (!fileExists) {
      return yield* new GenieCheckError({
        targetFilePath,
        message: `File does not exist. Run 'mono genie' to generate it.`,
      })
    }

    const actualContent = yield* fs.readFileString(targetFilePath)

    if (actualContent !== expectedContent) {
      return yield* new GenieCheckError({
        targetFilePath,
        message: `File content is out of date. Run 'mono genie' to regenerate it.`,
      })
    }

    yield* Effect.log(`✓ ${targetFilePath} is up to date`)
  }).pipe(Effect.withSpan('checkFile'))

/** Extract workspace dependencies from package.json content */
const getWorkspaceDependencies = (packageJsonContent: string): string[] => {
  try {
    const pkg = JSON.parse(packageJsonContent) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    return Object.entries(deps)
      .filter(([_, version]) => version === 'workspace:*' || version.startsWith('workspace:'))
      .map(([name]) => name)
  } catch {
    return []
  }
}

/** Extract references from tsconfig.json content */
const getTsconfigReferences = (tsconfigContent: string): string[] => {
  try {
    // Remove comments from JSON (tsconfig supports // comments)
    const withoutComments = tsconfigContent.replace(/\/\/.*$/gm, '')
    const tsconfig = JSON.parse(withoutComments) as {
      references?: Array<{ path: string }>
    }
    return (tsconfig.references ?? []).map((ref) => ref.path)
  } catch {
    return []
  }
}

/** Map package name to expected tsconfig reference path */
// oxlint-disable-next-line overeng/named-args -- simple internal mapper
const packageNameToReferencePath = (
  packageName: string,
  currentPackageDir: string,
  cwd: string,
): string | undefined => {
  // Common patterns for @overeng packages
  if (packageName.startsWith('@overeng/')) {
    const shortName = packageName.replace('@overeng/', '')
    const currentRelative = path.relative(cwd, currentPackageDir)

    // If current package is in packages/@overeng/*, sibling reference is ../{shortName}
    if (currentRelative.startsWith('packages/@overeng/')) {
      return `../${shortName}`
    }
  }
  return undefined
}

/** Validate tsconfig references against package.json workspace dependencies */
const validateTsconfigReferences = ({ genieFiles, cwd }: { genieFiles: string[]; cwd: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const warnings: TsconfigReferencesWarning[] = []

    // Find pairs of tsconfig.json.genie.ts and package.json.genie.ts in the same directory
    const tsconfigGenieFiles = genieFiles.filter((f) => f.endsWith('tsconfig.json.genie.ts'))

    for (const tsconfigGenieFile of tsconfigGenieFiles) {
      const dir = path.dirname(tsconfigGenieFile)
      const packageJsonPath = path.join(dir, 'package.json')
      const tsconfigPath = tsconfigGenieFile.replace('.genie.ts', '')

      // Check if package.json exists
      const packageJsonExists = yield* fs.exists(packageJsonPath)
      if (!packageJsonExists) continue

      // Check if tsconfig.json exists (generated)
      const tsconfigExists = yield* fs.exists(tsconfigPath)
      if (!tsconfigExists) continue

      const packageJsonContent = yield* fs.readFileString(packageJsonPath)
      const tsconfigContent = yield* fs.readFileString(tsconfigPath)

      const workspaceDeps = getWorkspaceDependencies(packageJsonContent)
      const currentReferences = getTsconfigReferences(tsconfigContent)

      // Convert workspace deps to expected reference paths
      const expectedReferences = workspaceDeps
        .map((dep) => packageNameToReferencePath(dep, dir, cwd))
        .filter((ref): ref is string => ref !== undefined)

      // Find missing and extra references
      const missingReferences = A.differenceWith<string>((a, b) => a === b)(
        expectedReferences,
        currentReferences,
      )
      const extraReferences = A.differenceWith<string>((a, b) => a === b)(
        currentReferences,
        expectedReferences,
      )

      if (missingReferences.length > 0 || extraReferences.length > 0) {
        warnings.push({
          tsconfigPath: path.relative(cwd, tsconfigPath),
          missingReferences,
          extraReferences,
        })
      }
    }

    return warnings
  }).pipe(Effect.withSpan('validateTsconfigReferences'))

/** Log tsconfig reference warnings */
const logTsconfigWarnings = (warnings: TsconfigReferencesWarning[]) =>
  Effect.gen(function* () {
    if (warnings.length === 0) return

    yield* Effect.log('')
    yield* Effect.log('⚠ Tsconfig reference warnings:')

    for (const warning of warnings) {
      yield* Effect.log(`  ${warning.tsconfigPath}:`)
      for (const missing of warning.missingReferences) {
        yield* Effect.log(`    - Missing reference: ${missing}`)
      }
      for (const extra of warning.extraReferences) {
        yield* Effect.log(`    - Extra reference (not in package.json deps): ${extra}`)
      }
    }

    yield* Effect.log('')
  })

/**
 * Logs a summary of file generation results and returns counts by category.
 *
 * Sample output:
 * ```
 * Summary: 34 files processed
 *   ✓ 2 created
 *   ✓ 1 updated
 *   · 30 unchanged
 *   · 1 skipped
 *   ✗ 1 failed:
 *     - packages/foo/package.json: Failed to generate packages/foo/package.json: Import failed
 * ```
 */
const summarizeResults = ({
  successes,
  failures,
}: {
  successes: GenerateSuccess[]
  failures: GenieFileError[]
}) =>
  Effect.gen(function* () {
    const created = successes.filter((s) => s._tag === 'created')
    const updated = successes.filter((s) => s._tag === 'updated')
    const unchanged = successes.filter((s) => s._tag === 'unchanged')
    const skipped = successes.filter((s) => s._tag === 'skipped')
    const total = successes.length + failures.length

    yield* Effect.log('')
    yield* Effect.log(`Summary: ${total} files processed`)

    if (created.length > 0) {
      yield* Effect.log(`  ✓ ${created.length} created`)
    }
    if (updated.length > 0) {
      yield* Effect.log(`  ✓ ${updated.length} updated`)
    }
    if (unchanged.length > 0) {
      yield* Effect.log(`  · ${unchanged.length} unchanged`)
    }
    if (skipped.length > 0) {
      yield* Effect.log(`  · ${skipped.length} skipped`)
    }
    if (failures.length > 0) {
      yield* Effect.logError(`  ✗ ${failures.length} failed:`)
      for (const f of failures) {
        yield* Effect.logError(`    - ${f.targetFilePath}: ${f.message}`)
      }
    }

    return {
      created: created.length,
      updated: updated.length,
      unchanged: unchanged.length,
      skipped: skipped.length,
      failed: failures.length,
    }
  })

/** Genie CLI command - generates files from .genie.ts source files */
export const genieCommand: Cli.Command.Command<
  'genie',
  GenieCommandEnv,
  GenieCommandError,
  GenieCommandConfig
> = Cli.Command.make(
  'genie',
  {
    cwd: Cli.Options.text('cwd').pipe(
      Cli.Options.withDescription('Working directory to search for .genie.ts files'),
      Cli.Options.withDefault('.'),
    ),
    watch: Cli.Options.boolean('watch').pipe(
      Cli.Options.withDescription('Watch for changes and regenerate automatically'),
      Cli.Options.withDefault(false),
    ),
    writeable: Cli.Options.boolean('writeable').pipe(
      Cli.Options.withDescription('Generate files as writable (default: read-only)'),
      Cli.Options.withDefault(false),
    ),
    check: Cli.Options.boolean('check').pipe(
      Cli.Options.withDescription('Check if generated files are up to date (for CI)'),
      Cli.Options.withDefault(false),
    ),
    dryRun: Cli.Options.boolean('dry-run').pipe(
      Cli.Options.withDescription('Preview changes without writing files'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ cwd, writeable, watch, check, dryRun }) =>
    Effect.gen(function* () {
      const readOnly = !writeable
      const fs = yield* FileSystem.FileSystem
      const currentWorkingDirectory = yield* CurrentWorkingDirectory
      const resolvedCwd = path.isAbsolute(cwd) ? cwd : path.resolve(currentWorkingDirectory, cwd)

      const genieFiles = yield* findGenieFiles(resolvedCwd)

      if (genieFiles.length === 0) {
        yield* Effect.log('No .genie.ts files found')
        return
      }

      yield* Effect.log(`Found ${genieFiles.length} .genie.ts files`)

      if (check) {
        yield* Effect.all(
          genieFiles.map((genieFilePath) => checkFile({ genieFilePath, cwd: resolvedCwd })),
          { concurrency: 'unbounded' },
        )
        yield* Effect.log('✓ All generated files are up to date')

        // Validate tsconfig references
        const warnings = yield* validateTsconfigReferences({ genieFiles, cwd: resolvedCwd })
        yield* logTsconfigWarnings(warnings)

        return
      }

      if (dryRun) {
        yield* Effect.log('Dry run mode - no files will be modified\n')
      }

      // Generate all files, capturing both successes and failures
      const results = yield* Effect.all(
        genieFiles.map((genieFilePath) =>
          generateFile({ genieFilePath, cwd: resolvedCwd, readOnly, dryRun }).pipe(Effect.either),
        ),
        { concurrency: 'unbounded' },
      )

      // Partition results into successes and failures
      const successes = results.filter(Either.isRight).map((r) => r.right)
      const failures = results.filter(Either.isLeft).map((r) => r.left)

      // Show summary
      const summary = yield* summarizeResults({ successes, failures })

      // Exit with error code if any files failed
      if (summary.failed > 0) {
        return yield* new GenieGenerationFailedError({
          failedCount: summary.failed,
          message: `${summary.failed} file(s) failed to generate`,
        })
      }

      if (watch && !dryRun) {
        yield* Effect.log('\nWatching for changes...')
        yield* pipe(
          fs.watch(resolvedCwd),
          Stream.filter(({ path: p }) => p.endsWith('.genie.ts')),
          Stream.tap(({ path: p }) => {
            const genieFilePath = path.join(resolvedCwd, p)
            return generateFile({ genieFilePath, cwd: resolvedCwd, readOnly }).pipe(
              Effect.catchAll((error) => Effect.logError(error.message)),
            )
          }),
          Stream.runDrain,
        )
      }
    }).pipe(Effect.withSpan('genie')),
)

if (import.meta.main) {
  pipe(
    Cli.Command.run(genieCommand, {
      name: 'genie',
      version,
    })(process.argv),
    Effect.provide(Layer.mergeAll(PlatformNode.NodeContext.layer, CurrentWorkingDirectory.live)),
    PlatformNode.NodeRuntime.runMain,
  )
}
