import { FileSystem } from '@effect/platform'
import { Effect, Schema } from 'effect'

/** pnpm-compose configuration schema (optional) */
export const PnpmComposeConfig = Schema.Struct({
  /** Submodule paths to exclude from composition */
  exclude: Schema.optional(Schema.Array(Schema.String)),
})

export type PnpmComposeConfig = typeof PnpmComposeConfig.Type

/** Default config file name */
export const CONFIG_FILE_NAME = 'pnpm-compose.config.ts'

/** Detected composed repo from .gitmodules */
export interface ComposedRepo {
  /** Submodule name (from .gitmodules section header) */
  name: string
  /** Path to the submodule (relative to workspace root) */
  path: string
}

/** Load optional config from pnpm-compose.config.ts */
export const loadConfig = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const configPath = `${cwd}/${CONFIG_FILE_NAME}`

    const exists = yield* fs.exists(configPath)
    if (!exists) {
      return { exclude: [] } satisfies PnpmComposeConfig
    }

    // Dynamic import the config file
    const configModule = yield* Effect.tryPromise({
      try: () => import(configPath),
      catch: (error) => new ConfigLoadError({ path: configPath, cause: error }),
    })

    const config = configModule.default as unknown

    // Validate against schema
    return yield* Schema.decodeUnknown(PnpmComposeConfig)(config).pipe(
      Effect.mapError((error) => new ConfigValidationError({ path: configPath, cause: error })),
    )
  }).pipe(Effect.withSpan('loadConfig'))

/** Parse .gitmodules file to extract submodule paths */
export const parseGitmodules = (cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const gitmodulesPath = `${cwd}/.gitmodules`

    const exists = yield* fs.exists(gitmodulesPath)
    if (!exists) {
      return []
    }

    const content = yield* fs.readFileString(gitmodulesPath)
    const submodules: ComposedRepo[] = []

    let currentName: string | undefined
    const lines = content.split('\n')

    for (const line of lines) {
      const sectionMatch = line.match(/\[submodule\s+"([^"]+)"\]/)
      if (sectionMatch) {
        currentName = sectionMatch[1]
        continue
      }

      const pathMatch = line.match(/^\s*path\s*=\s*(.+)$/)
      if (pathMatch && currentName) {
        const path = pathMatch[1]!.trim()
        // Use last part of path as name (e.g., "submodules/foo" -> "foo")
        const name = path.split('/').pop() ?? currentName
        submodules.push({ name, path })
        currentName = undefined
      }
    }

    return submodules
  }).pipe(Effect.withSpan('parseGitmodules'))

/** Detect composed repos from .gitmodules, filtered by exclude list */
export const detectComposedRepos = (cwd: string) =>
  Effect.gen(function* () {
    const config = yield* loadConfig(cwd)
    const submodules = yield* parseGitmodules(cwd)
    const excludeSet = new Set(config.exclude ?? [])

    return submodules.filter((sub) => !excludeSet.has(sub.path))
  }).pipe(Effect.withSpan('detectComposedRepos'))

/** Error when config file fails to load */
export class ConfigLoadError extends Schema.TaggedError<ConfigLoadError>()('ConfigLoadError', {
  path: Schema.String,
  cause: Schema.Defect,
}) {
  override get message(): string {
    return `Failed to load config: ${this.path}`
  }
}

/** Error when config validation fails */
export class ConfigValidationError extends Schema.TaggedError<ConfigValidationError>()(
  'ConfigValidationError',
  {
    path: Schema.String,
    cause: Schema.Defect,
  },
) {
  override get message(): string {
    return `Invalid config in ${this.path}`
  }
}
