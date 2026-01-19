import path from 'node:path'

import { FileSystem } from '@effect/platform'
import { Array as A, Effect } from 'effect'

import type { TsconfigReferencesWarning } from './types.ts'

/** Extract workspace dependencies from package.json content */
const getWorkspaceDependencies = (packageJsonContent: string): string[] => {
  try {
    const pkg = JSON.parse(packageJsonContent) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    return Object.entries(deps)
      .filter(([_, version]) => version === 'workspace:*' || version.startsWith('workspace:'))
      .map(([name]) => name)
  } catch {
    return []
  }
}

/** Extract references from tsconfig.json content */
const getTsconfigReferences = (tsconfigContent: string): string[] => {
  try {
    // Remove comments from JSON (tsconfig supports // comments)
    const withoutComments = tsconfigContent.replace(/\/\/.*$/gm, '')
    const tsconfig = JSON.parse(withoutComments) as {
      references?: Array<{ path: string }>
    }
    return (tsconfig.references ?? []).map((ref) => ref.path)
  } catch {
    return []
  }
}

/** Map package name to expected tsconfig reference path */
// oxlint-disable-next-line overeng/named-args -- simple internal mapper
const packageNameToReferencePath = (
  packageName: string,
  currentPackageDir: string,
  cwd: string,
): string | undefined => {
  // Common patterns for @overeng packages
  if (packageName.startsWith('@overeng/')) {
    const shortName = packageName.replace('@overeng/', '')
    const currentRelative = path.relative(cwd, currentPackageDir)

    // If current package is in packages/@overeng/*, sibling reference is ../{shortName}
    if (currentRelative.startsWith('packages/@overeng/')) {
      return `../${shortName}`
    }
  }
  return undefined
}

/** Validate tsconfig references against package.json workspace dependencies */
export const validateTsconfigReferences = Effect.fn('validateTsconfigReferences')(function* ({
  genieFiles,
  cwd,
}: {
  genieFiles: string[]
  cwd: string
}) {
  const fs = yield* FileSystem.FileSystem
  const warnings: TsconfigReferencesWarning[] = []

  // Find pairs of tsconfig.json.genie.ts and package.json.genie.ts in the same directory
  const tsconfigGenieFiles = genieFiles.filter((f) => f.endsWith('tsconfig.json.genie.ts'))

  for (const tsconfigGenieFile of tsconfigGenieFiles) {
    const dir = path.dirname(tsconfigGenieFile)
    const packageJsonPath = path.join(dir, 'package.json')
    const tsconfigPath = tsconfigGenieFile.replace('.genie.ts', '')

    // Check if package.json exists
    const packageJsonExists = yield* fs.exists(packageJsonPath)
    if (!packageJsonExists) continue

    // Check if tsconfig.json exists (generated)
    const tsconfigExists = yield* fs.exists(tsconfigPath)
    if (!tsconfigExists) continue

    const packageJsonContent = yield* fs.readFileString(packageJsonPath)
    const tsconfigContent = yield* fs.readFileString(tsconfigPath)

    const workspaceDeps = getWorkspaceDependencies(packageJsonContent)
    const currentReferences = getTsconfigReferences(tsconfigContent)

    // Convert workspace deps to expected reference paths
    const expectedReferences = workspaceDeps
      .map((dep) => packageNameToReferencePath(dep, dir, cwd))
      .filter((ref): ref is string => ref !== undefined)

    // Find missing and extra references
    const missingReferences = A.differenceWith<string>((a, b) => a === b)(
      expectedReferences,
      currentReferences,
    )
    const extraReferences = A.differenceWith<string>((a, b) => a === b)(
      currentReferences,
      expectedReferences,
    )

    if (missingReferences.length > 0 || extraReferences.length > 0) {
      warnings.push({
        tsconfigPath: path.relative(cwd, tsconfigPath),
        missingReferences,
        extraReferences,
      })
    }
  }

  return warnings
})

/** Log tsconfig reference warnings */
export const logTsconfigWarnings = Effect.fn('logTsconfigWarnings')(function* (
  warnings: TsconfigReferencesWarning[],
) {
  if (warnings.length === 0) return

  yield* Effect.log('')
  yield* Effect.log('⚠ Tsconfig reference warnings:')

  for (const warning of warnings) {
    yield* Effect.log(`  ${warning.tsconfigPath}:`)
    for (const missing of warning.missingReferences) {
      yield* Effect.log(`    - Missing reference: ${missing}`)
    }
    for (const extra of warning.extraReferences) {
      yield* Effect.log(`    - Extra reference (not in package.json deps): ${extra}`)
    }
  }

  yield* Effect.log('')
})
