/**
 * Stable public API for the tracked `buck2-member.json` capability manifest.
 *
 * The manifest declares the Nix-realized executables a repository projects into its standalone
 * Buck root's `capabilities//` cell. `nix/buck2-capabilities.nix` reads it; consumers import this
 * module through `@overeng/megarepo/buck2-manifest`.
 */
import * as PosixPath from 'node:path/posix'

import { Schema } from 'effect'

/** Tracked capability-manifest filename at the repository root. */
export const BUCK_MEMBER_MANIFEST_FILENAME = 'buck2-member.json' as const
/** Capability-manifest wire version. */
export const BUCK_MEMBER_MANIFEST_SCHEMA_VERSION = 2 as const

const strictParseOptions = { errors: 'all', onExcessProperty: 'error' } as const
const buckMemberManifestField: Readonly<Record<string, true>> = {
  schemaVersion: true,
  capabilities: true,
}

const compareCodeUnits = ({
  left,
  right,
}: {
  readonly left: string
  readonly right: string
}): number => (left < right ? -1 : left > right ? 1 : 0)

const CapabilityToken = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(value) === true
      ? undefined
      : 'Expected a non-empty capability token',
  ),
)

const CapabilityProtocol = Schema.String.check(
  Schema.makeFilter<string>((value) =>
    /^[A-Za-z0-9][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+-]*)*$/u.test(value) === true
      ? undefined
      : 'Expected a non-empty versioned capability protocol',
  ),
)

const CapabilityExecutable = Schema.String.check(
  Schema.makeFilter<string>((value) => {
    if (/^[\x20-\x7e]+$/u.test(value) === false || value.includes('\\') === true) {
      return 'Expected a printable POSIX capability executable path'
    }
    if (
      value.startsWith('bin/') === false ||
      value === 'bin/' ||
      PosixPath.normalize(value) !== value
    ) {
      return 'Expected a canonical capability executable below bin/'
    }
    return value
      .split('/')
      .some((segment) => /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u.test(segment) === false) === true
      ? 'Capability executable contains an invalid path segment'
      : undefined
  }),
).annotate({ identifier: 'Megarepo.BuckCapabilityExecutable' })

/** One repository-owned Nix executable capability. */
export const BuckMemberCapabilitySchema = Schema.Struct({
  toolId: CapabilityToken,
  protocol: CapabilityProtocol,
  flakePackage: CapabilityToken,
  executable: CapabilityExecutable,
}).annotate({ identifier: 'Megarepo.BuckMemberCapability' })
export type BuckMemberCapability = typeof BuckMemberCapabilitySchema.Type

/**
 * One toolchain kind and the Nix-realizable executables that constitute it.
 *
 * `provides` is total: every capability the toolchain's Buck rules require is projected. A kind
 * that owns only a developer-time pin (pnpm) declares an empty list.
 */
export const BuckMemberToolchainAuthoritySchema = Schema.TaggedStruct('ToolchainAuthority', {
  toolchain: CapabilityToken,
  provides: Schema.Array(BuckMemberCapabilitySchema),
}).annotate({ identifier: 'Megarepo.BuckMemberToolchainAuthority' })
export type BuckMemberToolchainAuthority = typeof BuckMemberToolchainAuthoritySchema.Type

/** Every capability form admitted in a tracked capability manifest. */
export const BuckMemberManifestCapabilitySchema = Schema.Union([
  BuckMemberCapabilitySchema,
  BuckMemberToolchainAuthoritySchema,
]).annotate({ identifier: 'Megarepo.BuckMemberManifestCapability' })
export type BuckMemberManifestCapability = typeof BuckMemberManifestCapabilitySchema.Type

const isExecutableCapability = (
  capability: BuckMemberManifestCapability,
): capability is BuckMemberCapability => '_tag' in capability === false

/** Strict tracked `buck2-member.json` wire schema. */
export const BuckMemberManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(BUCK_MEMBER_MANIFEST_SCHEMA_VERSION),
  capabilities: Schema.Array(BuckMemberManifestCapabilitySchema),
})
  .check(
    Schema.makeFilter((manifest) => {
      const tools = new Set<string>()
      const authorityKinds = new Set<string>()
      for (const capability of manifest.capabilities) {
        const provided =
          isExecutableCapability(capability) === true ? [capability] : capability.provides
        if (isExecutableCapability(capability) === false) {
          if (authorityKinds.has(capability.toolchain) === true) {
            return `Duplicate toolchain authority: ${capability.toolchain}`
          }
          authorityKinds.add(capability.toolchain)
        }
        for (const executable of provided) {
          if (tools.has(executable.toolId) === true) {
            return `Duplicate capability toolId: ${executable.toolId}`
          }
          tools.add(executable.toolId)
        }
      }
      return undefined
    }),
  )
  .annotate({ identifier: 'Megarepo.BuckMemberManifest' })
export type BuckMemberManifest = typeof BuckMemberManifestSchema.Type

const executableCapabilitySortKey = (capability: BuckMemberCapability): string =>
  `${capability.toolId}:${capability.protocol}:${capability.flakePackage}:${capability.executable}`

const normalizeExecutable = (capability: BuckMemberCapability): BuckMemberCapability => ({
  toolId: capability.toolId,
  protocol: capability.protocol,
  flakePackage: capability.flakePackage,
  executable: capability.executable,
})

const normalizeCapability = (
  capability: BuckMemberManifestCapability,
): BuckMemberManifestCapability =>
  isExecutableCapability(capability) === true
    ? normalizeExecutable(capability)
    : {
        _tag: capability._tag,
        toolchain: capability.toolchain,
        provides: capability.provides.map(normalizeExecutable).toSorted((left, right) =>
          compareCodeUnits({
            left: executableCapabilitySortKey(left),
            right: executableCapabilitySortKey(right),
          }),
        ),
      }

const capabilitySortKey = (capability: BuckMemberManifestCapability): string =>
  isExecutableCapability(capability) === true
    ? `0:${executableCapabilitySortKey(capability)}`
    : `1:${capability.toolchain}`

/** Canonical capability-manifest ordering used by both decoder and encoder. */
export const normalizeBuckMemberManifest = (manifest: BuckMemberManifest): BuckMemberManifest => ({
  schemaVersion: BUCK_MEMBER_MANIFEST_SCHEMA_VERSION,
  capabilities: [...manifest.capabilities]
    .map(normalizeCapability)
    .toSorted((left, right) =>
      compareCodeUnits({ left: capabilitySortKey(left), right: capabilitySortKey(right) }),
    ),
})

/** Decode known top-level fields while preserving strict validation within each known field. */
export const decodeBuckMemberManifest = (input: unknown): BuckMemberManifest => {
  const projectedInput =
    typeof input === 'object' && input !== null && Array.isArray(input) === false
      ? Object.fromEntries(
          Object.entries(input).filter(([field]) => buckMemberManifestField[field] === true),
        )
      : input
  return normalizeBuckMemberManifest(
    Schema.decodeUnknownSync(BuckMemberManifestSchema, strictParseOptions)(projectedInput),
  )
}

/** Strictly encode a capability manifest with canonical arrays. */
export const encodeBuckMemberManifest = (
  manifest: BuckMemberManifest,
): typeof BuckMemberManifestSchema.Encoded =>
  Schema.encodeSync(
    BuckMemberManifestSchema,
    strictParseOptions,
  )(normalizeBuckMemberManifest(manifest))

/** Decode the tracked JSON representation while projecting unknown newer top-level fields. */
export const decodeBuckMemberManifestJson = (json: string): BuckMemberManifest =>
  decodeBuckMemberManifest(Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(json))

/** Canonical tracked JSON bytes, including one trailing newline. */
export const encodeBuckMemberManifestJson = (manifest: BuckMemberManifest): string =>
  `${JSON.stringify(encodeBuckMemberManifest(manifest), undefined, 2)}\n`
