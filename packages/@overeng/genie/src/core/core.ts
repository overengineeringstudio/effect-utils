import os from 'node:os'
import path from 'node:path'

import { type Error as PlatformError, FileSystem } from '@effect/platform'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import type { Path } from '@effect/platform/Path'
import { Effect, Either, Option, Ref } from 'effect'

import { assertNever } from '@overeng/utils'

import { findGenieFiles } from './discovery.ts'
import { GenieGenerationFailedError } from './errors.ts'
import { type GenieEventBus, emit } from './events.ts'
import {
  checkFile,
  checkFileDetailed,
  errorOriginatesInFile,
  generateFile,
  type LoadedGenieFile,
  isTdzError,
} from './generation.ts'
import type { GenieFileStatus, GenieSummary } from './schema.ts'
import type { GenerateSuccess } from './types.ts'
import { runGenieValidation } from './validation.ts'

// ---------------------------------------------------------------------------
// Shared helpers (used by both core and CLI watch mode)
// ---------------------------------------------------------------------------

/** Convention paths for oxfmt config relative to workspace root (checked in order) */
export const OXFMT_CONFIG_CONVENTION_PATHS = ['.oxfmtrc.json', 'oxfmt.json']

/** Resolve the oxfmt config path: explicit option → convention paths → none */
export const resolveOxfmtConfigPath = Effect.fn('resolveOxfmtConfigPath')(function* ({
  explicitPath,
  cwd,
}: {
  explicitPath: Option.Option<string>
  cwd: string
}) {
  if (Option.isSome(explicitPath) === true) return explicitPath
  const fs = yield* FileSystem.FileSystem
  for (const conventionPath of OXFMT_CONFIG_CONVENTION_PATHS) {
    const fullPath = path.join(cwd, conventionPath)
    if ((yield* fs.exists(fullPath)) === true) return Option.some(fullPath)
  }
  return Option.none()
})

/** Map generation result tag to file status */
export const mapResultToStatus = (result: { _tag: string }): GenieFileStatus => {
  switch (result._tag) {
    case 'created':
      return 'created'
    case 'updated':
      return 'updated'
    case 'unchanged':
      return 'unchanged'
    case 'skipped':
      return 'skipped'
    default:
      return 'error'
  }
}

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** Internal options passed to the core generation pipeline. */
export type CoreGenerateOptions = {
  cwd: string
  readOnly: boolean
  dryRun: boolean
  oxfmtConfigPath: Option.Option<string>
}

/** Internal options passed to the core check (up-to-date verification) pipeline. */
export type CoreCheckOptions = {
  cwd: string
  oxfmtConfigPath: Option.Option<string>
}

/** Aggregate result of a full generation run including per-file outcomes and summary counts. */
export type GenieGenerateResult = {
  summary: GenieSummary
  files: Array<GenerateSuccess>
}

// ---------------------------------------------------------------------------
// Shared orchestration
// ---------------------------------------------------------------------------

/** Discover genie files and assert no duplicate targets. */
const discoverAndValidate = Effect.fn('genie/discoverAndValidate')(function* (cwd: string) {
  const genieFiles = yield* findGenieFiles(cwd)

  const targetCounts = new Map<string, number>()
  for (const genieFilePath of genieFiles) {
    const targetFilePath = genieFilePath.replace('.genie.ts', '')
    targetCounts.set(targetFilePath, (targetCounts.get(targetFilePath) ?? 0) + 1)
  }
  const duplicateTargets = Array.from(targetCounts.entries()).filter(([, count]) => count > 1)
  assertNever({
    condition: duplicateTargets.length === 0,
    msg: () =>
      `Duplicate genie targets detected: ${duplicateTargets
        .map(([target, count]) => `${target} (${count}x)`)
        .join(', ')}`,
  })

  return genieFiles
})

/** Compute summary counts from a list of successes and a failure count. */
const computeSummary = ({
  successes,
  failedCount,
}: {
  successes: Array<GenerateSuccess>
  failedCount: number
}): GenieSummary => ({
  created: successes.filter((s) => s._tag === 'created').length,
  updated: successes.filter((s) => s._tag === 'updated').length,
  unchanged: successes.filter((s) => s._tag === 'unchanged').length,
  skipped: successes.filter((s) => s._tag === 'skipped').length,
  failed: failedCount,
})

/** Run validation and emit error event on failure. Returns the error effect if validation fails. */
const runValidationOrFail = Effect.fn('genie/runValidationOrFail')(function* ({
  cwd,
  genieFiles,
  preloadedFiles,
}: {
  cwd: string
  genieFiles?: ReadonlyArray<string>
  preloadedFiles?: ReadonlyArray<LoadedGenieFile>
}) {
  const validationResult = yield* runGenieValidation({ cwd, genieFiles, preloadedFiles }).pipe(
    Effect.either,
  )
  if (Either.isLeft(validationResult) === true) {
    const error = validationResult.left
    const message = error instanceof Error ? error.message : String(error)
    yield* emit({ _tag: 'Error', message })
    return yield* new GenieGenerationFailedError({
      failedCount: 1,
      message,
      files: [],
    })
  }
})

/** Generate files from all discovered .genie.ts sources. */
export const generateAll = ({
  cwd,
  readOnly,
  dryRun,
  oxfmtConfigPath,
}: CoreGenerateOptions): Effect.Effect<
  GenieGenerateResult,
  GenieGenerationFailedError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path | CommandExecutor.CommandExecutor | GenieEventBus
> =>
  Effect.gen(function* () {
    const genieFiles = yield* discoverAndValidate(cwd)

    if (genieFiles.length === 0) {
      const summary = computeSummary({ successes: [], failedCount: 0 })
      yield* emit({ _tag: 'Complete', summary })
      return { summary, files: [] }
    }

    yield* emit({
      _tag: 'FilesDiscovered',
      files: genieFiles.map((fp) => ({
        path: fp,
        relativePath: path.relative(cwd, fp.replace('.genie.ts', '')),
      })),
    })

    // Generate all files concurrently
    const results = yield* Effect.all(
      genieFiles.map((genieFilePath) =>
        Effect.gen(function* () {
          yield* emit({ _tag: 'FileStarted', path: genieFilePath })

          const result = yield* generateFile({
            genieFilePath,
            cwd,
            readOnly,
            dryRun,
            oxfmtConfigPath,
          }).pipe(Effect.either)

          if (Either.isRight(result) === true) {
            const status = mapResultToStatus(result.right)
            yield* emit({
              _tag: 'FileCompleted',
              path: genieFilePath,
              status,
              ...(result.right._tag === 'updated' && result.right.diffSummary !== undefined
                ? { message: result.right.diffSummary }
                : {}),
            })
          } else {
            yield* emit({
              _tag: 'FileCompleted',
              path: genieFilePath,
              status: 'error',
              message: result.left.message,
            })
          }

          return result
        }),
      ),
      { concurrency: 'unbounded' },
    )

    const successes = results.filter(Either.isRight).map((r) => r.right)
    const failures = results.filter(Either.isLeft).map((r) => r.left)

    // Handle TDZ errors with sequential re-validation
    const hasTdzErrors = failures.some((f) => isTdzError(f.cause))

    if (failures.length > 0 && hasTdzErrors === true) {
      const revalidateErrors: Array<{
        genieFilePath: string
        error: ReturnType<typeof checkFile> extends Effect.Effect<any, infer E, any> ? E : never
        isRootCause: boolean
      }> = []

      for (const genieFilePath of genieFiles) {
        const result = yield* checkFile({ genieFilePath, cwd, oxfmtConfigPath }).pipe(Effect.either)

        if (Either.isLeft(result) === true) {
          revalidateErrors.push({
            genieFilePath,
            error: result.left,
            isRootCause: errorOriginatesInFile({ error: result.left, filePath: genieFilePath }),
          })
        }
      }

      const rootCauses = revalidateErrors.filter((e) => e.isRootCause)
      const dependentCount = revalidateErrors.length - rootCauses.length

      // Update state with revalidated errors
      for (const { genieFilePath, error, isRootCause } of revalidateErrors) {
        yield* emit({
          _tag: 'FileCompleted',
          path: genieFilePath,
          status: 'error',
          message: isRootCause === true ? error.message : 'Failed due to dependency error',
        })
      }

      const summary = computeSummary({ successes, failedCount: revalidateErrors.length })
      yield* emit({ _tag: 'Complete', summary })

      return yield* new GenieGenerationFailedError({
        failedCount: revalidateErrors.length,
        message: `${rootCauses.length} root cause error(s), ${dependentCount} dependent failure(s)`,
        files: genieFiles.map((p) => {
          const reErr = revalidateErrors.find((e) => e.genieFilePath === p)
          return {
            path: p,
            relativePath: path.relative(cwd, p.replace('.genie.ts', '')),
            status: (reErr !== undefined ? 'error' : 'unchanged') as GenieFileStatus,
            message:
              reErr !== undefined
                ? reErr.isRootCause === true
                  ? reErr.error.message
                  : 'Failed due to dependency error'
                : undefined,
          }
        }),
      })
    }

    // No TDZ errors
    const summary = computeSummary({ successes, failedCount: failures.length })

    if (summary.failed > 0) {
      yield* emit({ _tag: 'Complete', summary })
      return yield* new GenieGenerationFailedError({
        failedCount: summary.failed,
        message: `${summary.failed} file(s) failed to generate`,
        files: genieFiles.map((p, i) => {
          const resultEither = results[i]!
          if (Either.isRight(resultEither) === true) {
            return {
              path: p,
              relativePath: path.relative(cwd, p.replace('.genie.ts', '')),
              status: mapResultToStatus(resultEither.right),
            }
          }
          return {
            path: p,
            relativePath: path.relative(cwd, p.replace('.genie.ts', '')),
            status: 'error' as GenieFileStatus,
            message: resultEither.left.message,
          }
        }),
      })
    }

    // Run validation hooks after successful generation
    if (dryRun === false) {
      yield* runValidationOrFail({ cwd, genieFiles })
    }

    yield* emit({ _tag: 'Complete', summary })
    return { summary, files: successes }
  }).pipe(Effect.withSpan('genie/generateAll'))

/** Check that all generated files are up to date. */
export const checkAll = ({
  cwd,
  oxfmtConfigPath,
}: CoreCheckOptions): Effect.Effect<
  void,
  GenieGenerationFailedError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path | CommandExecutor.CommandExecutor | GenieEventBus
> =>
  Effect.gen(function* () {
    const checkConcurrency = Math.max(
      1,
      Math.min(
        typeof os.availableParallelism === 'function'
          ? os.availableParallelism()
          : os.cpus().length,
        12,
      ),
    )

    const genieFiles = yield* discoverAndValidate(cwd)

    if (genieFiles.length === 0) {
      yield* emit({ _tag: 'Complete', summary: computeSummary({ successes: [], failedCount: 0 }) })
      return
    }

    yield* emit({
      _tag: 'FilesDiscovered',
      files: genieFiles.map((fp) => ({
        path: fp,
        relativePath: path.relative(cwd, fp.replace('.genie.ts', '')),
      })),
    })

    type FileCheckResult =
      | {
          _tag: 'success'
          path: string
          loadedGenieFile: LoadedGenieFile
        }
      | {
          _tag: 'error'
          path: string
          message: string
        }

    type FatalCheckFailure = {
      _tag: 'FatalCheckFailure'
      path: string
      message: string
    }

    const completedPathsRef = yield* Ref.make(new Set<string>())
    const resultByPathRef = yield* Ref.make(new Map<string, FileCheckResult>())

    const completeFile = Effect.fn('genie/checkAll/completeFile')(function* ({
      path,
      result,
    }: {
      path: string
      result: FileCheckResult
    }) {
      yield* emit({
        _tag: 'FileCompleted',
        path,
        status: result._tag === 'success' ? ('unchanged' as const) : ('error' as const),
        ...(result._tag === 'error' ? { message: result.message } : {}),
      })
      yield* Ref.update(resultByPathRef, (prev) => {
        const next = new Map(prev)
        next.set(path, result)
        return next
      })
      yield* Ref.update(completedPathsRef, (prev) => {
        const next = new Set(prev)
        next.add(path)
        return next
      })
    })

    const checkResult = yield* Effect.forEach(
      genieFiles,
      (genieFilePath) =>
        Effect.gen(function* () {
          yield* emit({ _tag: 'FileStarted', path: genieFilePath })

          const result = yield* checkFileDetailed({ genieFilePath, cwd, oxfmtConfigPath }).pipe(
            Effect.either,
          )

          if (Either.isRight(result) === true) {
            yield* completeFile({
              path: genieFilePath,
              result: {
                _tag: 'success',
                path: genieFilePath,
                loadedGenieFile: result.right.loadedGenieFile,
              },
            })
            return
          }

          const errorResult: FileCheckResult = {
            _tag: 'error',
            path: genieFilePath,
            message: result.left.message,
          }
          yield* completeFile({ path: genieFilePath, result: errorResult })

          if (result.left._tag === 'GenieCheckError') {
            return
          }

          return yield* Effect.fail<FatalCheckFailure>({
            _tag: 'FatalCheckFailure',
            path: genieFilePath,
            message: result.left.message,
          })
        }),
      { concurrency: checkConcurrency },
    ).pipe(Effect.either)

    if (Either.isLeft(checkResult) === true) {
      const completedPaths = yield* Ref.get(completedPathsRef)
      const interruptedPaths = genieFiles.filter((p) => !completedPaths.has(p))

      for (const interruptedPath of interruptedPaths) {
        yield* completeFile({
          path: interruptedPath,
          result: {
            _tag: 'error',
            path: interruptedPath,
            message: 'Cancelled due to fatal error in another file',
          },
        })
      }

      const allResults = yield* Ref.get(resultByPathRef)
      const failed = Array.from(allResults.values()).filter((r) => r._tag === 'error').length
      const unchanged = Array.from(allResults.values()).filter((r) => r._tag === 'success').length

      const summary: GenieSummary = {
        created: 0,
        updated: 0,
        unchanged,
        skipped: 0,
        failed,
      }
      yield* emit({ _tag: 'Complete', summary })

      return yield* new GenieGenerationFailedError({
        failedCount: failed,
        message:
          interruptedPaths.length > 0
            ? `Fatal check error in ${path.relative(cwd, checkResult.left.path)}; interrupted ${interruptedPaths.length} sibling file(s)`
            : `Fatal check error in ${path.relative(cwd, checkResult.left.path)}`,
        files: genieFiles.map((p) => {
          const r = allResults.get(p)
          return {
            path: p,
            relativePath: path.relative(cwd, p.replace('.genie.ts', '')),
            status: (r?._tag === 'success' ? 'unchanged' : 'error') as GenieFileStatus,
            message: r?._tag === 'error' ? r.message : undefined,
          }
        }),
      })
    }

    const resultByPath = yield* Ref.get(resultByPathRef)
    const failed = Array.from(resultByPath.values()).filter((r) => r._tag === 'error').length

    if (failed > 0) {
      const summary: GenieSummary = {
        created: 0,
        updated: 0,
        unchanged: Array.from(resultByPath.values()).filter((r) => r._tag === 'success').length,
        skipped: 0,
        failed,
      }
      yield* emit({ _tag: 'Complete', summary })
      return yield* new GenieGenerationFailedError({
        failedCount: failed,
        message: `${failed} file(s) are out of date`,
        files: genieFiles.map((p) => {
          const r = resultByPath.get(p)
          return {
            path: p,
            relativePath: path.relative(cwd, p.replace('.genie.ts', '')),
            status: (r?._tag === 'success' ? 'unchanged' : 'error') as GenieFileStatus,
            message: r?._tag === 'error' ? r.message : undefined,
          }
        }),
      })
    }

    const preloadedFiles = Array.from(resultByPath.values())
      .filter((result): result is Extract<FileCheckResult, { _tag: 'success' }> => {
        return result._tag === 'success'
      })
      .map((result) => result.loadedGenieFile)

    yield* runValidationOrFail({ cwd, genieFiles, preloadedFiles })

    const summary: GenieSummary = {
      created: 0,
      updated: 0,
      unchanged: preloadedFiles.length,
      skipped: 0,
      failed: 0,
    }
    yield* emit({ _tag: 'Complete', summary })
  }).pipe(Effect.withSpan('genie/checkAll'))
