import type { GenieOutput } from '../core.ts'
import type { WorkspacePackageLike } from '../package-json/mod.ts'
import type { TSConfigArgs } from '../tsconfig-json/mod.ts'
import type { GenieValidationIssue } from '../validation/mod.ts'
import type {
  AttributeGroup,
  Dependency,
  Registry,
  RegistryFragment,
  SignalDef,
} from '../weaver/mod.ts'
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

// ---------------------------------------------------------------------------
// Weaver semantic-conventions composition (SC-R07/R08/R09).
//
// A filesystem-free projector over member fragments — the same shape as
// `tsconfigReferencesFromPackages` above: read structured `meta` off member outputs, dedupe,
// deterministically sort. It NEVER touches emitted files. Whole-registry integrity
// (namespace uniqueness + global ref resolution) is surfaced as genie validation issues
// (this layer is dep-free — Effect/`Schema.TaggedError` are not available here; per-member
// author-time errors are raised as tagged errors in `@overeng/otel-contract` `./registry`).
// ---------------------------------------------------------------------------

/** A member contributing a registry fragment on its non-emitted `meta.registry` channel. */
export type RegistryMember = GenieOutput<unknown, { registry: RegistryFragment }>

/**
 * An upstream registry declared as a manifest `dependency`. genie's aggregation cannot fetch
 * the upstream model, so a ref under one of `providesNamespaces` is treated as resolvable and
 * its final resolution is DEFERRED to weaver (the authoritative resolver).
 */
export type UpstreamDependency = {
  readonly dependency: Dependency
  readonly providesNamespaces: readonly string[]
}

export type RegistryFromMembersArgs = {
  readonly members: readonly RegistryMember[]
  readonly name: string
  readonly description: string
  readonly schemaUrl: string
  readonly upstream?: readonly UpstreamDependency[]
}

export type RegistryComposition = {
  readonly registry: Registry
  readonly fragments: readonly RegistryFragment[]
  /** Whole-registry integrity issues (namespace uniqueness, dangling refs). */
  readonly issues: readonly GenieValidationIssue[]
}

const firstSegment = (key: string): string => key.split('.')[0] ?? key

/**
 * Compose member fragments into ONE Weaver registry, checking namespace uniqueness (SC-R09)
 * and global ref integrity across ALL fragments (SC-R09) — the checks a per-member pass
 * structurally cannot do. Returns the composed registry plus any integrity issues (surfaced
 * through a `.genie.ts` `validate(ctx)` so `genie:check` blocks on them).
 */
export const registryFromMembers = (args: RegistryFromMembersArgs): RegistryComposition => {
  const issues: GenieValidationIssue[] = []
  const fragments = args.members
    .map((m) => m.meta.registry)
    .toSorted((a, b) => a.namespace.localeCompare(b.namespace))

  // (1) namespace uniqueness.
  const seenNamespace = new Map<string, string>()
  for (const f of fragments) {
    const prior = seenNamespace.get(f.namespace)
    if (prior !== undefined) {
      issues.push({
        severity: 'error',
        packageName: f.memberPath,
        dependency: `registry.${f.namespace}`,
        rule: 'weaver/duplicate-namespace',
        message: `namespace collision: members ${JSON.stringify(prior)} and ${JSON.stringify(f.memberPath)} both claim registry.${f.namespace}`,
      })
    } else {
      seenNamespace.set(f.namespace, f.memberPath)
    }
  }

  // Defined keys across all fragments + upstream-provided namespaces (deferred to weaver).
  const definedKeys = new Set<string>()
  for (const f of fragments) for (const a of f.attributes) definedKeys.add(a.id)
  const upstreamNamespaces = new Set<string>()
  const dependencies: Dependency[] = []
  for (const u of args.upstream ?? []) {
    dependencies.push(u.dependency)
    for (const ns of u.providesNamespaces) upstreamNamespaces.add(ns)
  }

  // (2) global ref integrity — every signal ref resolves to a defined key OR an upstream namespace.
  for (const f of fragments) {
    for (const sig of f.signals) {
      for (const r of sig.attributes) {
        if (definedKeys.has(r.ref) === true || upstreamNamespaces.has(firstSegment(r.ref)) === true)
          continue
        issues.push({
          severity: 'error',
          packageName: f.memberPath,
          dependency: r.ref,
          rule: 'weaver/dangling-ref',
          message: `dangling ref: signal ${sig.id} (member ${f.memberPath}) references undefined attribute ${JSON.stringify(r.ref)}`,
        })
      }
    }
  }

  const groups: AttributeGroup[] = fragments
    .map((f) => ({ namespace: f.namespace, displayName: f.displayName, attributes: f.attributes }))
    .toSorted((a, b) => a.namespace.localeCompare(b.namespace))

  const signals: SignalDef[] = fragments
    .flatMap((f) => f.signals)
    .toSorted((a, b) => a.id.localeCompare(b.id))

  const registry: Registry = {
    name: args.name,
    description: args.description,
    schemaUrl: args.schemaUrl,
    dependencies: dependencies.toSorted((a, b) => a.name.localeCompare(b.name)),
    groups,
    signals,
  }
  return { registry, fragments, issues }
}

/**
 * No-orphan-seam check (decision 0005, the keystone the path-based lint cannot provide).
 *
 * Given every telemetry seam file discovered on disk and the seam paths the root aggregator
 * actually imports, return the ORPHANS — seam files present on disk but absent from the
 * aggregator's import list. An orphan would lint clean yet be absent from BOTH the registry
 * and the conformance sweep, so a colocated test asserts this returns `[]` (and, on a planted
 * orphan, that it does not). Pure + filesystem-free; the caller supplies the globbed paths.
 */
export const orphanSeamPaths = (args: {
  readonly seamFilesOnDisk: readonly string[]
  readonly importedSeamPaths: readonly string[]
}): readonly string[] => {
  const imported = new Set(args.importedSeamPaths)
  return args.seamFilesOnDisk
    .filter((p) => imported.has(p) === false)
    .toSorted((a, b) => a.localeCompare(b))
}
