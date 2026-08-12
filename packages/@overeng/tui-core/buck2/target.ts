import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Buck2TargetProjection } from '../../../../genie/buck2/mod.ts'
import {
  canonicalSha256,
  type DependencyField,
  type MaterializerIdentity,
  type PnpmImporterSnapshot,
  type PnpmLockfileV9,
  type PnpmTaskClosureInputPlan,
  type TaskClosureRequest,
  pnpmPackageMaterializerAbi,
} from '../../buck2-tools/src/mod.ts'

/** Repo-relative package path shared by the generated Buck projections. */
export const packagePath = 'packages/@overeng/tui-core' as const
/** Canonical Buck label for the first package-local non-authoritative plan. */
export const targetLabel = `//${packagePath}:typescript_input_plan` as const

const sourceRoots = ['src', 'test'] as const
const sourceExtensions = new Set(['.cts', '.mts', '.ts', '.tsx'])

const safeSourceSegment = (segment: string): boolean =>
  segment !== '' &&
  segment !== '.' &&
  segment !== '..' &&
  segment.includes('/') === false &&
  segment.includes('\\') === false &&
  /^[A-Za-z0-9._@+-]+$/.test(segment)

/**
 * Census the TypeScript source roots without following symlinks. The rendered
 * BUCK file remains explicit, while adding a new source necessarily changes
 * the generator result and its semantic fingerprint.
 */
export const discoverPackageSources = (packageRoot: URL | string): readonly string[] => {
  const absoluteRoot = packageRoot instanceof URL ? fileURLToPath(packageRoot) : packageRoot
  const sources: string[] = []

  const walk = (relativeDirectory: string): void => {
    const entries = readdirSync(path.join(absoluteRoot, relativeDirectory), {
      withFileTypes: true,
    }).toSorted((left, right) => compareStrings({ left: left.name, right: right.name }))
    for (const entry of entries) {
      if (safeSourceSegment(entry.name) === false) {
        throw new Error(`Unsafe package source path segment: ${entry.name}`)
      }
      const relativePath = path.posix.join(relativeDirectory, entry.name)
      if (entry.isSymbolicLink() === true) {
        throw new Error(`Package source census refuses symlink: ${relativePath}`)
      }
      if (entry.isDirectory() === true) {
        walk(relativePath)
      } else if (
        entry.isFile() === true &&
        sourceExtensions.has(path.extname(entry.name)) === true
      ) {
        sources.push(relativePath)
      }
    }
  }

  for (const sourceRoot of sourceRoots) walk(sourceRoot)
  if (sources.length === 0) throw new Error('Package source census found no TypeScript inputs')
  return sources.toSorted((left, right) => compareStrings({ left, right }))
}

/** Create explicit target metadata from the generator-owned filesystem census. */
export const targetForSources = (sources: readonly string[]): Buck2TargetProjection => ({
  name: 'typescript_input_plan',
  kind: 'typescript-input-plan-evidence',
  // This first local-only slice is intentionally fail-closed on other hosts.
  // Configured execution-platform selection is a prerequisite for remote use.
  platform: 'x86_64-linux',
  sources,
  configs: ['package.json', 'tsconfig.json'],
  deps: [],
  closureDescriptor: 'buck2/typescript-input-plan.json',
})

/** Human-reviewable provenance paths that can change either projection. */
export const semanticInputs = [
  'genie/buck2/mod.ts',
  'packages/@overeng/buck2-tools/src/canonical.ts',
  'packages/@overeng/buck2-tools/src/model.ts',
  'packages/@overeng/buck2-tools/src/pnpm-closure.ts',
  'packages/@overeng/buck2-tools/src/pnpm-materializer.ts',
  'packages/@overeng/tui-core/buck2/target.ts',
  'packages/@overeng/tui-core/package.json.genie.ts',
  'packages/@overeng/tui-core/src/**/*.cts',
  'packages/@overeng/tui-core/src/**/*.mts',
  'packages/@overeng/tui-core/src/**/*.ts',
  'packages/@overeng/tui-core/src/**/*.tsx',
  'packages/@overeng/tui-core/test/**/*.cts',
  'packages/@overeng/tui-core/test/**/*.mts',
  'packages/@overeng/tui-core/test/**/*.ts',
  'packages/@overeng/tui-core/test/**/*.tsx',
  'packages/@overeng/tui-core/tsconfig.json.genie.ts',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
] as const

/** Repository freshness command recorded in generated-file provenance. */
export const regenerationCommand = 'devenv tasks run genie:run' as const
/** Global materialization semantics shared by package-specific policy projections. */
export const materializerBaseAbi = pnpmPackageMaterializerAbi

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const satisfies readonly DependencyField[]

const compareStrings = ({ left, right }: { left: string; right: string }): number =>
  left < right ? -1 : left > right ? 1 : 0

/**
 * The first slice deliberately starts conservative: every declared importer
 * dependency is a root. Later splits may remove roots only with observed task
 * evidence, preserving correctness while making invalidation more granular.
 */
export const conservativeFullImporterRoots = (
  importer: PnpmImporterSnapshot,
): TaskClosureRequest['roots'] =>
  dependencyFields
    .flatMap((field) =>
      Object.keys(importer[field] ?? {}).map((alias) => ({
        alias,
        field,
        reason: `conservative-full-importer:${field}`,
      })),
    )
    .toSorted(
      (left, right) =>
        compareStrings({ left: left.alias, right: right.alias }) ||
        compareStrings({ left: left.field, right: right.field }),
    )

const safeImporterId = (importerId: string): boolean =>
  importerId === '.' ||
  (importerId.length > 0 &&
    importerId.startsWith('/') === false &&
    importerId.includes('\\') === false &&
    importerId
      .split('/')
      .every(
        (segment) => segment !== '' && segment !== '..' && /^[A-Za-z0-9._@+-]+$/.test(segment),
      ))

/** Produce labels only from validated repo-relative importer paths. */
export const workspaceLabelsFor = (
  lockfile: Pick<PnpmLockfileV9, 'importers'>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    Object.keys(lockfile.importers)
      .toSorted((left, right) => compareStrings({ left, right }))
      .map((importerId) => {
        if (safeImporterId(importerId) === false) {
          throw new Error(`Unsafe pnpm importer id for Buck label: ${importerId}`)
        }
        return [
          importerId,
          importerId === '.' ? '//:workspace_package' : `//${importerId}:workspace_package`,
        ]
      }),
  )

type JsonRecord = Readonly<Record<string, unknown>>

const record = ({ value, label }: { value: unknown; label: string }): JsonRecord => {
  if (value === null || Array.isArray(value) === true || typeof value !== 'object') {
    throw new TypeError(`${label} must be an object`)
  }
  return value as JsonRecord
}

/** Validate the boundary needed by the compiler before using the parsed YAML. */
export const decodePnpmLockfile = (value: unknown): PnpmLockfileV9 => {
  const lockfile = record({ value, label: 'pnpm-lock.yaml' })
  if (typeof lockfile.lockfileVersion !== 'string') {
    throw new TypeError('pnpm-lock.yaml lockfileVersion must be a string')
  }
  record({ value: lockfile.importers, label: 'pnpm-lock.yaml importers' })
  record({ value: lockfile.packages, label: 'pnpm-lock.yaml packages' })
  record({ value: lockfile.snapshots, label: 'pnpm-lock.yaml snapshots' })
  return lockfile as unknown as PnpmLockfileV9
}

/**
 * Hash only install/materialization policy, not the whole workspace document,
 * so catalog or package-list edits do not invalidate package content blobs.
 */
/** Project global and reachable package-specific materialization policy. */
export const materializerPolicyProjection = ({
  workspaceValue,
  relevantPackageNames,
}: {
  workspaceValue: unknown
  relevantPackageNames: readonly string[]
}): Readonly<Record<string, unknown>> => {
  const workspace = record({ value: workspaceValue, label: 'pnpm-workspace.yaml' })
  const allowBuilds = record({
    value: workspace.allowBuilds,
    label: 'pnpm-workspace.yaml allowBuilds',
  })
  const relevantAllowBuilds = Object.fromEntries(
    [...new Set(relevantPackageNames)]
      .toSorted((left, right) => compareStrings({ left, right }))
      .flatMap((packageName) =>
        Object.hasOwn(allowBuilds, packageName) === true
          ? [[packageName, allowBuilds[packageName]]]
          : [],
      ),
  )
  return {
    abi: materializerBaseAbi,
    allowBuilds: relevantAllowBuilds,
    ignoreScripts: workspace.ignoreScripts,
    injectWorkspacePackages: workspace.injectWorkspacePackages,
    packageImportMethod: workspace.packageImportMethod,
    sideEffectsCache: workspace.sideEffectsCache,
    strictStorePkgContentCheck: workspace.strictStorePkgContentCheck,
    verifyStoreIntegrity: workspace.verifyStoreIntegrity,
  }
}

/** Hash the exact projected materializer policy used by the later Buck action. */
export const materializerPolicyDigest = (args: {
  workspaceValue: unknown
  relevantPackageNames: readonly string[]
}): `sha256:${string}` => `sha256:${canonicalSha256(materializerPolicyProjection(args))}`

/**
 * Derive the package-local build policy used to normalize one selected
 * package. This is deliberately narrower than the human-readable aggregate
 * policy in an input plan: another reachable package's allowBuilds entry must
 * not change this package's content identity.
 */
export const packageMaterializerPolicyDigest = (args: {
  workspaceValue: unknown
  packageName: string | undefined
}): `sha256:${string}` =>
  materializerPolicyDigest({
    workspaceValue: args.workspaceValue,
    relevantPackageNames: args.packageName === undefined ? [] : [args.packageName],
  })

/** Per-package policy supplement; source identity stays in inputPlan exactly once. */
export const materializationPoliciesForPlan = ({
  plan,
  workspaceValue,
}: {
  plan: PnpmTaskClosureInputPlan
  workspaceValue: unknown
}): Readonly<Record<string, MaterializerIdentity>> =>
  Object.fromEntries(
    plan.packages.map((pkg) => [
      pkg.depPath,
      {
        abi: materializerBaseAbi,
        buildPolicyDigest: packageMaterializerPolicyDigest({
          workspaceValue,
          packageName: pkg.packageName,
        }),
      },
    ]),
  )

/**
 * Derive the exact allowBuilds relevance set from a provisional closure. The
 * provisional identities are never emitted; only their selected depPaths are
 * used to parameterize the authoritative second compile.
 */
export const relevantPackageNamesForPlan = (plan: {
  readonly packages: readonly { readonly depPath: string; readonly packageName?: string }[]
}): readonly string[] =>
  [
    ...new Set(
      plan.packages.map((pkg) => {
        if (pkg.packageName === undefined) {
          throw new Error(`Provisional package input has no package name: ${pkg.depPath}`)
        }
        return pkg.packageName
      }),
    ),
  ].toSorted((left, right) => compareStrings({ left, right }))
