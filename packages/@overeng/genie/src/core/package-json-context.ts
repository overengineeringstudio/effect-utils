import { FileSystem, Path } from '@effect/platform'
import { Effect } from 'effect'

import type { PackageInfo } from '../common/types.ts'

/** Workspace provider that discovers package.json paths in a monorepo */
export type WorkspaceProviderName = 'pnpm' | 'bun' | 'manual'

/** Workspace provider that discovers package.json paths in a monorepo */
export type WorkspaceProvider = {
  name: WorkspaceProviderName
  discoverPackageJsonPaths: (args: {
    cwd: string
  }) => Effect.Effect<string[], Error, FileSystem.FileSystem | Path.Path>
}

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
    if (content === undefined) continue
    const parsed = Effect.try({
      try: () => JSON.parse(content) as Omit<PackageInfo, 'path'>,
      catch: () => undefined,
    })
    const data = yield* parsed
    if (data === undefined || data.name === undefined) continue
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
