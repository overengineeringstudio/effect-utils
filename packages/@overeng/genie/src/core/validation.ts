import { type Error as PlatformError, FileSystem, Path } from '@effect/platform'
import { Effect } from 'effect'

import type { GenieContext } from '../runtime/mod.ts'
import { formatValidationIssues, type ValidationIssue } from '../runtime/package-json/validation.ts'
import { findGenieFiles } from './discovery.ts'
import { GenieValidationError } from './errors.ts'
import type { GenieImportError } from './errors.ts'
import { loadGenieFile, type LoadedGenieFile } from './generation.ts'
import { buildPackageJsonValidationContext } from './package-json-context.ts'
import { resolveWorkspaceProvider } from './workspace.ts'

/** Import all genie files in a workspace and run their validation hooks, collecting any issues. */
export const runGenieValidation = ({
  cwd,
  genieFiles,
  preloadedFiles,
  requirePackageJsonValidate = process.env.GENIE_REQUIRE_PACKAGE_JSON_VALIDATE === '1',
}: {
  cwd: string
  genieFiles?: ReadonlyArray<string>
  preloadedFiles?: ReadonlyArray<LoadedGenieFile>
  requirePackageJsonValidate?: boolean
}): Effect.Effect<
  ValidationIssue[],
  GenieValidationError | GenieImportError | PlatformError.PlatformError | Error | undefined,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const workspaceProvider = yield* resolveWorkspaceProvider({ cwd })
    const packageJsonContext = yield* buildPackageJsonValidationContext({ cwd, workspaceProvider })
    const files = genieFiles === undefined ? yield* findGenieFiles(cwd) : genieFiles
    const preloadedByPath = new Map(preloadedFiles?.map((file) => [file.genieFilePath, file]) ?? [])

    const issues: ValidationIssue[] = []

    for (const genieFilePath of files) {
      const targetFilePath = genieFilePath.replace('.genie.ts', '')
      const isPackageJson = pathService.basename(targetFilePath) === 'package.json'

      const loaded = yield* ((): Effect.Effect<LoadedGenieFile, GenieImportError> => {
        const preloaded = preloadedByPath.get(genieFilePath)
        if (preloaded !== undefined) {
          return Effect.succeed(preloaded)
        }
        return loadGenieFile({ genieFilePath, cwd })
      })().pipe(
        Effect.catchAll((error) => {
          issues.push({
            severity: 'error',
            packageName: 'genie',
            dependency: genieFilePath,
            message: `Validation import failed: ${error instanceof Error ? error.message : String(error)}`,
            rule: 'validation-import',
          })
          return Effect.succeed(undefined)
        }),
      )

      if (loaded === undefined) continue

      // Create per-file context with location and workspace data
      const ctx: GenieContext = {
        cwd,
        location: loaded.ctx.location,
        workspace: {
          packages: packageJsonContext.packages,
          byName: packageJsonContext.byName,
        },
      }

      if (loaded.output.validate !== undefined) {
        issues.push(...loaded.output.validate(ctx))
        continue
      }

      if (requirePackageJsonValidate === true && isPackageJson === true) {
        const pkgContent = yield* fs
          .readFileString(targetFilePath)
          .pipe(Effect.catchAll(() => Effect.succeed('')))
        const pkgName = (() => {
          try {
            return JSON.parse(pkgContent)?.name as string | undefined
          } catch {
            return undefined
          }
        })()

        issues.push({
          severity: 'error',
          packageName: pkgName ?? 'unknown',
          dependency: targetFilePath,
          message: 'Missing package.json validate hook (self-contained validation required)',
          rule: 'package-json-validate-missing',
        })
      }
    }

    const errors = issues.filter((i) => i.severity === 'error')
    if (errors.length > 0) {
      const formatted = formatValidationIssues(issues)
      return yield* new GenieValidationError({ message: `Genie validation failed:${formatted}` })
    }

    return issues
  }).pipe(Effect.withSpan('genie/runValidation'))
