import type { GenieOutput } from '../core.ts'
import type { WorkspacePackageLike } from '../package-json/mod.ts'
import type { TSConfigArgs } from '../tsconfig-json/mod.ts'
import { relativeRepoPath } from '../workspace-graph.ts'

type TsconfigReference = NonNullable<TSConfigArgs['references']>[number]

type TsconfigReferencePackage =
  | WorkspacePackageLike
  | {
      package: WorkspacePackageLike
      tsconfig?: TSConfigArgs | GenieOutput<TSConfigArgs>
    }

export type TsconfigReferencesFromPackagesArgs = {
  /**
   * Package whose tsconfig is receiving references.
   *
   * When `packages` is omitted, the helper projects the direct workspace deps
   * declared in this package's workspace metadata.
   */
  from: WorkspacePackageLike
  /** Packages to reference. Defaults to `from.meta.workspace.deps`. */
  packages?: readonly TsconfigReferencePackage[]
  /**
   * Additional package predicate for project-local policy.
   *
   * Use this for rules that are not reusable Genie semantics. TypeScript's
   * generic project-reference target rules are handled from `tsconfig` data
   * when each package entry provides it.
   */
  include?: (pkg: WorkspacePackageLike) => boolean
}

const unwrapPackage = (entry: TsconfigReferencePackage): WorkspacePackageLike =>
  'package' in entry ? entry.package : entry

const unwrapTsconfig = (entry: TsconfigReferencePackage): TSConfigArgs | undefined => {
  if ('package' in entry === false) return undefined
  const tsconfig = entry.tsconfig
  if (tsconfig === undefined) return undefined
  return 'data' in tsconfig ? tsconfig.data : tsconfig
}

/**
 * Whether a tsconfig can be targeted by a TypeScript project reference.
 *
 * TypeScript rejects referenced projects that explicitly disable emit. Genie
 * also treats `composite: false` as an opt-out from project-reference targets.
 */
export const isTsconfigReferenceTarget = (tsconfig: TSConfigArgs): boolean =>
  tsconfig.compilerOptions?.composite !== false && tsconfig.compilerOptions?.noEmit !== true

const logicalWorkspaceMemberPath = ({
  fromRepoName,
  pkg,
}: {
  fromRepoName: string
  pkg: WorkspacePackageLike
}): string =>
  pkg.meta.workspace.repoName === fromRepoName
    ? pkg.meta.workspace.memberPath
    : `repos/${pkg.meta.workspace.repoName}/${pkg.meta.workspace.memberPath}`

const formatReferencePath = (relativePath: string): string =>
  relativePath === '.' || relativePath.startsWith('.') === true ? relativePath : `./${relativePath}`

/**
 * Project TypeScript project references from package workspace metadata.
 *
 * This helper is an explicit cross-artifact composition layer: package
 * generators provide semantic workspace dependency metadata, while this
 * function renders the location-specific `references` entries for a tsconfig.
 */
export const tsconfigReferencesFromPackages = ({
  from,
  packages = from.meta.workspace.deps,
  include,
}: TsconfigReferencesFromPackagesArgs): TsconfigReference[] => {
  const fromWorkspace = from.meta.workspace
  const references = new Map<string, TsconfigReference>()

  for (const entry of packages) {
    const pkg = unwrapPackage(entry)
    if (include?.(pkg) === false) continue

    const tsconfig = unwrapTsconfig(entry)
    if (tsconfig !== undefined && isTsconfigReferenceTarget(tsconfig) === false) continue

    const targetPath = logicalWorkspaceMemberPath({
      fromRepoName: fromWorkspace.repoName,
      pkg,
    })
    const path = formatReferencePath(
      relativeRepoPath({
        from: fromWorkspace.memberPath,
        to: targetPath,
      }),
    )

    references.set(path, { path })
  }

  return [...references.values()].toSorted((a, b) => a.path.localeCompare(b.path))
}
