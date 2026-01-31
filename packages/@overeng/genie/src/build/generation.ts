import path from 'node:path'

import { Command, FileSystem } from '@effect/platform'
import { Effect, Option } from 'effect'

import { ensureImportMapResolver } from './discovery.ts'
import { GenieCheckError, GenieFileError, GenieImportError } from './errors.ts'
import type { GenerateSuccess, GenieContext } from './types.ts'

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
  if (isTdzError(error)) return false
  // Check if the stack trace includes this file path
  if (error instanceof Error) {
    return error.stack?.includes(filePath) ?? false
  }
  return false
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

  if (!oxfmtSupportedExtensions.has(ext)) {
    return content
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

  return result
})

/**
 * Find the nearest repo root for a genie file.
 * Prefers a local megarepo.json marker, falls back to .git.
 */
const findRepoRoot = Effect.fn('findRepoRoot')(function* ({
  startDir,
  cwd,
}: {
  startDir: string
  cwd: string
}) {
  const fs = yield* FileSystem.FileSystem
  let current = startDir
  let last = ''

  while (current !== last) {
    if (yield* fs.exists(path.join(current, 'megarepo.json'))) {
      return current
    }
    if (yield* fs.exists(path.join(current, '.git'))) {
      return current
    }
    last = current
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

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
 * Import a genie file and return its default export (the raw content string).
 *
 * A Bun import resolver is registered once so `#...` specifiers are resolved
 * using the import map closest to the importing file (including transitive imports).
 *
 * All genie files must export a function that takes GenieContext and returns a string.
 */
const importGenieFile = Effect.fn('importGenieFile')(function* ({
  genieFilePath,
  cwd,
}: {
  genieFilePath: string
  cwd: string
}) {
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
export const getExpectedContent = Effect.fn('getExpectedContent')(function* ({
  genieFilePath,
  cwd,
  oxfmtConfigPath,
}: {
  genieFilePath: string
  cwd: string
  oxfmtConfigPath: Option.Option<string>
}) {
  const targetFilePath = genieFilePath.replace('.genie.ts', '')
  const sourceFile = path.basename(genieFilePath)
  let rawContent = yield* importGenieFile({ genieFilePath, cwd })

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
})

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
}) =>
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
    if (!targetDirExists) {
      const reason = `Parent directory missing: ${targetDir}`
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
        return { _tag: 'created', targetFilePath } as const
      }
      if (isUnchanged) {
        return { _tag: 'unchanged', targetFilePath } as const
      }
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
      return { _tag: 'created', targetFilePath } as const
    }
    if (isUnchanged) {
      return { _tag: 'unchanged', targetFilePath } as const
    }

    return { _tag: 'updated', targetFilePath } as const
  }).pipe(
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
export const checkFile = Effect.fn('checkFile')(function* ({
  genieFilePath,
  cwd,
  oxfmtConfigPath,
}: {
  genieFilePath: string
  cwd: string
  oxfmtConfigPath: Option.Option<string>
}) {
  const fs = yield* FileSystem.FileSystem
  const { targetFilePath, content: expectedContent } = yield* getExpectedContent({
    genieFilePath,
    cwd,
    oxfmtConfigPath,
  })

  const fileExists = yield* fs.exists(targetFilePath)
  if (!fileExists) {
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
})
