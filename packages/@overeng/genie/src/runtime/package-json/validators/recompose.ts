import type { GenieValidationPlugin, PackageInfo } from '../../validation/mod.ts'
import { matchesAnyPattern, type ValidationIssue } from '../validation.ts'

type RecomposeValidatorConfig = {
  excludePackagePatterns?: string[]
}

const DEFAULT_EXCLUDES = ['examples/**', 'apps/**', 'docs/**', 'tests/**']

const isWorkspaceSpec = (spec: string): boolean =>
  spec.startsWith('workspace:') || spec.startsWith('file:') || spec.startsWith('link:')

const hasOptionalPeer = (
  meta: Record<string, { optional?: boolean }> | undefined,
  name: string,
): boolean => meta?.[name]?.optional === true

const shouldExclude = (path: string, patterns: string[]): boolean =>
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
    if (shouldExclude(upstream.path, args.excludePatterns)) continue

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
        hasOptionalPeer(upstream.peerDependenciesMeta, peer) &&
        !hasOptionalPeer(args.pkg.peerDependenciesMeta, peer)
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

export const recomposeValidationPlugin = (
  config: RecomposeValidatorConfig = {},
): GenieValidationPlugin => ({
  name: 'package-json-recompose',
  scope: 'package-json',
  validate: (ctx) => {
    const packageJson = ctx.packageJson
    if (!packageJson) return []

    const excludePatterns = config.excludePackagePatterns ?? DEFAULT_EXCLUDES
    const issues: ValidationIssue[] = []

    for (const pkg of packageJson.packages) {
      if (shouldExclude(pkg.path, excludePatterns)) continue
      issues.push(
        ...validatePackageRecomposition({
          pkg,
          packageMap: packageJson.byName,
          excludePatterns,
        }),
      )
    }

    return issues
  },
})
