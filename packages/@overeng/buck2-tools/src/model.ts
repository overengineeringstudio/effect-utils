/* oxlint-disable overeng/jsdoc-require-exports, overeng/exports-first, overeng/explicit-boolean-compare -- This file is the dense closure wire contract; field names and identity schemas are its public documentation, and exported codecs depend on one private constructor. */
export const supportedPnpmVersion = '11.8.0' as const
export const supportedLockfileVersion = '9.0' as const
export const closureCompilerAbi = 'effect-utils.pnpm-closure.v1' as const

declare const packageContentIdBrand: unique symbol
declare const packageContextIdBrand: unique symbol
declare const taskClosureIdBrand: unique symbol

export type PackageContentId = string & { readonly [packageContentIdBrand]: true }
export type PackageContextId = string & { readonly [packageContextIdBrand]: true }
export type TaskClosureId = string & { readonly [taskClosureIdBrand]: true }

export interface CanonicalIdentitySchema<TIdentity extends string> {
  readonly identifier: string
  readonly pattern: RegExp
  readonly decode: (input: string) => TIdentity
}

const identitySchema = <TIdentity extends string>(args: {
  readonly identifier: string
  readonly pattern: RegExp
}): CanonicalIdentitySchema<TIdentity> => ({
  ...args,
  decode: (input) => {
    if (!args.pattern.test(input)) {
      throw new TypeError(`${args.identifier} must match ${args.pattern}; received ${input}`)
    }
    return input as TIdentity
  },
})

export const PackageContentId = identitySchema<PackageContentId>({
  identifier: 'Buck2Tools.PackageContentId',
  pattern: /^pc1_[a-f0-9]{64}$/,
})

export const PackageContextId = identitySchema<PackageContextId>({
  identifier: 'Buck2Tools.PackageContextId',
  pattern: /^px1_[a-f0-9]{64}$/,
})

export const TaskClosureId = identitySchema<TaskClosureId>({
  identifier: 'Buck2Tools.TaskClosureId',
  pattern: /^tc1_[a-f0-9]{64}$/,
})

export interface ExecutionPlatform {
  readonly os: string
  readonly cpu: string
  readonly libc?: string
  readonly nodeAbi?: string
}

export type PlatformRole = 'exec' | 'target'
export type DependencyField = 'dependencies' | 'devDependencies' | 'optionalDependencies'

export interface TaskDependencyRoot {
  readonly alias: string
  readonly field: DependencyField
  readonly reason: string
}

export interface TaskClosureRequest {
  readonly label: string
  readonly importerId: string
  readonly mode: string
  readonly platformRole: PlatformRole
  readonly platform: ExecutionPlatform
  readonly roots: readonly TaskDependencyRoot[]
}

export interface MaterializerIdentity {
  readonly abi: string
  readonly buildPolicyDigest: string
}

export interface VerifiedNormalizedPayload {
  readonly digest: string
  readonly materializer: MaterializerIdentity
}

export interface PnpmDependencyReferenceRecord {
  specifier: string
  version: string
}

export type PnpmDependencyReference = string | PnpmDependencyReferenceRecord

export interface PnpmImporterSnapshot {
  dependencies?: Record<string, PnpmDependencyReference>
  devDependencies?: Record<string, PnpmDependencyReference>
  optionalDependencies?: Record<string, PnpmDependencyReference>
}

export interface PnpmResolution {
  integrity?: string
  tarball?: string
  type?: string
  directory?: string
  repo?: string
  commit?: string
  path?: string
  [key: string]: string | boolean | undefined
}

export interface PnpmPackageSnapshot {
  resolution: PnpmResolution
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  engines?: Record<string, string>
  os?: string[]
  cpu?: string[]
  libc?: string[]
  optional?: boolean
  patched?: boolean
  name?: string
  version?: string
}

export interface PnpmResolvedSnapshot {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  transitivePeerDependencies?: string[]
}

export interface PnpmLockfileV9 {
  lockfileVersion: string
  settings?: Record<string, string | number | boolean>
  packageExtensionsChecksum?: string
  pnpmfileChecksum?: string
  overrides?: Record<string, string>
  catalogs?: Record<string, Record<string, string>>
  patchedDependencies?: Record<string, string>
  importers: Record<string, PnpmImporterSnapshot>
  packages: Record<string, PnpmPackageSnapshot>
  snapshots: Record<string, PnpmResolvedSnapshot>
}

export interface PackageContentRecord {
  readonly id: PackageContentId
  /** Digest of the normalized, final package tree after patches/build policy. */
  readonly normalizedPayloadDigest: string
}

export interface PackageContextRecord {
  readonly id: PackageContextId
  readonly depPath: string
  readonly content: PackageContentId
  /** Lock-native contextual paths; task closures resolve these to context IDs. */
  readonly dependencies: Readonly<Record<string, string>>
  readonly optionalDependencies: Readonly<Record<string, string>>
  readonly peerBindings: Readonly<Record<string, string>>
  readonly workspaceDependencies: Readonly<
    Record<
      string,
      {
        readonly importerId: string
        readonly buckLabel: string
        readonly pnpmReference: string
      }
    >
  >
  readonly transitivePeerDependencies: readonly string[]
  readonly constraints: {
    readonly os: readonly string[]
    readonly cpu: readonly string[]
    readonly libc: readonly string[]
    readonly engines: Readonly<Record<string, string>>
  }
}

export interface ExternalTaskRoot {
  readonly kind: 'external'
  readonly alias: string
  readonly field: DependencyField
  readonly context: PackageContextId
}

export interface WorkspaceTaskRoot {
  readonly kind: 'workspace'
  readonly alias: string
  readonly field: DependencyField
  readonly importerId: string
  readonly buckLabel: string
  readonly pnpmReference: string
  readonly peerContext?: string
}

export interface ExcludedOptionalTaskRoot {
  readonly kind: 'excluded-optional'
  readonly alias: string
  readonly field: 'optionalDependencies'
  readonly depPath: string
  readonly reason: 'cpu' | 'libc' | 'os'
}

export type CompiledTaskRoot = ExternalTaskRoot | WorkspaceTaskRoot | ExcludedOptionalTaskRoot

export interface ExcludedOptionalContext {
  readonly depPath: string
  readonly reason: 'cpu' | 'libc' | 'os'
}

export interface TaskClosureRecord {
  readonly id: TaskClosureId
  readonly label: string
  readonly importerId: string
  readonly mode: string
  readonly platformRole: PlatformRole
  readonly platform: ExecutionPlatform
  readonly roots: readonly CompiledTaskRoot[]
  readonly contexts: readonly PackageContextId[]
  readonly contents: readonly PackageContentId[]
  readonly graph: Readonly<
    Record<
      PackageContextId,
      {
        readonly dependencies: Readonly<Record<string, PackageContextId>>
        readonly optionalDependencies: Readonly<Record<string, PackageContextId>>
        readonly peerBindings: Readonly<Record<string, PackageContextId>>
      }
    >
  >
  readonly excludedOptionalContexts: readonly ExcludedOptionalContext[]
}

export interface ProvenanceRecord {
  readonly subject: PackageContentId | PackageContextId | TaskClosureId
  readonly sources: readonly string[]
  readonly notes: readonly string[]
}

export interface CompiledTaskClosure {
  readonly task: TaskClosureRecord
  readonly contents: Readonly<Record<string, PackageContentRecord>>
  readonly contexts: Readonly<Record<string, PackageContextRecord>>
  readonly provenance: readonly ProvenanceRecord[]
}

export interface ClosureShard {
  readonly path: string
  readonly bytes: string
}
