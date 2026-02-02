import { FileSystem, Path } from '@effect/platform'
import { Effect } from 'effect'

import type { PackageInfo, WorkspaceProvider } from '../validation/mod.ts'

const normalizePath = (input: string): string => input.replace(/\\/g, '/')

/** Build validation context by reading all workspace package.json files into a lookup map */
export const buildPackageJsonValidationContext = Effect.fn(
  'genie/buildPackageJsonValidationContext',
)(function* ({ cwd, workspaceProvider }: { cwd: string; workspaceProvider: WorkspaceProvider }) {
  const fs = yield* FileSystem.FileSystem
  const pathService = yield* Path.Path
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
