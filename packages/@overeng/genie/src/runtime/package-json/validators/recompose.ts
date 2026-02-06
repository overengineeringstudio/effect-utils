import type { PackageInfo } from '../../../common/types.ts'
import type { GenieContext } from '../../mod.ts'
import { matchesAnyPattern, type ValidationIssue } from '../validation.ts'

type RecomposeValidatorConfig = {
  excludePackagePatterns?: string[]
}

const DEFAULT_EXCLUDES = ['examples/**', 'apps/**', 'docs/**', 'tests/**']

const isWorkspaceSpec = (spec: string): boolean =>
  spec.startsWith('workspace:') || spec.startsWith('file:') || spec.startsWith('link:')

const hasOptionalPeer = ({
  meta,
  name,
}: {
  meta: Record<string, { optional?: boolean }> | undefined
  name: string
}): boolean => meta?.[name]?.optional === true

const shouldExclude = ({ path, patterns }: { path: string; patterns: string[] }): boolean =>
  matchesAnyPattern({ name: path, patterns })

const validatePackageRecomposition = (args: {
  pkg: PackageInfo
  packageMap: Map<string, PackageInfo>
  excludePatterns: string[]
}): ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  const deps = {
    ...args.pkg.dependencies,
    ...args.pkg.optionalDependencies,
  }

  for (const [depName, spec] of Object.entries(deps)) {
    if (!isWorkspaceSpec(spec)) continue
    const upstream = args.packageMap.get(depName)
    if (!upstream) continue
    if (shouldExclude({ path: upstream.path, patterns: args.excludePatterns })) continue

    const upstreamPeers = Object.keys(upstream.peerDependencies ?? {})
    for (const peer of upstreamPeers) {
      if (!args.pkg.peerDependencies || !(peer in args.pkg.peerDependencies)) {
        issues.push({
          severity: 'error',
          packageName: args.pkg.name,
          dependency: peer,
          message: `Missing peer dep "${peer}" required by "${depName}"`,
          rule: 'recompose-peer-deps',
        })
        continue
      }

      if (
        hasOptionalPeer({ meta: upstream.peerDependenciesMeta, name: peer }) &&
        !hasOptionalPeer({ meta: args.pkg.peerDependenciesMeta, name: peer })
      ) {
        issues.push({
          severity: 'error',
          packageName: args.pkg.name,
          dependency: peer,
          message: `Missing optional peer meta for "${peer}" required by "${depName}"`,
          rule: 'recompose-peer-meta',
        })
      }
    }

    const upstreamPatches = upstream.pnpm?.patchedDependencies ?? {}
    const downstreamPatches = args.pkg.pnpm?.patchedDependencies ?? {}
    for (const patchName of Object.keys(upstreamPatches)) {
      if (!(patchName in downstreamPatches)) {
        issues.push({
          severity: 'error',
          packageName: args.pkg.name,
          dependency: patchName,
          message: `Missing patch "${patchName}" required by "${depName}"`,
          rule: 'recompose-patches',
        })
      }
    }
  }

  return issues
}

/**
 * Validate that a package properly re-exports peer dependencies and patches from its workspace dependencies.
 *
 * Checks that downstream packages declare all peer deps and patched dependencies
 * required by their upstream workspace dependencies.
 */
export const validatePackageRecompositionForPackage = ({
  ctx,
  pkgName,
  config = {},
}: {
  ctx: GenieContext
  pkgName: string
  config?: RecomposeValidatorConfig
}): ValidationIssue[] => {
  const workspace = ctx.workspace
  if (!workspace) return []

  const excludePatterns = config.excludePackagePatterns ?? DEFAULT_EXCLUDES
  const pkg = workspace.byName.get(pkgName)
  if (!pkg) return []
  if (shouldExclude({ path: pkg.path, patterns: excludePatterns })) return []

  return validatePackageRecomposition({
    pkg,
    packageMap: workspace.byName,
    excludePatterns,
  })
}
