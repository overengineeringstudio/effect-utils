import type { FileSystem, Path } from '@effect/platform'
import type { Effect } from 'effect'

import type { ValidationIssue } from '../package-json/validation.ts'

export type WorkspaceProviderName = 'pnpm' | 'bun' | 'manual'

export type WorkspaceProvider = {
  name: WorkspaceProviderName
  discoverPackageJsonPaths: (args: {
    cwd: string
  }) => Effect.Effect<string[], Error, FileSystem.FileSystem | Path.Path>
}

export type PackageInfo = {
  name: string
  path: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  pnpm?: { patchedDependencies?: Record<string, string> }
}

export type GenieValidationContext = {
  cwd: string
  packageJson?: {
    packages: PackageInfo[]
    byName: Map<string, PackageInfo>
    workspaceProvider: WorkspaceProvider
  }
}

export type GenieValidationIssue = ValidationIssue
