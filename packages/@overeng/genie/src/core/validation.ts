import { type Error as PlatformError, FileSystem, Path } from '@effect/platform'
import { Effect } from 'effect'
import ts from 'typescript'

import type { GenieContext, GenieJsoncParser } from '../runtime/mod.ts'
import { nodeGenieIO, runActionlint } from '../runtime/node/mod.ts'
import { nodePackageJsonValidationRuntime } from '../runtime/package-json/node/export-environments.ts'
import { formatValidationIssues, type ValidationIssue } from '../runtime/package-json/validation.ts'

/**
 * Engine-side JSONC parser injected as the {@link GenieContext.parseJsonc} capability. Backed by the
 * TypeScript compiler's JSONC-aware parse so validators (e.g. tsconfig references) tolerate comment-headed
 * config files exactly as the previous `ts.readConfigFile` path did. Lives here (`src/core/`, the node engine)
 * rather than `src/runtime/` so the dependency-free runtime never value-imports typescript (issue #138).
 */
const nodeJsoncParser: GenieJsoncParser = ({ path, text }) => {
  const { config, error } = ts.parseConfigFileTextToJson(path, text)
  return error !== undefined ? undefined : config
}
import { findGenieFiles } from './discovery.ts'
import { GenieValidationError } from './errors.ts'
import type { GenieImportError } from './errors.ts'
import { loadGenieFile, type LoadedGenieFile } from './generation.ts'
import * as Observability from './observability.ts'
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
    yield* Observability.annotateValidation({
      cwd,
      requirePackageJsonValidate,
      ...(genieFiles === undefined ? {} : { fileCount: genieFiles.length }),
      ...(preloadedFiles === undefined ? {} : { preloadedFileCount: preloadedFiles.length }),
    })
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
    const workspaceProvider = yield* resolveWorkspaceProvider({ cwd })
    const packageJsonContext = yield* buildPackageJsonValidationContext({ cwd, workspaceProvider })
    const files =
      genieFiles === undefined
        ? (yield* findGenieFiles(cwd)).map((file) => pathService.join(cwd, file))
        : genieFiles
    const preloadedByPath = new Map(preloadedFiles?.map((file) => [file.genieFilePath, file]) ?? [])

    const issues: ValidationIssue[] = []

    for (const genieFilePath of files) {
      const targetFilePath = genieFilePath.replace('.genie.ts', '')
      const isPackageJson = pathService.basename(targetFilePath) === 'package.json'

      const loaded = yield* (() => {
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
          return Effect.void
        }),
      )

      if (loaded === undefined) continue

      const genieDir = pathService.dirname(genieFilePath)
      const location = pathService.relative(cwd, genieDir).replace(/\\/g, '/')

      const ctx: GenieContext = {
        cwd,
        location,
        workspace: {
          packages: packageJsonContext.packages,
          byName: packageJsonContext.byName,
        },
        io: nodeGenieIO,
        actionlint: runActionlint,
        parseJsonc: nodeJsoncParser,
        validation: {
          packageJson: nodePackageJsonValidationRuntime,
        },
      }

      if (loaded.output.validate !== undefined) {
        issues.push(...loaded.output.validate(ctx))
        continue
      }

      if (requirePackageJsonValidate === true && isPackageJson === true) {
        const pkgContent = yield* fs
          .readFileString(targetFilePath)
          .pipe(Effect.orElseSucceed(() => ''))
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
  }).pipe(
    Observability.withValidationSpan({
      cwd,
      requirePackageJsonValidate,
      ...(genieFiles === undefined ? {} : { fileCount: genieFiles.length }),
      ...(preloadedFiles === undefined ? {} : { preloadedFileCount: preloadedFiles.length }),
    }),
  )
