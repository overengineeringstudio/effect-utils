import type { PackageInfo } from '../../../common/types.ts'
import type { GenieContext } from '../../mod.ts'
import type { ValidationIssue } from '../validation.ts'

const isWorkspaceSpec = (spec: string): boolean =>
  spec.startsWith('workspace:') || spec.startsWith('file:') || spec.startsWith('link:')

const hasOptionalPeer = ({
  meta,
  name,
}: {
  meta: Record<string, { optional?: boolean }> | undefined
  name: string
}): boolean => meta?.[name]?.optional === true

const validatePackageRecomposition = (args: {
  pkg: PackageInfo
  packageMap: Map<string, PackageInfo>
}): ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  const deps = {
    ...args.pkg.dependencies,
    ...args.pkg.optionalDependencies,
  }
  const isPrivate = args.pkg.private === true

  for (const [depName, spec] of Object.entries(deps)) {
    if (isWorkspaceSpec(spec) === false) continue
    const upstream = args.packageMap.get(depName)
    if (upstream === undefined) continue

    const upstreamPeers = Object.keys(upstream.peerDependencies ?? {})
    for (const peer of upstreamPeers) {
      const isSatisfied =
        isPrivate === true
          ? peer in (args.pkg.dependencies ?? {}) ||
            peer in (args.pkg.devDependencies ?? {}) ||
            peer in (args.pkg.peerDependencies ?? {})
          : args.pkg.peerDependencies !== undefined && peer in args.pkg.peerDependencies

      if (isSatisfied === false) {
        const message =
          isPrivate === true
            ? `Missing dep "${peer}" (peer dep of "${depName}") in dependencies or devDependencies`
            : `Missing peer dep "${peer}" required by "${depName}"`
        issues.push({
          severity: 'error',
          packageName: args.pkg.name,
          dependency: peer,
          message,
          rule: 'recompose-peer-deps',
        })
        continue
      }

      /** Only check peerDependenciesMeta when the dep is actually in peerDependencies */
      const isInPeerDeps =
        args.pkg.peerDependencies !== undefined && peer in args.pkg.peerDependencies
      if (
        isInPeerDeps === true &&
        hasOptionalPeer({ meta: upstream.peerDependenciesMeta, name: peer }) === true &&
        hasOptionalPeer({ meta: args.pkg.peerDependenciesMeta, name: peer }) === false
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
 * For non-private (library) packages: upstream peer deps must appear in peerDependencies (delta pattern).
 * For private (app) packages: upstream peer deps must appear in dependencies, devDependencies, or peerDependencies.
 */
export const validatePackageRecompositionForPackage = ({
  ctx,
  pkgName,
}: {
  ctx: GenieContext
  pkgName: string
}): ValidationIssue[] => {
  const workspace = ctx.workspace
  if (workspace === undefined) return []

  const pkg = workspace.byName.get(pkgName)
  if (pkg === undefined) return []

  return validatePackageRecomposition({
    pkg,
    packageMap: workspace.byName,
  })
}
