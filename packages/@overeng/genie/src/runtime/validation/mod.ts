import type { FileSystem, Path } from '@effect/platform'
import type { Effect } from 'effect'

import type { ValidationIssue } from '../package-json/validation.ts'

/** Supported workspace provider backends */
export type WorkspaceProviderName = 'pnpm' | 'bun' | 'manual'

/** Workspace provider that discovers package.json paths in a monorepo */
export type WorkspaceProvider = {
  name: WorkspaceProviderName
  discoverPackageJsonPaths: (args: {
    cwd: string
  }) => Effect.Effect<string[], Error, FileSystem.FileSystem | Path.Path>
}

/** Resolved package info from a workspace package.json */
export type PackageInfo = {
  name: string
  path: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  pnpm?: { patchedDependencies?: Record<string, string> }
}

/** A validation issue found during genie validation */
export type GenieValidationIssue = ValidationIssue
