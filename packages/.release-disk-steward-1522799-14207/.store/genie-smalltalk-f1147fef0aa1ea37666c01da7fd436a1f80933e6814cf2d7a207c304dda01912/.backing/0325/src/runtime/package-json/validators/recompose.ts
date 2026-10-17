import type { PackageInfo } from '../../../common/types.ts'
import type { GenieContext } from '../../mod.ts'
import type { PackageJsonData, WorkspaceMetadata } from '../mod.ts'
import type { ValidationIssue } from '../validation.ts'

const isWorkspaceSpec = (spec: string): boolean =>
  spec.startsWith('workspace:') || spec.startsWith('file:') || spec.startsWith('link:')

const hasVersionRangeSyntax = (spec: string): boolean =>
  spec.startsWith('^') ||
  spec.startsWith('~') ||
  spec.startsWith('>') ||
  spec.startsWith('<') ||
  spec.includes('||') ||
  /\s-\s/.test(spec)

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

      const localInstallSpec =
        args.pkg.dependencies?.[peer] ??
        args.pkg.devDependencies?.[peer] ??
        args.pkg.optionalDependencies?.[peer]
      if (
        localInstallSpec !== undefined &&
        isWorkspaceSpec(localInstallSpec) === false &&
        hasVersionRangeSyntax(localInstallSpec) === true
      ) {
        issues.push({
          severity: 'error',
          packageName: args.pkg.name,
          dependency: peer,
          message: `Inherited peer "${peer}" from "${depName}" uses ranged local install spec "${localInstallSpec}". Use an explicit install version and keep the range only in peerDependencies.`,
          rule: 'recompose-local-peer-range',
        })
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

    /**
     * Patch recomposition: non-private packages must cascade patch requirements
     * so external consumers can discover them. Private packages skip this check
     * because their workspace root owns patch application via pnpm-workspace.yaml.
     */
    if (isPrivate === false) {
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
  }

  return issues
}

/**
 * Validate that a package properly re-exports peer dependencies and patches from its workspace dependencies.
 *
 * For non-private (library) packages: upstream peer deps must appear in peerDependencies (delta pattern).
 * For private (app) packages: upstream peer deps must appear in dependencies, devDependencies, or peerDependencies.
 * If they are installed locally via dependencies/devDependencies/optionalDependencies, their local install spec must be explicit.
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

const collectWorkspaceDependencyNames = ({
  metadata,
  visited = new Set<string>(),
}: {
  metadata: WorkspaceMetadata
  visited?: Set<string>
}): Set<string> => {
  for (const dep of metadata.deps) {
    const depName = dep.data.name
    if (depName === undefined || visited.has(depName) === true) continue

    visited.add(depName)
    collectWorkspaceDependencyNames({
      metadata: dep.meta.workspace,
      visited,
    })
  }

  return visited
}

/**
 * Validate that emitted workspace dependency specs are backed by workspace metadata so
 * package-level projections and pnpm installs can realize the same closure.
 */
export const validateWorkspaceMetadataForPackageJson = ({
  data,
  metadata,
}: {
  data: PackageJsonData
  metadata: WorkspaceMetadata
}): ValidationIssue[] => {
  const issues: ValidationIssue[] = []
  const workspaceNames = collectWorkspaceDependencyNames({ metadata })
  const candidateDeps = {
    ...data.dependencies,
    ...data.devDependencies,
    ...data.optionalDependencies,
  }

  for (const [depName, spec] of Object.entries(candidateDeps)) {
    if (spec.startsWith('workspace:') === false) continue
    if (workspaceNames.has(depName) === true) continue

    issues.push({
      severity: 'error',
      packageName: data.name ?? metadata.memberPath,
      dependency: depName,
      message: `Workspace dependency "${depName}" is emitted in package.json but missing from workspace metadata closure`,
      rule: 'workspace-metadata-coverage',
    })
  }

  return issues
}

/**
 * Validate that any emitted local workspace dependency specs are paired with
 * workspace metadata so package-level/root projections can derive the same
 * closure.
 */
export const validateWorkspaceMetadataPresenceForPackageJson = ({
  data,
}: {
  data: PackageJsonData
}): ValidationIssue[] => {
  const candidateDeps = {
    ...data.dependencies,
    ...data.devDependencies,
    ...data.optionalDependencies,
  }

  const localWorkspaceDeps = Object.entries(candidateDeps).filter(
    ([, spec]) =>
      spec.startsWith('workspace:') || spec.startsWith('file:') || spec.startsWith('link:'),
  )

  if (localWorkspaceDeps.length === 0) return []

  return [
    {
      severity: 'error',
      packageName: data.name ?? '(unknown package)',
      dependency: localWorkspaceDeps[0]?.[0] ?? '(workspace dependency)',
      message:
        'Package emits local workspace dependency specs but has no workspace metadata. Use packageJson(data, composition) so emitted dependencies and workspace closure stay coupled.',
      rule: 'workspace-metadata-required',
    },
  ]
}
