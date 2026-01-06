import path from 'node:path'

import * as Cli from '@effect/cli'
import { Command, Error as PlatformError, FileSystem, Path } from '@effect/platform'
import * as PlatformNode from '@effect/platform-node'
import { Array as A, Effect, pipe, Schema, Stream } from 'effect'

/** Error when importing a .genie.ts file fails */
export class GenieImportError extends Schema.TaggedError<GenieImportError>()('GenieImportError', {
  genieFilePath: Schema.String,
  cause: Schema.Defect,
}) {
  override get message(): string {
    const causeMsg = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Failed to import ${this.genieFilePath}: ${causeMsg}`
  }
}

/** Error when generated file content doesn't match (in check mode) */
export class GenieCheckError extends Schema.TaggedError<GenieCheckError>()('GenieCheckError', {
  targetFilePath: Schema.String,
  message: Schema.String,
}) {}

/** Warning info for tsconfig references that don't match workspace dependencies */
type TsconfigReferencesWarning = {
  tsconfigPath: string
  missingReferences: string[]
  extraReferences: string[]
}

/** File extensions that oxfmt can format */
const oxfmtSupportedExtensions = new Set(['.json', '.jsonc', '.yml', '.yaml'])

/** Get the appropriate header comment for a generated file based on its extension */
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

/** oxfmt config file path (relative to cwd) */
const OXFMT_CONFIG = 'packages/@overeng/oxc-config/fmt.jsonc'

/** Format content using oxfmt if the file type is supported */
// oxlint-disable-next-line overeng/named-args -- simple internal helper
const formatWithOxfmt = (targetFilePath: string, content: string) =>
  Effect.gen(function* () {
    const ext = path.extname(targetFilePath)

    if (!oxfmtSupportedExtensions.has(ext)) {
      return content
    }

    const result = yield* Command.make(
      'oxfmt',
      '-c',
      OXFMT_CONFIG,
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

/** Directories to skip when searching for .genie.ts files */
const shouldSkipDirectory = (name: string): boolean => {
  if (name === 'node_modules' || name === 'dist' || name === 'tmp') return true
  if (name === '.git' || name === '.devenv' || name === '.direnv') return true
  return false
}

const findGenieFiles = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

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
          const stat = yield* fs.stat(fullPath)

          if (stat.type === 'Directory') {
            const nested = yield* walk(fullPath)
            results.push(...nested)
          } else if (isGenieFile(entry)) {
            results.push(fullPath)
          }
        }

        return results
      })

    return yield* walk(dir)
  }).pipe(Effect.withSpan('findGenieFiles'))

/** Import a genie file and return its default export (the raw content string) */
const importGenieFile = (genieFilePath: string) =>
  Effect.gen(function* () {
    /** Cache-bust the import to ensure we get fresh code on each regeneration */
    const importPath = `${genieFilePath}?import=${Date.now()}`

    const module = yield* Effect.tryPromise({
      // oxlint-disable-next-line eslint-plugin-import/no-dynamic-require -- dynamic import path required for genie
      try: () => import(importPath),
      catch: (error) => new GenieImportError({ genieFilePath, cause: error }),
    })

    return module.default as string
  })

const generateFile = ({
  genieFilePath,
  readOnly,
  cwd,
}: {
  genieFilePath: string
  readOnly: boolean
  cwd: string
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const targetFilePath = genieFilePath.replace('.genie.ts', '')
    const sourceFile = path.relative(cwd, genieFilePath)

    const rawContent = yield* importGenieFile(genieFilePath)
    const header = getHeaderComment(targetFilePath, sourceFile)
    const formattedContent = yield* formatWithOxfmt(targetFilePath, rawContent)
    const fileContentString = header + formattedContent

    yield* fs.remove(targetFilePath, { force: true })
    yield* fs.writeFileString(targetFilePath, fileContentString)
    yield* Effect.log(`Generated ${targetFilePath} ${readOnly ? '(read-only)' : '(writable)'}`)

    if (readOnly) {
      yield* fs.chmod(targetFilePath, 0o444)
    }
  }).pipe(Effect.withSpan('generateFile'))

const checkFile = ({ genieFilePath, cwd }: { genieFilePath: string; cwd: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const targetFilePath = genieFilePath.replace('.genie.ts', '')
    const sourceFile = path.relative(cwd, genieFilePath)

    const rawContent = yield* importGenieFile(genieFilePath)
    const header = getHeaderComment(targetFilePath, sourceFile)
    const formattedContent = yield* formatWithOxfmt(targetFilePath, rawContent)
    const expectedContent = header + formattedContent

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

/** Genie CLI command - generates files from .genie.ts source files */
export const genieCommand = Cli.Command.make(
  'genie',
  {
    cwd: Cli.Options.text('cwd').pipe(
      Cli.Options.withDescription('Working directory to search for .genie.ts files'),
      Cli.Options.withDefault(process.cwd()),
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
  },
  ({ cwd, writeable, watch, check }) =>
    Effect.gen(function* () {
      const readOnly = !writeable
      const fs = yield* FileSystem.FileSystem

      const genieFiles = yield* findGenieFiles(cwd)

      if (genieFiles.length === 0) {
        yield* Effect.log('No .genie.ts files found')
        return
      }

      yield* Effect.log(`Found ${genieFiles.length} .genie.ts files`)

      if (check) {
        yield* Effect.all(
          genieFiles.map((genieFilePath) => checkFile({ genieFilePath, cwd })),
          { concurrency: 'unbounded' },
        )
        yield* Effect.log('✓ All generated files are up to date')

        // Validate tsconfig references
        const warnings = yield* validateTsconfigReferences({ genieFiles, cwd })
        yield* logTsconfigWarnings(warnings)

        return
      }

      yield* Effect.all(
        genieFiles.map((genieFilePath) => generateFile({ genieFilePath, readOnly, cwd })),
        { concurrency: 'unbounded' },
      )

      if (watch) {
        yield* Effect.log('Watching for changes...')
        yield* pipe(
          fs.watch(cwd),
          Stream.filter(({ path: p }) => p.endsWith('.genie.ts')),
          Stream.tap(({ path: p }) => {
            const genieFilePath = path.join(cwd, p)
            return generateFile({ genieFilePath, readOnly, cwd })
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
      version: '0.1.0',
    })(process.argv),
    Effect.provide(PlatformNode.NodeContext.layer),
    PlatformNode.NodeRuntime.runMain,
  )
}
