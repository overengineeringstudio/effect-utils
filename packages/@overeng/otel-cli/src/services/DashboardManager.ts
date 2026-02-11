/**
 * DashboardManager service
 *
 * Filesystem operations for syncing Grafana dashboard JSON files from project
 * source directories to the system-level ~/.local/state/otel/dashboards/ target.
 * Uses @effect/platform FileSystem + Path for all IO.
 */

import { FileSystem, Path } from '@effect/platform'
import { Data, Effect, Schema } from 'effect'

// =============================================================================
// Schemas
// =============================================================================

/** Manifest tracking synced dashboards for a project. */
export const DashboardManifest = Schema.Struct({
  project: Schema.String,
  source: Schema.String,
  syncedAt: Schema.String,
  dashboards: Schema.Array(
    Schema.Struct({
      filename: Schema.String,
    }),
  ),
})
export type DashboardManifest = typeof DashboardManifest.Type

/** Project-level config file (.otel/dashboards.json). */
export const DashboardProjectConfig = Schema.Struct({
  project: Schema.String,
  source: Schema.String,
})
export type DashboardProjectConfig = typeof DashboardProjectConfig.Type

// =============================================================================
// Errors
// =============================================================================

/** Error from dashboard provisioning operations (sync, list, remove, detect). */
export class DashboardError extends Data.TaggedError('DashboardError')<{
  readonly reason: 'NotFound' | 'ReadFailed' | 'WriteFailed' | 'ParseFailed'
  readonly message: string
  readonly cause?: unknown
}> {}

// =============================================================================
// Constants
// =============================================================================

const MANIFEST_FILENAME = '_manifest.json'

const getDefaultTarget = () => {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp'
  const stateHome = process.env['XDG_STATE_HOME'] ?? `${home}/.local/state`
  return `${stateHome}/otel/dashboards`
}

// =============================================================================
// Operations
// =============================================================================

/** Resolve ~ to home directory. */
const resolveHome = (p: string) =>
  Effect.sync(() => {
    if (p.startsWith('~/')) {
      const home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '/tmp'
      return `${home}${p.slice(1)}`
    }
    return p
  })

/** Sync dashboard JSON files from source to target/{project}/. */
export const sync = Effect.fn('DashboardManager.sync')(function* (opts: {
  project: string
  source: string
  target?: string
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const target = yield* resolveHome(opts.target ?? getDefaultTarget())
  const source = path.resolve(opts.source)
  const projectDir = path.join(target, opts.project)

  const sourceExists = yield* fs.exists(source)
  if (!sourceExists) {
    return yield* new DashboardError({
      reason: 'NotFound',
      message: `Source directory not found: ${source}`,
    })
  }

  yield* fs.makeDirectory(projectDir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DashboardError({
          reason: 'WriteFailed',
          message: `Failed to create project directory: ${projectDir}`,
          cause,
        }),
    ),
  )

  const entries = yield* fs.readDirectory(source).pipe(
    Effect.mapError(
      (cause) =>
        new DashboardError({
          reason: 'ReadFailed',
          message: `Failed to read source directory: ${source}`,
          cause,
        }),
    ),
  )

  const jsonFiles = entries.filter((f) => f.endsWith('.json'))
  const dashboards: Array<{ filename: string }> = []

  for (const filename of jsonFiles) {
    const srcPath = path.join(source, filename)
    const dstPath = path.join(projectDir, filename)

    const content = yield* fs.readFileString(srcPath).pipe(
      Effect.mapError(
        (cause) =>
          new DashboardError({
            reason: 'ReadFailed',
            message: `Failed to read dashboard: ${srcPath}`,
            cause,
          }),
      ),
    )

    yield* fs.writeFileString(dstPath, content).pipe(
      Effect.mapError(
        (cause) =>
          new DashboardError({
            reason: 'WriteFailed',
            message: `Failed to write dashboard: ${dstPath}`,
            cause,
          }),
      ),
    )

    dashboards.push({ filename })
  }

  const manifest: DashboardManifest = {
    project: opts.project,
    source,
    syncedAt: new Date().toISOString(),
    dashboards,
  }

  const manifestJson = yield* Schema.encode(Schema.parseJson(DashboardManifest, { space: 2 }))(
    manifest,
  )

  yield* fs.writeFileString(path.join(projectDir, MANIFEST_FILENAME), manifestJson).pipe(
    Effect.mapError(
      (cause) =>
        new DashboardError({
          reason: 'WriteFailed',
          message: `Failed to write manifest`,
          cause,
        }),
    ),
  )

  return manifest
})

/** List all synced projects from target directory. */
export const list = Effect.fn('DashboardManager.list')(function* (opts?: { target?: string }) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const target = yield* resolveHome(opts?.target ?? getDefaultTarget())
  const exists = yield* fs.exists(target)
  if (!exists) return []

  const entries = yield* fs.readDirectory(target).pipe(
    Effect.mapError(
      (cause) =>
        new DashboardError({
          reason: 'ReadFailed',
          message: `Failed to read target directory: ${target}`,
          cause,
        }),
    ),
  )

  const manifests: Array<DashboardManifest> = []

  for (const entry of entries) {
    const manifestPath = path.join(target, entry, MANIFEST_FILENAME)
    const manifestExists = yield* fs.exists(manifestPath)
    if (!manifestExists) continue

    const raw = yield* fs.readFileString(manifestPath).pipe(Effect.orElseSucceed(() => ''))
    if (raw.length === 0) continue

    const parsed = yield* Schema.decodeUnknown(Schema.parseJson(DashboardManifest))(raw).pipe(
      Effect.orElseSucceed(
        () =>
          ({
            project: entry,
            source: 'unknown',
            syncedAt: 'unknown',
            dashboards: [],
          }) satisfies DashboardManifest,
      ),
    )

    manifests.push(parsed)
  }

  return manifests
})

/** Remove a project's dashboards from the target directory. */
export const remove = Effect.fn('DashboardManager.remove')(function* (opts: {
  project: string
  target?: string
}) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const target = yield* resolveHome(opts.target ?? getDefaultTarget())
  const projectDir = path.join(target, opts.project)

  const exists = yield* fs.exists(projectDir)
  if (!exists) {
    return yield* new DashboardError({
      reason: 'NotFound',
      message: `Project not found: ${opts.project}`,
    })
  }

  yield* fs.remove(projectDir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new DashboardError({
          reason: 'WriteFailed',
          message: `Failed to remove project directory: ${projectDir}`,
          cause,
        }),
    ),
  )

  return { project: opts.project, removed: true }
})

/** Auto-detect project config from .otel/dashboards.json or fallback paths.
 *
 * Resolution order:
 * 1. .otel/dashboards.json config file (source path can use $OTEL_DASHBOARDS_DIR env var)
 * 2. OTEL_DASHBOARDS_DIR env var (Nix-built dashboard directory)
 * 3. .devenv/otel/dashboards/ directory
 */
export const detectProjectConfig = Effect.fn('DashboardManager.detectProjectConfig')(function* (
  cwd: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const configPath = path.join(cwd, '.otel', 'dashboards.json')
  const configExists = yield* fs.exists(configPath)

  if (configExists) {
    const raw = yield* fs.readFileString(configPath).pipe(
      Effect.mapError(
        (cause) =>
          new DashboardError({
            reason: 'ReadFailed',
            message: `Failed to read config: ${configPath}`,
            cause,
          }),
      ),
    )

    const config = yield* Schema.decodeUnknown(Schema.parseJson(DashboardProjectConfig))(raw).pipe(
      Effect.mapError(
        (cause) =>
          new DashboardError({
            reason: 'ParseFailed',
            message: `Invalid .otel/dashboards.json`,
            cause,
          }),
      ),
    )

    /* Resolve source: if it starts with $, expand the env var */
    let source = config.source
    if (source.startsWith('$')) {
      const envVar = source.includes('/') ? source.slice(1, source.indexOf('/')) : source.slice(1)
      const envVal = process.env[envVar]
      if (envVal) {
        source = source.includes('/') ? `${envVal}${source.slice(source.indexOf('/'))}` : envVal
      }
    }

    return {
      project: config.project,
      source: path.resolve(cwd, source),
    }
  }

  /* Fallback: OTEL_DASHBOARDS_DIR env var (set by Nix devenv module) */
  const nixDashboardsDir = process.env['OTEL_DASHBOARDS_DIR']
  if (nixDashboardsDir) {
    const dirExists = yield* fs.exists(nixDashboardsDir)
    if (dirExists) {
      const project = path.basename(cwd)
      return { project, source: nixDashboardsDir }
    }
  }

  /* Fallback: check .devenv/otel/dashboards/ */
  const devenvPath = path.join(cwd, '.devenv', 'otel', 'dashboards')
  const devenvExists = yield* fs.exists(devenvPath)

  if (devenvExists) {
    const project = path.basename(cwd)
    return { project, source: devenvPath }
  }

  return yield* new DashboardError({
    reason: 'NotFound',
    message: `No dashboard config found. Create .otel/dashboards.json, set OTEL_DASHBOARDS_DIR, or have .devenv/otel/dashboards/ present.`,
  })
})
