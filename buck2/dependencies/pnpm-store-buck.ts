import {
  nativeDependencyPolicy,
  nixGraftedStoreOverridePackages,
} from '../../genie/native-dependency-policy.ts'
import { isProductSha256Entry, type PnpmLockMetadata, type PnpmSha256Sidecar } from './pnpm-lock.ts'
import type {
  PnpmStoreEdgeSet,
  PnpmStoreEntry,
  PnpmStoreProjection,
  PnpmStoreView,
  PnpmPlatform,
} from './pnpm-store.ts'
import { platformGatedPackageNames, pnpmPlatforms } from './pnpm-store.ts'

const compareStrings = ({ left, right }: { left: string; right: string }): number =>
  left < right ? -1 : left > right ? 1 : 0

const sortedEntries = <TValue>(record: Readonly<Record<string, TValue>>) =>
  Object.entries(record).toSorted(([left], [right]) => compareStrings({ left, right }))

const fail = (message: string): never => {
  throw new Error(`Invalid pnpm store declaration: ${message}`)
}

const starlarkString = (value: string): string => JSON.stringify(value)

/**
 * Renders the declared override for one entry's package bytes.
 *
 * The store is normalized: one entry per peer-resolved snapshot for the whole
 * repository. Overriding that single entry therefore reaches every importer
 * and every alias of the package, including a patched dependent that only
 * names it transitively, without copying bytes per consumer.
 *
 * The value is the immutable directory named by `[test_capabilities]`. Left
 * undeclared it is the empty string, which keeps the hash-pinned registry
 * archive: a lane that only typechecks a grafted package needs its sources,
 * not its addon, and a lane that loads the addon declares the capability.
 */
const renderPackageOverride = (entry: PnpmStoreEntry): readonly string[] =>
  nixGraftedStoreOverridePackages[entry.packageName] === undefined
    ? []
    : [
        `    package_override = read_config("test_capabilities", ${starlarkString(
          entry.packageName,
        )}, ""),`,
      ]

const renderDict = ({
  indent,
  record,
}: {
  indent: number
  record: Readonly<Record<string, string>>
}): string => {
  const prefix = ' '.repeat(indent)
  return [
    '{',
    ...sortedEntries(record).map(
      ([key, value]) => `${prefix}    ${starlarkString(key)}: ${starlarkString(value)},`,
    ),
    `${prefix}}`,
  ].join('\n')
}

const renderPlatformDict = ({
  byPlatform,
  field,
}: {
  byPlatform: Readonly<Record<PnpmPlatform, Readonly<Record<string, string>>>>
  field: string
}): readonly string[] => [
  `    ${field} = {`,
  ...pnpmPlatforms.map(
    (platform) =>
      `        ${starlarkString(platform)}: ${renderDict({ indent: 8, record: byPlatform[platform] })},`,
  ),
  '    },',
]

/**
 * Renders either the invariant or the per-platform form of one attribute.
 *
 * A configured `select()` appears only where the projected values actually
 * differ across admitted platforms, so no platform-varying count is written
 * down: the lockfile decides.
 */
const renderMaybeSelected = ({
  byPlatform,
  field,
}: {
  byPlatform: Readonly<Record<PnpmPlatform, Readonly<Record<string, string>>>>
  field: string
}): readonly string[] => {
  const rendered = pnpmPlatforms.map((platform) =>
    renderDict({ indent: 4, record: byPlatform[platform] }),
  )
  if (rendered.every((value) => value === rendered[0])) {
    return [`    ${field} = ${rendered[0]},`]
  }
  return renderPlatformDict({ byPlatform, field: `${field}_by_platform` })
}

const byPlatform = <TValue>(
  project: (platform: PnpmPlatform) => TValue,
): Readonly<Record<PnpmPlatform, TValue>> =>
  Object.fromEntries(pnpmPlatforms.map((platform) => [platform, project(platform)])) as Record<
    PnpmPlatform,
    TValue
  >

const edgesFor = ({
  entry,
  platform,
}: {
  entry: PnpmStoreEntry
  platform: PnpmPlatform
}): PnpmStoreEdgeSet => {
  const variant = entry.variants.find((candidate) => candidate.platforms.includes(platform))
  if (variant === undefined && entry.platforms.includes(platform)) {
    return fail(`entry ${entry.snapshot} has no variant for supported platform ${platform}`)
  }
  return variant?.edges ?? {}
}


const workspaceEdges = (edges: PnpmStoreEdgeSet): Readonly<Record<string, string>> =>
  Object.fromEntries(
    sortedEntries(edges).flatMap(([name, edge]) =>
      edge.kind === 'workspace' ? [[name, edge.workspaceKey] as const] : [],
    ),
  )

const packageEdges = ({
  edges,
  targetByStoreKey,
}: {
  edges: PnpmStoreEdgeSet
  targetByStoreKey: ReadonlyMap<string, string>
}): Readonly<Record<string, string>> =>
  Object.fromEntries(
    sortedEntries(edges).flatMap(([name, edge]) =>
      edge.kind === 'entry'
        ? [
            [
              name,
              targetByStoreKey.get(edge.storeKey) ?? fail(`unknown store entry ${edge.storeKey}`),
            ] as const,
          ]
        : [],
    ),
  )

/** Unsupported branches carry an analysis error, never a successful empty tree. */
const renderUnavailablePlatforms = ({
  owner,
  platforms,
}: {
  owner: string
  platforms: readonly PnpmPlatform[]
}): readonly string[] =>
  platforms.length === pnpmPlatforms.length
    ? []
    : [
        `    unavailable_by_platform = ${renderDict({
          indent: 4,
          record: byPlatform((platform) =>
            platforms.includes(platform)
              ? ''
              : `${owner} has no complete required dependency closure on ${platform}`,
          ),
        })},`,
      ]

const renderView = ({
  targetByStoreKey,
  entryByStoreKey,
  view,
}: {
  targetByStoreKey: ReadonlyMap<string, string>
  entryByStoreKey: ReadonlyMap<string, PnpmStoreEntry>
  view: PnpmStoreView
}): readonly string[] => {
  const variantFor = (platform: PnpmPlatform) => {
    const variant = view.variants.find((candidate) => candidate.platforms.includes(platform))
    if (variant === undefined && view.platforms.includes(platform)) {
      return fail(`view ${view.importer} has no variant for supported platform ${platform}`)
    }
    return variant
  }
  const direct = byPlatform((platform) =>
    Object.fromEntries(
      sortedEntries(variantFor(platform)?.direct ?? {}).flatMap(([name, edge]) =>
        edge.kind === 'entry' ? [[name, edge.storeKey] as const] : [],
      ),
    ),
  )
  const closure = byPlatform((platform) =>
    Object.fromEntries(
      (variantFor(platform)?.closure ?? []).map((storeKey) => [
        storeKey,
        targetByStoreKey.get(storeKey) ?? fail(`unknown store entry ${storeKey}`),
      ]),
    ),
  )
  const bins = byPlatform((platform) => variantFor(platform)?.bins ?? {})
  const workspaceDependencies = byPlatform((platform) =>
    workspaceEdges(variantFor(platform)?.direct ?? {}),
  )
  const workspaceTrees = byPlatform((platform) => {
    const variant = variantFor(platform)
    const keys = new Set(Object.values(workspaceDependencies[platform]))
    for (const storeKey of variant?.closure ?? []) {
      const entry = entryByStoreKey.get(storeKey) ?? fail(`unknown store entry ${storeKey}`)
      for (const key of Object.values(workspaceEdges(edgesFor({ entry, platform })))) keys.add(key)
    }
    return Object.fromEntries(
      [...keys]
        .toSorted()
        .map((key) => [
          key,
          view.workspaceTrees[key] ?? fail(`view ${view.importer} has no workspace tree ${key}`),
        ]),
    )
  })
  return [
    'pnpm_store_view(',
    `    name = ${starlarkString(view.target)},`,
    '    runtime = ":assemble-store.ts",',
    ...renderUnavailablePlatforms({ owner: `view ${view.importer}`, platforms: view.platforms }),
    ...renderMaybeSelected({ byPlatform: direct, field: 'direct' }),
    ...renderMaybeSelected({ byPlatform: closure, field: 'closure' }),
    ...renderMaybeSelected({ byPlatform: bins, field: 'bins' }),
    ...renderMaybeSelected({ byPlatform: workspaceTrees, field: 'workspace_trees' }),
    ...renderMaybeSelected({ byPlatform: workspaceDependencies, field: 'workspace_dependencies' }),
    '    visibility = ["PUBLIC"],',
    ')',
    '',
  ]
}

/**
 * Renders the registry archive targets the normalized store entries point at.
 *
 * One `pnpm_package` per registry-resolved lockfile package, hash-pinned from
 * the freshness-gated sidecar. Store entries reference these targets; the
 * package layer itself is importer-agnostic.
 */
export const renderPnpmPackageTargets = ({
  metadata,
  sidecar,
  patchSourceCells = {},
}: {
  metadata: PnpmLockMetadata
  sidecar: PnpmSha256Sidecar
  /** Checkout-root paths mapped to the cells that export their patch files. */
  patchSourceCells?: Readonly<Record<string, string>>
}): string => {
  const buckPatchTarget = (patchPath: string): string => {
    const sourceRoot = Object.keys(patchSourceCells)
      .filter((root) => patchPath.startsWith(`${root}/`))
      .toSorted((left, right) => right.length - left.length)[0]
    const cell = sourceRoot === undefined ? '' : `@${patchSourceCells[sourceRoot]}`
    const cellPath = sourceRoot === undefined ? patchPath : patchPath.slice(sourceRoot.length + 1)
    const marker = '/patches/'
    const markerIndex = cellPath.indexOf(marker)
    return markerIndex < 0
      ? `${cell}//:${cellPath}`
      : `${cell}//${cellPath.slice(0, markerIndex)}:patches/${cellPath.slice(markerIndex + marker.length)}`
  }
  const lines: string[] = []
  for (const [packageKey, packageMetadata] of sortedEntries(metadata.packages)) {
    if (packageMetadata.resolution === 'workspace') continue
    const archive = sidecar.packages[packageKey]
    if (archive === undefined || packageMetadata.url === undefined)
      return fail(`missing sidecar entry ${packageKey}`)
    const archiveSource = isProductSha256Entry(archive)
      ? archive.productTarball
      : archive.registryUrl
    if (
      archive.packageIdentity !== packageKey ||
      archiveSource !== packageMetadata.url ||
      isProductSha256Entry(archive) !== (packageMetadata.resolution === 'product')
    ) {
      return fail(`sidecar archive binding mismatch ${packageKey}`)
    }
    lines.push(
      'pnpm_package(',
      `    name = ${starlarkString(packageMetadata.target)},`,
      `    package_name = ${starlarkString(packageMetadata.name)},`,
      `    url = ${starlarkString(archiveSource)},`,
      `    sha256 = ${starlarkString(archive.sha256)},`,
      `    size_bytes = ${archive.sizeBytes},`,
      `    bins = ${renderDict({ indent: 4, record: archive.bins })},`,
      ...(packageMetadata.patch === undefined
        ? []
        : [`    patches = [${starlarkString(buckPatchTarget(packageMetadata.patch.path))}],`]),
      ')',
      '',
    )
  }
  return lines.join('\n')
}

const POLICY_FAMILIES: readonly string[] = Object.keys(nativeDependencyPolicy).toSorted(
  (left, right) => right.length - left.length,
)

/**
 * Renders the lockfile's platform-gated package families as one Buck target.
 *
 * A portable JavaScript product must leave every cpu/os/libc-gated package
 * external, and a Nix-grafted family must additionally be declared as an
 * external capability by any product that reaches it — Nix, not pnpm, provides
 * those bytes at runtime. Both facts are derived here from the lockfile and
 * the native-dependency policy, so no product can drift from them by hand.
 */
export const renderPnpmPlatformGatedPackages = ({
  metadata,
}: {
  metadata: PnpmLockMetadata
}): string => {
  const byFamily = new Map<string, string[]>()
  for (const name of platformGatedPackageNames(metadata)) {
    const family = POLICY_FAMILIES.find((candidate) => name.startsWith(candidate)) ?? name
    const members = byFamily.get(family)
    if (members === undefined) byFamily.set(family, [name])
    else members.push(name)
  }
  const families = [...byFamily.keys()].toSorted((left, right) => compareStrings({ left, right }))
  const capabilities: Record<string, string> = {}
  for (const family of families) {
    const policy = nativeDependencyPolicy[family as keyof typeof nativeDependencyPolicy]
    if (policy === undefined || policy._tag !== 'nix-grafted') continue
    capabilities[family] = `${family.replace('@', '').replaceAll('/', '-')}-native`
  }
  return [
    'pnpm_platform_gated_packages(',
    '    name = "platform_gated_packages",',
    `    capabilities = ${renderDict({ indent: 4, record: capabilities })},`,
    '    families = {',
    ...families.map(
      (family) =>
        `        ${starlarkString(family)}: [${(byFamily.get(family) ?? [])
          .toSorted((left, right) => compareStrings({ left, right }))
          .map(starlarkString)
          .join(', ')}],`,
    ),
    '    },',
    '    visibility = ["PUBLIC"],',
    ')',
    '',
  ].join('\n')
}

/**
 * Renders the normalized store declarations for the whole repository.
 *
 * One entry per peer-resolved snapshot, one component target per real lockfile
 * cycle, and one metadata-only view per importer. Entries and views declare a
 * `select()` only where the lockfile itself resolves different edges per
 * platform.
 */
export const renderPnpmStoreBuck = (projection: PnpmStoreProjection): string => {
  const targetByStoreKey = new Map(
    projection.entries.map((entry) => [entry.storeKey, `:${entry.target}`]),
  )
  const entryByStoreKey = new Map(projection.entries.map((entry) => [entry.storeKey, entry]))
  const lines = [
    'load(":defs.bzl", "pnpm_directory_package", "pnpm_platform_configurations", "pnpm_store_entry", "pnpm_store_scc", "pnpm_store_view")',
    '',
    'pnpm_platform_configurations()',
    '',
    'export_file(',
    '    name = "assemble-store.ts",',
    '    src = "assemble-store.ts",',
    '    visibility = ["PUBLIC"],',
    ')',
    '',
  ]

  for (const scc of projection.sccs) {
    const supported = pnpmPlatforms.filter((platform) =>
      scc.members.some((key) => entryByStoreKey.get(key)!.platforms.includes(platform)),
    )
    const membersByPlatform = byPlatform((platform) =>
      Object.fromEntries(
        scc.members.flatMap((storeKey) => {
          const entry = entryByStoreKey.get(storeKey) ?? fail(`unknown store entry ${storeKey}`)
          return entry.platforms.includes(platform) ? [[storeKey, `:${entry.packageTarget}`]] : []
        }),
      ),
    )
    const members = new Set(scc.members)
    const internalByPlatform = byPlatform((platform) => {
      const internal: Record<string, string> = {}
      for (const storeKey of scc.members) {
        const entry = entryByStoreKey.get(storeKey) ?? fail(`unknown store entry ${storeKey}`)
        for (const [name, edge] of sortedEntries(edgesFor({ entry, platform }))) {
          if (edge.kind !== 'entry' || members.has(edge.storeKey) === false) continue
          internal[`${storeKey}\t${name}`] = edge.storeKey
        }
      }
      return internal
    })
    const externalByPlatform = byPlatform((platform) => {
      const external: Record<string, string> = {}
      for (const storeKey of scc.members) {
        const entry = entryByStoreKey.get(storeKey) ?? fail(`unknown store entry ${storeKey}`)
        for (const [name, edge] of sortedEntries(edgesFor({ entry, platform }))) {
          if (edge.kind !== 'entry') {
            return fail(`component member ${storeKey} depends on workspace ${name}`)
          }
          if (members.has(edge.storeKey) === true) continue
          external[`${storeKey}\t${name}`] =
            targetByStoreKey.get(edge.storeKey) ?? fail(`unknown store entry ${edge.storeKey}`)
        }
      }
      return external
    })
    lines.push(
      'pnpm_store_scc(',
      `    name = ${starlarkString(scc.target)},`,
      '    runtime = ":assemble-store.ts",',
      ...renderUnavailablePlatforms({ owner: `component ${scc.target}`, platforms: supported }),
      ...renderMaybeSelected({ byPlatform: membersByPlatform, field: 'members' }),
      ...renderMaybeSelected({ byPlatform: internalByPlatform, field: 'internal_edges' }),
      ...renderMaybeSelected({ byPlatform: externalByPlatform, field: 'external_edges' }),
      ')',
      '',
    )
  }

  for (const entry of projection.entries) {
    if (entry.sourceTree !== undefined) {
      lines.push(
        'pnpm_directory_package(',
        `    name = ${starlarkString(entry.packageTarget)},`,
        `    package_name = ${starlarkString(entry.packageName)},`,
        `    source = ${starlarkString(entry.sourceTree)},`,
        ')',
        '',
      )
    }
    lines.push(
      'pnpm_store_entry(',
      `    name = ${starlarkString(entry.target)},`,
      `    package = ${starlarkString(`:${entry.packageTarget}`)},`,
      `    store_key = ${starlarkString(entry.storeKey)},`,
      '    runtime = ":assemble-store.ts",',
      ...renderUnavailablePlatforms({
        owner: `entry ${entry.snapshot}`,
        platforms: entry.platforms,
      }),
    )
    const overrideLines = renderPackageOverride(entry)
    if (entry.sccIndex === undefined) {
      lines.push(
        ...overrideLines,
        ...renderMaybeSelected({
          byPlatform: byPlatform((platform) =>
            packageEdges({ edges: edgesFor({ entry, platform }), targetByStoreKey }),
          ),
          field: 'dependencies',
        }),
      )
      if (entry.workspaceTrees !== undefined) {
      lines.push(
        ...renderMaybeSelected({
          byPlatform: byPlatform((platform) =>
            Object.fromEntries(
              sortedEntries(edgesFor({ entry, platform })).flatMap(([name, edge]) =>
                edge.kind === 'workspace'
                  ? [[name, entry.workspaceTrees?.[edge.workspaceKey] ??
                      fail(`entry ${entry.snapshot} has no workspace tree ${edge.workspaceKey}`)]]
                  : [],
              ),
            ),
          ),
          field: 'workspaces',
        }),
      )
      }
    } else {
      if (overrideLines.length > 0) {
        return fail(
          `store entry ${entry.storeKey} is a cycle member and cannot graft its package bytes`,
        )
      }
      const scc = projection.sccs[entry.sccIndex] ?? fail(`unknown component ${entry.sccIndex}`)
      lines.push(`    scc = ${starlarkString(`:${scc.target}`)},`)
    }
    lines.push('    visibility = ["PUBLIC"],', ')', '')
  }

  for (const view of projection.views) {
    lines.push(...renderView({ entryByStoreKey, targetByStoreKey, view }))
  }
  return lines.join('\n')
}
