import { FileSystem, Path } from '@effect/platform'
import { Effect } from 'effect'

import { formatValidationIssues, type ValidationIssue } from '../runtime/package-json/validation.ts'
import { recomposeValidationPlugin } from '../runtime/package-json/validators/recompose.ts'
import type {
  GenieValidationContext,
  GenieValidationPlugin,
  PackageInfo,
} from '../runtime/validation/mod.ts'
import { resolveWorkspaceProvider } from './workspace.ts'

const normalizePath = (input: string): string => input.replace(/\\/g, '/')

const buildPackageJsonContext = Effect.fn('genie/buildPackageJsonContext')(function* ({
  cwd,
}: {
  cwd: string
}) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
  const workspaceProvider = yield* resolveWorkspaceProvider({ cwd })
  const packageJsonPaths = yield* workspaceProvider.discoverPackageJsonPaths({ cwd })

  const packages: PackageInfo[] = []
  for (const packageJsonPath of packageJsonPaths) {
    const content = yield* fs
      .readFileString(packageJsonPath)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)))
    if (!content) continue
    const parsed = Effect.try({
      try: () => JSON.parse(content) as Omit<PackageInfo, 'path'>,
      catch: () => undefined,
    })
    const data = yield* parsed
    if (!data?.name) continue
    const pkgDir = pathService.dirname(packageJsonPath)
    const relativePath = pathService.relative(cwd, pkgDir)
    packages.push({ ...data, path: normalizePath(relativePath) })
  }

  const byName = new Map<string, PackageInfo>(packages.map((pkg) => [pkg.name, pkg]))

  return {
    packages,
    byName,
    workspaceProvider,
  }
})

const defaultPlugins = (): GenieValidationPlugin[] => [recomposeValidationPlugin()]

export const runGenieValidationPlugins = Effect.fn('genie/runValidationPlugins')(function* ({
  cwd,
  plugins,
}: {
  cwd: string
  plugins?: GenieValidationPlugin[]
}) {
  const activePlugins = plugins ?? defaultPlugins()
  const packageJsonContext = yield* buildPackageJsonContext({ cwd })

  const ctx: GenieValidationContext = {
    cwd,
    packageJson: packageJsonContext,
  }

  const pluginIssues = yield* Effect.all(
    activePlugins.map((plugin) =>
      Effect.tryPromise({
        try: async () => {
          if (plugin.scope !== 'package-json' && plugin.scope !== 'all') return []
          const result = await plugin.validate(ctx)
          return Array.isArray(result) ? result : []
        },
        catch: (error) => [
          {
            severity: 'error' as const,
            packageName: 'genie',
            dependency: plugin.name,
            message: `Validation plugin failed: ${error instanceof Error ? error.message : String(error)}`,
            rule: 'validation-plugin-error',
          } satisfies ValidationIssue,
        ],
      }),
    ),
    { concurrency: 'unbounded' },
  )

  const flattened = pluginIssues.flat()
  if (flattened.length > 0) {
    const formatted = formatValidationIssues(flattened)
    return yield* Effect.fail(new Error(`Genie validation failed:${formatted}`))
  }

  return flattened
})
