import { type Error as PlatformError, FileSystem, Path } from '@effect/platform'
import { Effect } from 'effect'

import type { GenieContext } from '../runtime/mod.ts'
import { formatValidationIssues, type ValidationIssue } from '../runtime/package-json/validation.ts'
import type { GenieValidationIssue } from '../runtime/validation/mod.ts'
import { buildPackageJsonValidationContext } from './package-json-context.ts'
import { findGenieFiles } from './discovery.ts'
import { GenieImportError, GenieValidationError } from './errors.ts'
import { resolveWorkspaceProvider } from './workspace.ts'

const importGenieOutput = Effect.fn('genie/importGenieOutput')(function* ({
  genieFilePath,
  cwd,
}: {
  genieFilePath: string
  cwd: string
}) {
  const importPath = `${genieFilePath}?import=${Date.now()}`
  const module = yield* Effect.tryPromise({
    // oxlint-disable-next-line eslint-plugin-import/no-dynamic-require -- dynamic import path required for genie
    try: () => import(importPath),
    catch: (error) =>
      new GenieImportError({
        genieFilePath,
        message: `Failed to import ${genieFilePath}: ${error instanceof Error ? error.message : String(error)}`,
        cause: error,
      }),
  })

  const exported = module.default
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

  return exported as {
    data: unknown
    validate?: (ctx: GenieContext) => GenieValidationIssue[]
  }
})

export const runGenieValidation = ({
  cwd,
  requirePackageJsonValidate = process.env.GENIE_REQUIRE_PACKAGE_JSON_VALIDATE === '1',
}: {
  cwd: string
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
    const genieFiles = yield* findGenieFiles(cwd)

    const issues: ValidationIssue[] = []

    for (const genieFilePath of genieFiles) {
      const targetFilePath = genieFilePath.replace('.genie.ts', '')
      const isPackageJson = pathService.basename(targetFilePath) === 'package.json'

      // Compute repo-relative location for this genie file
      const genieDir = pathService.dirname(genieFilePath)
      const location = pathService.relative(cwd, genieDir).replace(/\\/g, '/')

      // Create per-file context with location and workspace data
      const ctx: GenieContext = {
        cwd,
        location,
        workspace: {
          packages: packageJsonContext.packages,
          byName: packageJsonContext.byName,
        },
      }

      const output = yield* importGenieOutput({ genieFilePath, cwd }).pipe(
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

      if (!output) continue
      if (output.validate) {
        issues.push(...output.validate(ctx))
        continue
      }

      if (requirePackageJsonValidate && isPackageJson) {
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
