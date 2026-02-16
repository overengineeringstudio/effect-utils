import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

import type { Path } from '@effect/platform'
import {
  Command,
  type CommandExecutor,
  type Error as PlatformError,
  FileSystem,
} from '@effect/platform'
import { Duration, Effect, Either, Option } from 'effect'

import { DistributedSemaphore } from '@overeng/utils'
import { FileSystemBacking } from '@overeng/utils/node'

import type { GenieOutput } from '../runtime/mod.ts'
import { ensureImportMapResolver } from './discovery.ts'
import { GenieCheckError, GenieFileError, GenieImportError } from './errors.ts'
import type { GenerateSuccess, GenieContext } from './types.ts'

/** Loaded genie module plus base context reused across check and validation phases. */
export type LoadedGenieFile = {
  genieFilePath: string
  output: GenieOutput<unknown>
  ctx: GenieContext
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
    if (error !== null && typeof error === 'object') {
      return `[${error.constructor?.name ?? 'Error'}]`
    }
    return '[Error]'
  }
}

/**
 * Check if an error is a Temporal Dead Zone (TDZ) error.
 *
 * ## Problem
 *
 * When genie files import from a shared module that throws during initialization,
 * ESM leaves the module's exports in an uninitialized state. Subsequent imports
 * from that module produce TDZ errors instead of re-throwing the original error.
 *
 * ## Example Scenario
 *
 * ```
 * // genie/internal.ts - throws during initialization
 * export const catalog = (() => { throw new Error('Missing DATABASE_URL') })()
 *
 * // apps/app/package.json.genie.ts - imports from internal.ts
 * import { catalog } from '../../genie/internal.ts'  // TDZ error!
 * ```
 *
 * During parallel generation, one file gets the original error while others get:
 * `ReferenceError: Cannot access 'catalog' before initialization`
 *
 * This function detects TDZ errors so we can re-validate and find the root cause.
 */
export const isTdzError = (error: unknown): error is ReferenceError =>
  error instanceof ReferenceError &&
  /Cannot access .* before initialization/.test((error as Error).message)

/**
 * Check if an error originated in the given file (vs being propagated from a dependency).
 *
 * ## Purpose
 *
 * When re-validating after TDZ detection, we need to distinguish between:
 * - **Root cause errors**: The actual file that threw (appears in stack trace)
 * - **Cascaded errors**: Files that failed because they import from a failing module
 *
 * ## Error Attribution Rules
 *
 * 1. TDZ errors → Never originate in the file (always from dependencies)
 * 2. Other errors → Check if the file path appears in the stack trace
 *
 * ## Example
 *
 * If `genie/internal.ts` throws and `apps/app/package.json.genie.ts` imports from it:
 * - `errorOriginatesInFile(error, 'genie/internal.ts')` → true (root cause)
 * - `errorOriginatesInFile(error, 'apps/app/package.json.genie.ts')` → false (dependent)
 */
export const errorOriginatesInFile = ({
  error,
  filePath,
}: {
  error: unknown
  filePath: string
}): boolean => {
  // TDZ errors never originate in the file - they're always from dependencies
  if (isTdzError(error) === true) return false
  // Check if the stack trace includes this file path
  if (error instanceof Error) {
    return error.stack?.includes(filePath) ?? false
  }
  return false
}

/** File extensions that oxfmt can format */
const oxfmtSupportedExtensions = new Set(['.json', '.jsonc', '.yml', '.yaml'])

type OxfmtConfig = Readonly<Record<string, unknown>>
type OxfmtFormatResult = {
  code: string
  errors: ReadonlyArray<unknown>
}
type OxfmtFormat = (
  fileName: string,
  text: string,
  options?: OxfmtConfig,
) => Promise<OxfmtFormatResult>

let oxfmtFormatPromise: Promise<OxfmtFormat | undefined> | undefined

const loadOxfmtFormat = (): Promise<OxfmtFormat | undefined> => {
  if (oxfmtFormatPromise !== undefined) {
    return oxfmtFormatPromise
  }

  oxfmtFormatPromise = import('oxfmt')
    .then((module) => (typeof module.format === 'function' ? module.format : undefined))
    .catch(() => undefined)

  return oxfmtFormatPromise
}

const loadOxfmtConfig = Effect.fn('loadOxfmtConfig')(function* ({
  configPath,
}: {
  configPath: Option.Option<string>
}): Effect.Effect<Option.Option<OxfmtConfig>, PlatformError.PlatformError, FileSystem.FileSystem> {
  if (Option.isNone(configPath) === true) {
    return Option.none()
  }

  const fs = yield* FileSystem.FileSystem
  const raw = yield* fs.readFileString(configPath.value)
  const config = yield* Effect.try({
    try: () => JSON.parse(raw) as OxfmtConfig,
    catch: () => new Error('Invalid oxfmt config JSON'),
  })

  return Option.some(config)
})

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
const getHeaderComment = ({
  targetFilePath,
  sourceFile,
}: {
  targetFilePath: string
  sourceFile: string
}): string => {
  const ext = path.extname(targetFilePath)
  const basename = path.basename(targetFilePath)

  // tsconfig*.json files support JS-style comments
  if (basename.startsWith('tsconfig') === true && ext === '.json') {
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

/** Format content using oxfmt if the file type is supported */
const formatWithOxfmt = Effect.fn('formatWithOxfmt')(function* ({
  targetFilePath,
  content,
  configPath,
}: {
  targetFilePath: string
  content: string
  configPath: Option.Option<string>
}) {
  const ext = path.extname(targetFilePath)

  if (oxfmtSupportedExtensions.has(ext) === false) {
    return content
  }

  const format = yield* Effect.tryPromise({
    try: () => loadOxfmtFormat(),
    catch: () => undefined,
  })
  const optionsResult = yield* loadOxfmtConfig({ configPath }).pipe(Effect.either)

  if (format !== undefined && Either.isRight(optionsResult) === true) {
    const result = yield* Effect.tryPromise({
      try: () => format(targetFilePath, content, Option.getOrUndefined(optionsResult.right)),
      catch: () => undefined,
    })

    if (result !== undefined && result.errors.length === 0) {
      if (result.code.length === 0 && content.length > 0) {
        return content
      }
      return result.code
    }
  }

  const args = Option.match(configPath, {
    onNone: () => ['--stdin-filepath', targetFilePath],
    onSome: (cfg) => ['-c', cfg, '--stdin-filepath', targetFilePath],
  })

  const result = yield* Command.make('oxfmt', ...args).pipe(
    Command.feed(content),
    Command.string,
    Effect.catchAll(() => Effect.succeed(content)),
  )

  // If oxfmt returned empty output (e.g., failed to parse), return original content.
  // This handles YAML with GitHub Actions ${{ }} expressions in flow sequences (inline arrays)
  // which Prettier's YAML parser can't handle - it interprets ${{ as a nested flow mapping.
  // See: https://github.com/prettier/prettier/issues/6517 (Helm template syntax)
  // See: https://github.com/eemeli/yaml/issues/328 (flow sequence parsing)
  if (result.length === 0 && content.length > 0) {
    return content
  }

  return result
})

/**
 * Find the nearest repo root for a genie file.
 * Prefers a local megarepo.json marker, falls back to .git.
 */
const repoRootCache = new Map<string, string>()

const findRepoRoot = Effect.fn('findRepoRoot')(function* ({
  startDir,
  cwd,
}: {
  startDir: string
  cwd: string
}) {
  const cacheKey = `${cwd}::${startDir}`
  const cached = repoRootCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  const fs = yield* FileSystem.FileSystem
  let current = startDir
  let last = ''

  while (current !== last) {
    if ((yield* fs.exists(path.join(current, 'megarepo.json'))) === true) {
      repoRootCache.set(cacheKey, current)
      return current
    }
    if ((yield* fs.exists(path.join(current, '.git'))) === true) {
      repoRootCache.set(cacheKey, current)
      return current
    }
    last = current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  repoRootCache.set(cacheKey, cwd)
  return cwd
})

/**
 * Compute the package location from a genie file path.
 * Example: '/repo/packages/@overeng/utils/package.json.genie.ts' with repo root '/repo'
 *          → 'packages/@overeng/utils'
 */
const computeLocationFromPath = ({
  genieFilePath,
  repoRoot,
}: {
  genieFilePath: string
  repoRoot: string
}): string => {
  const targetFilePath = genieFilePath.replace('.genie.ts', '')
  const targetDir = path.dirname(targetFilePath)
  const relativePath = path.relative(repoRoot, targetDir)
  // Normalize to forward slashes and handle root case
  return relativePath === '' ? '.' : relativePath.split(path.sep).join('/')
}

/**
 * Import a genie file and return its typed output plus the base context.
 *
 * A Bun import resolver is registered once so `#...` specifiers are resolved
 * using the import map closest to the importing file (including transitive imports).
 */
export const loadGenieFile = Effect.fn('loadGenieFile')(function* ({
  genieFilePath,
  cwd,
}: {
  genieFilePath: string
  cwd: string
}): Effect.Effect<LoadedGenieFile, GenieImportError, FileSystem.FileSystem> {
  yield* ensureImportMapResolver

  const importPath = `${genieFilePath}?import=${Date.now()}`

  const module = yield* Effect.tryPromise({
    // oxlint-disable-next-line eslint-plugin-import/no-dynamic-require -- dynamic import path required for genie
    try: () => import(importPath),
    catch: (error) =>
      new GenieImportError({
        genieFilePath,
        message: `Failed to import ${genieFilePath}: ${safeErrorString(error)}`,
        cause: error,
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
      cause: new Error(`Invalid export type: ${typeof exported}`),
    })
  }

  // Create context and call the stringify function
  const repoRoot = yield* findRepoRoot({
    startDir: path.dirname(genieFilePath),
    cwd,
  })
  const location = computeLocationFromPath({ genieFilePath, repoRoot })
  const ctx: GenieContext = { location, cwd }

  return { genieFilePath, output: exported as GenieOutput<unknown>, ctx }
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
export const getExpectedContent = ({
  genieFilePath,
  cwd,
  oxfmtConfigPath,
  loadedGenieFile,
}: {
  genieFilePath: string
  cwd: string
  oxfmtConfigPath: Option.Option<string>
  loadedGenieFile?: LoadedGenieFile
}): Effect.Effect<
  { targetFilePath: string; content: string },
  PlatformError.PlatformError | GenieImportError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const targetFilePath = genieFilePath.replace('.genie.ts', '')
    const sourceFile = path.basename(genieFilePath)
    const loaded =
      loadedGenieFile === undefined ? yield* loadGenieFile({ genieFilePath, cwd }) : loadedGenieFile
    let rawContent = loaded.output.stringify(loaded.ctx)

    // For package.json files, enrich the $genie marker with source info
    if (path.basename(targetFilePath) === 'package.json') {
      rawContent = enrichPackageJsonMarker({ content: rawContent, sourceFile })
    }

    const header = getHeaderComment({ targetFilePath, sourceFile })
    const formattedContent = yield* formatWithOxfmt({
      targetFilePath,
      content: rawContent,
      configPath: oxfmtConfigPath,
    })

    return { targetFilePath, content: header + formattedContent }
  }).pipe(Effect.withSpan('getExpectedContent'))

/** Generate a brief diff summary showing line count changes */
const generateDiffSummary = ({
  oldContent,
  newContent,
}: {
  oldContent: string
  newContent: string
}): string | undefined => {
  if (oldContent === newContent) return undefined

  const oldLines = oldContent.split('\n').length
  const newLines = newContent.split('\n').length
  const diff = newLines - oldLines

  if (diff > 0) {
    return `(+${diff} lines)`
  } else if (diff < 0) {
    return `(${diff} lines)`
  }
  return '(content changed)'
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
    if (targetExists === true) {
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

const withTargetLock = Effect.fn('genie/withTargetLock')(function* <E>({
  cwd,
  targetFilePath,
  effect,
}: {
  cwd: string
  targetFilePath: string
  effect: Effect.Effect<void, E, FileSystem.FileSystem>
}) {
  const lockNamespace = createHash('sha256').update(cwd).digest('hex').slice(0, 16)
  const lockDir = path.join(os.tmpdir(), 'genie-locks', lockNamespace)
  const lockLayer = FileSystemBacking.layer({ lockDir })
  const lockKey = `genie:file:${path.resolve(targetFilePath)}`

  const semaphore = yield* DistributedSemaphore.make(lockKey, {
    limit: 1,
    ttl: Duration.seconds(120),
  }).pipe(Effect.provide(lockLayer))

  return yield* semaphore.withPermits(1)(effect).pipe(Effect.provide(lockLayer))
})

/** Generate output file from a genie template */
export const generateFile = ({
  genieFilePath,
  cwd,
  readOnly,
  dryRun = false,
  oxfmtConfigPath,
}: {
  genieFilePath: string
  cwd: string
  readOnly: boolean
  dryRun?: boolean
  oxfmtConfigPath: Option.Option<string>
}): Effect.Effect<
  GenerateSuccess,
  GenieFileError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const targetFilePath = genieFilePath.replace('.genie.ts', '')
    const targetDir = path.dirname(targetFilePath)

    const { content: fileContentString } = yield* getExpectedContent({
      genieFilePath,
      cwd,
      oxfmtConfigPath,
    })

    const targetDirExists = yield* fs.exists(targetDir)
    if (targetDirExists === false) {
      const reason = `Parent directory missing: ${targetDir}`
      return { _tag: 'skipped' as const, targetFilePath, reason }
    }

    // Check if file exists and get current content
    const fileExists = yield* fs.exists(targetFilePath)
    const currentContent =
      fileExists === true
        ? yield* fs.readFileString(targetFilePath).pipe(Effect.catchAll(() => Effect.succeed('')))
        : ''

    const isUnchanged = fileExists === true && currentContent === fileContentString

    // Compute diff summary for updated files
    const diffSummary =
      fileExists === true && isUnchanged === false
        ? generateDiffSummary({ oldContent: currentContent, newContent: fileContentString })
        : undefined

    if (dryRun === true) {
      if (fileExists === false) {
        return { _tag: 'created', targetFilePath } as const
      }
      if (isUnchanged === true) {
        return { _tag: 'unchanged', targetFilePath } as const
      }
      return { _tag: 'updated', targetFilePath, diffSummary } as const
    }

    if (isUnchanged === true) {
      // Restore read-only permissions if needed (e.g. after a --writeable run or manual chmod)
      if (readOnly === true) {
        yield* fs.chmod(targetFilePath, 0o444).pipe(Effect.catchAll(() => Effect.void))
      }
      return { _tag: 'unchanged', targetFilePath } as const
    }

    // Atomically write the file (write to temp, then rename)
    yield* withTargetLock({
      cwd,
      targetFilePath,
      effect: atomicWriteFile({
        targetFilePath,
        content: fileContentString,
        ...(readOnly && { mode: 0o444 }),
      }),
    })

    if (fileExists === false) {
      return { _tag: 'created', targetFilePath } as const
    }

    return { _tag: 'updated', targetFilePath, diffSummary } as const
  }).pipe(
    Effect.map((_) => _ as GenerateSuccess),
    Effect.mapError((cause) => {
      const targetFilePath = genieFilePath.replace('.genie.ts', '')
      // Extract the underlying error for TDZ detection
      // Only unwrap GenieImportError (check _tag to avoid unwrapping native Error.cause)
      const underlyingError = cause instanceof GenieImportError ? cause.cause : cause
      return new GenieFileError({
        targetFilePath,
        message: `Failed to generate ${targetFilePath}: ${safeErrorString(cause)}`,
        cause:
          underlyingError instanceof Error ? underlyingError : new Error(safeErrorString(cause)),
      })
    }),
    Effect.catchAllDefect((defect) => {
      const targetFilePath = genieFilePath.replace('.genie.ts', '')
      return Effect.fail(
        new GenieFileError({
          targetFilePath,
          message: `Failed to generate ${targetFilePath}: ${safeErrorString(defect)}`,
          cause: defect instanceof Error ? defect : new Error(safeErrorString(defect)),
        }),
      )
    }),
    Effect.withSpan('generateFile'),
  )

/** Check if a generated file matches its expected content */
export const checkFile = ({
  genieFilePath,
  cwd,
  oxfmtConfigPath,
}: {
  genieFilePath: string
  cwd: string
  oxfmtConfigPath: Option.Option<string>
}): Effect.Effect<
  void,
  GenieCheckError | GenieImportError | PlatformError.PlatformError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> => checkFileDetailed({ genieFilePath, cwd, oxfmtConfigPath }).pipe(Effect.asVoid)

/** Check a generated file and return the loaded genie module for downstream validation reuse. */
export const checkFileDetailed = ({
  genieFilePath,
  cwd,
  oxfmtConfigPath,
}: {
  genieFilePath: string
  cwd: string
  oxfmtConfigPath: Option.Option<string>
}): Effect.Effect<
  { targetFilePath: string; loadedGenieFile: LoadedGenieFile },
  GenieCheckError | GenieImportError | PlatformError.PlatformError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const loadedGenieFile = yield* loadGenieFile({ genieFilePath, cwd })
    const { targetFilePath, content: expectedContent } = yield* getExpectedContent({
      genieFilePath,
      cwd,
      oxfmtConfigPath,
      loadedGenieFile,
    })

    const fileExists = yield* fs.exists(targetFilePath)
    if (fileExists === false) {
      return yield* new GenieCheckError({
        targetFilePath,
        message: `File does not exist. Run 'genie' to generate it.`,
      })
    }

    const actualContent = yield* fs.readFileString(targetFilePath)

    if (actualContent !== expectedContent) {
      return yield* new GenieCheckError({
        targetFilePath,
        message: `File content is out of date. Run 'genie' to regenerate it.`,
      })
    }

    return { targetFilePath, loadedGenieFile }
  }).pipe(Effect.withSpan('checkFile'))
