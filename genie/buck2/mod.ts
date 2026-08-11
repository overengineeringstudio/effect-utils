import { createHash } from 'node:crypto'

import {
  createGenieOutput,
  type GenieOutput,
} from '../../packages/@overeng/genie/src/runtime/core.ts'
import { projectionArtifact } from '../../packages/@overeng/genie/src/runtime/projection-artifact/mod.ts'

export const buck2ProjectionSchemaVersion = 2 as const
export const buck2ProjectionGenerator = 'effect-utils/genie/buck2' as const

type CanonicalJson =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalJson[]
  | CanonicalJsonObject
type CanonicalJsonObject = { readonly [key: string]: CanonicalJson }

export type Buck2ProjectionProvenance = {
  readonly generator: typeof buck2ProjectionGenerator
  readonly regenerationCommand: string
  readonly semanticFingerprint: `sha256:${string}`
  readonly semanticInputs: readonly string[]
}

export type Buck2TargetProjection = {
  readonly name: string
  readonly kind: string
  /** Nix execution platform admitted by this target. */
  readonly platform: string
  /** Repo-relative source paths consumed by the target. */
  readonly sources: readonly string[]
  /** Repo-relative configuration paths consumed by the target. */
  readonly configs: readonly string[]
  /** Buck labels for target dependencies. */
  readonly deps: readonly string[]
  /** Repo-relative closure descriptor consumed by the target. */
  readonly closureDescriptor: string
}

export type Buck2PackageFileArgs = {
  readonly packagePath: string
  readonly macro: {
    readonly load: string
    readonly symbol: string
  }
  readonly targets: readonly Buck2TargetProjection[]
  readonly semanticInputs: readonly string[]
  readonly regenerationCommand: string
}

export type Buck2PackageFileData = {
  readonly packagePath: string
  readonly macro: {
    readonly load: string
    readonly symbol: string
  }
  readonly targets: readonly Buck2TargetProjection[]
  readonly provenance: Buck2ProjectionProvenance
}

export type Buck2ClosureDescriptorArgs<TClosure> = {
  readonly packagePath: string
  readonly target: Buck2TargetProjection
  /**
   * Already-resolved closure data from the dependency compiler.
   *
   * This projection layer deliberately does not read or interpret pnpm state.
   */
  readonly resolvedClosure: TClosure
  readonly semanticInputs: readonly string[]
  readonly regenerationCommand: string
}

export type Buck2ClosureDescriptor<TClosure> = {
  readonly closure: TClosure
  readonly packagePath: string
  readonly provenance: Buck2ProjectionProvenance
  readonly schemaVersion: typeof buck2ProjectionSchemaVersion
  readonly target: Buck2TargetProjection
}

type Buck2PackageFileSemanticData = Omit<Buck2PackageFileData, 'provenance'>
type Buck2ClosureSemanticData<TClosure> = Omit<
  Buck2ClosureDescriptor<TClosure>,
  'provenance' | 'schemaVersion'
>

const compareStrings = ({ left, right }: { left: string; right: string }): number =>
  left < right ? -1 : left > right ? 1 : 0

const sortedUnique = ({
  values,
  label,
}: {
  values: readonly string[]
  label: string
}): readonly string[] => {
  const sorted = values.toSorted((left, right) => compareStrings({ left, right }))
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index - 1] === sorted[index]) {
      throw new Error(`Duplicate ${label}: ${sorted[index]}`)
    }
  }
  return sorted
}

const requireNonEmpty = ({ value, label }: { value: string; label: string }): string => {
  if (value.length === 0) throw new Error(`${label} must not be empty`)
  return value
}

const canonicalJsonValue = ({
  value,
  path = '$',
}: {
  value: unknown
  path?: string
}): CanonicalJson => {
  if (Array.isArray(value) === true) {
    return value.map((child, index) =>
      canonicalJsonValue({ value: child, path: `${path}[${index}]` }),
    )
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value) === true) return value
  if (value === null || typeof value !== 'object') {
    throw new Error(`Buck2 projection value at ${path} is not JSON-compatible`)
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => entry[1] !== undefined)
      .toSorted(([left], [right]) => compareStrings({ left, right }))
      .map(([key, child]) => [key, canonicalJsonValue({ value: child, path: `${path}.${key}` })]),
  )
}

const semanticFingerprint = (value: unknown): `sha256:${string}` =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalJsonValue({ value })))
    .digest('hex')}`

const normalizeTarget = (target: Buck2TargetProjection): Buck2TargetProjection => ({
  name: requireNonEmpty({ value: target.name, label: 'target name' }),
  kind: requireNonEmpty({ value: target.kind, label: `target ${target.name} kind` }),
  platform: requireNonEmpty({ value: target.platform, label: `target ${target.name} platform` }),
  sources: sortedUnique({ values: target.sources, label: `source in target ${target.name}` }),
  configs: sortedUnique({ values: target.configs, label: `config in target ${target.name}` }),
  deps: sortedUnique({ values: target.deps, label: `dependency in target ${target.name}` }),
  closureDescriptor: requireNonEmpty({
    value: target.closureDescriptor,
    label: `target ${target.name} closure descriptor`,
  }),
})

const normalizePackageSemanticData = (args: Buck2PackageFileArgs): Buck2PackageFileSemanticData => {
  const targets = args.targets
    .map(normalizeTarget)
    .toSorted((left, right) => compareStrings({ left: left.name, right: right.name }))
  for (let index = 1; index < targets.length; index += 1) {
    if (targets[index - 1]?.name === targets[index]?.name) {
      throw new Error(`Duplicate Buck target name: ${targets[index]?.name}`)
    }
  }

  return {
    packagePath: requireNonEmpty({ value: args.packagePath, label: 'package path' }),
    macro: {
      load: requireNonEmpty({ value: args.macro.load, label: 'macro load label' }),
      symbol: requireNonEmpty({ value: args.macro.symbol, label: 'macro symbol' }),
    },
    targets,
  }
}

const provenance = ({
  semanticData,
  semanticInputs,
  regenerationCommand,
}: {
  semanticData: unknown
  semanticInputs: readonly string[]
  regenerationCommand: string
}): Buck2ProjectionProvenance => ({
  generator: buck2ProjectionGenerator,
  regenerationCommand: requireNonEmpty({
    value: regenerationCommand,
    label: 'regeneration command',
  }),
  semanticFingerprint: semanticFingerprint(semanticData),
  semanticInputs: sortedUnique({ values: semanticInputs, label: 'semantic input' }),
})

const starlarkString = (value: string): string => JSON.stringify(value)

const renderStringList = ({
  name,
  values,
}: {
  name: string
  values: readonly string[]
}): readonly string[] => [
  `    ${name} = [`,
  ...values.map((value) => `        ${starlarkString(value)},`),
  '    ],',
]

const renderPackageFile = (data: Buck2PackageFileData): string => {
  const lines = [
    '# GENERATED FILE - DO NOT EDIT. Edit the corresponding .genie.ts source.',
    `# Projection schema version: ${buck2ProjectionSchemaVersion}`,
    `# Projection generator: ${data.provenance.generator}`,
    `# Semantic fingerprint: ${data.provenance.semanticFingerprint}`,
    `# Semantic inputs: ${data.provenance.semanticInputs.join(', ')}`,
    `# Regenerate: ${data.provenance.regenerationCommand}`,
    '',
    `load(${starlarkString(data.macro.load)}, ${starlarkString(data.macro.symbol)})`,
    '',
  ]

  for (const target of data.targets) {
    lines.push(
      `${data.macro.symbol}(`,
      `    name = ${starlarkString(target.name)},`,
      `    package_path = ${starlarkString(data.packagePath)},`,
      `    kind = ${starlarkString(target.kind)},`,
      `    platform = ${starlarkString(target.platform)},`,
      ...renderStringList({ name: 'sources', values: target.sources }),
      ...renderStringList({ name: 'configs', values: target.configs }),
      ...renderStringList({ name: 'deps', values: target.deps }),
      `    closure_descriptor = ${starlarkString(target.closureDescriptor)},`,
      ')',
      '',
    )
  }

  return `${lines.join('\n').trimEnd()}\n`
}

/** Render a package-local BUCK file from explicit, already-derived target metadata. */
const packageFile = (args: Buck2PackageFileArgs): GenieOutput<Buck2PackageFileData> => {
  const semanticData = normalizePackageSemanticData(args)
  const data: Buck2PackageFileData = {
    ...semanticData,
    provenance: provenance({
      semanticData,
      semanticInputs: args.semanticInputs,
      regenerationCommand: args.regenerationCommand,
    }),
  }

  return createGenieOutput({
    data,
    stringify: () => renderPackageFile(data),
  })
}

/**
 * Emit a stable closure descriptor around closure data resolved by another owner.
 * Object keys are canonicalized; array order inside `resolvedClosure` remains semantic.
 */
const closureDescriptor = <const TClosure>(
  args: Buck2ClosureDescriptorArgs<TClosure>,
): GenieOutput<Buck2ClosureDescriptor<TClosure>> => {
  const semanticData: Buck2ClosureSemanticData<TClosure> = {
    closure: canonicalJsonValue({ value: args.resolvedClosure }) as TClosure,
    packagePath: requireNonEmpty({ value: args.packagePath, label: 'package path' }),
    target: normalizeTarget(args.target),
  }
  const descriptor: Buck2ClosureDescriptor<TClosure> = {
    ...semanticData,
    provenance: provenance({
      semanticData,
      semanticInputs: args.semanticInputs,
      regenerationCommand: args.regenerationCommand,
    }),
    schemaVersion: buck2ProjectionSchemaVersion,
  }

  return projectionArtifact.json({
    data: descriptor,
    schemaVersion: buck2ProjectionSchemaVersion,
    project: (data) => data,
  }) as GenieOutput<Buck2ClosureDescriptor<TClosure>>
}

export const buck2Projection = {
  closureDescriptor,
  packageFile,
} as const
