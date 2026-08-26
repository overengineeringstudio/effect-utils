import { readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'

/** Schema identifier for the persisted pnpm install descriptor. */
export const pnpmInstallDescriptorSchema = 'effect-utils/pnpm-install-descriptor/v1' as const

/** Portable placeholder for a materialization-time workspace path. */
export const pnpmWorkspacePlaceholder = 'file://<WS>'

const dependencyFields = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

type JsonRecord = { [key: string]: unknown }

type DescriptorInput = {
  readonly rawLockfile: string
  readonly stagePrefix: string
  readonly packageName: string
  readonly workspaceManifest: string
  readonly packageManifests: ReadonlyMap<string, string>
  readonly patches: ReadonlyMap<string, string>
}

/** Frozen inputs required to replay a pruned pnpm installation. */
export type PnpmInstallDescriptor = {
  readonly schema: typeof pnpmInstallDescriptorSchema
  readonly packageName: string
  readonly files: {
    readonly lockfile: 'pnpm-lock.yaml'
    readonly packageManifest: 'package.json'
    readonly workspaceManifest: 'pnpm-workspace.yaml'
    readonly workspacePackageManifests: readonly string[]
    readonly patches: readonly string[]
  }
  readonly installArgv: readonly [
    '--dir',
    '<INSTALL_ROOT>',
    '--store-dir',
    '<STORE_DIR>',
    'install',
    '--prod=false',
    '--ignore-scripts',
    '--offline',
    '--frozen-lockfile',
  ]
}

/** Descriptor and canonical files produced by the prune stage. */
export type PreparedPnpmInstallDescriptor = {
  readonly descriptor: PnpmInstallDescriptor
  readonly lockfile: string
  readonly packageManifest: string
  readonly workspaceManifest: string
  readonly workspacePackageManifests: ReadonlyMap<string, string>
  readonly patches: ReadonlyMap<string, string>
}

const fail = (message: string): never => {
  throw new Error(`pnpm install descriptor: ${message}`)
}

const failWithCause = ({
  message,
  cause,
}: {
  readonly message: string
  readonly cause: unknown
}): never => {
  throw new Error(`pnpm install descriptor: ${message}`, { cause })
}

const requireDefined = <TValue>({
  value,
  field,
}: {
  readonly value: TValue | undefined
  readonly field: string
}): TValue => value ?? fail(`${field} is required`)

const pinnedYaml = (() => {
  const bun = Reflect.get(globalThis, 'Bun')
  const yaml = bun === null || typeof bun !== 'object' ? undefined : Reflect.get(bun, 'YAML')
  const parse = yaml === null || typeof yaml !== 'object' ? undefined : Reflect.get(yaml, 'parse')
  const stringify =
    yaml === null || typeof yaml !== 'object' ? undefined : Reflect.get(yaml, 'stringify')
  const parseYaml =
    typeof parse === 'function' ? parse : fail('pinned Bun runtime does not provide YAML.parse')
  const stringifyYaml =
    typeof stringify === 'function'
      ? stringify
      : fail('pinned Bun runtime does not provide YAML.stringify')
  return {
    parse: (source: string): unknown => Reflect.apply(parseYaml, yaml, [source]),
    stringify: ({
      value,
      replacer,
      indentation,
    }: {
      readonly value: unknown
      readonly replacer: null
      readonly indentation: number
    }): string => {
      const serialized: unknown = Reflect.apply(stringifyYaml, yaml, [value, replacer, indentation])
      return typeof serialized === 'string'
        ? serialized
        : fail('Bun YAML.stringify returned a non-string')
    },
  }
})()

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && Array.isArray(value) === false && typeof value === 'object'

const requireRecord = ({
  value,
  field,
}: {
  readonly value: unknown
  readonly field: string
}): JsonRecord => (isRecord(value) === true ? value : fail(`${field} must be a mapping`))

const requireStringRecord = ({
  value,
  field,
}: {
  readonly value: unknown
  readonly field: string
}): Record<string, string> => {
  const record = requireRecord({ value, field })
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') fail(`${field}.${key} must be a string`)
  }
  return record as Record<string, string>
}

const parseYamlRecord = ({
  source,
  field,
}: {
  readonly source: string
  readonly field: string
}): JsonRecord => {
  let value: unknown
  try {
    value = pinnedYaml.parse(source)
  } catch (error) {
    failWithCause({
      message: `${field} is malformed YAML: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    })
  }
  return requireRecord({ value, field })
}

const compareCodeUnits = ({
  left,
  right,
}: {
  readonly left: string
  readonly right: string
}): number => (left < right ? -1 : left > right ? 1 : 0)

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value) === true) return value.map(sortValue)
  if (isRecord(value) === false) return value
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => compareCodeUnits({ left, right }))
      .map(([key, entry]) => [key, sortValue(entry)]),
  )
}

const replaceStagePrefix = ({
  value,
  stagePrefix,
}: {
  readonly value: string
  readonly stagePrefix: string
}): string => {
  const normalizedStage = resolve(stagePrefix)
  return value
    .replaceAll(`file://${normalizedStage}`, pnpmWorkspacePlaceholder)
    .replaceAll(`file:${normalizedStage}`, pnpmWorkspacePlaceholder)
    .replaceAll(normalizedStage, pnpmWorkspacePlaceholder)
}

const canonicalizeValue = ({
  value,
  stagePrefix,
}: {
  readonly value: unknown
  readonly stagePrefix: string
}): unknown => {
  if (typeof value === 'string') return replaceStagePrefix({ value, stagePrefix })
  if (Array.isArray(value) === true)
    return value.map((entry) => canonicalizeValue({ value: entry, stagePrefix }))
  if (isRecord(value) === false) return value

  const entries: [string, unknown][] = []
  const seen = new Set<string>()
  for (const [rawKey, rawEntry] of Object.entries(value)) {
    const key = replaceStagePrefix({ value: rawKey, stagePrefix })
    if (seen.has(key) === true)
      fail(`stage-prefix replacement produces duplicate mapping key: ${key}`)
    seen.add(key)
    entries.push([key, canonicalizeValue({ value: rawEntry, stagePrefix })])
  }
  return Object.fromEntries(entries)
}

/** Canonicalizes a pruned pnpm lockfile for reproducible replay. */
export const canonicalizePnpmPrunedLock = ({
  rawLockfile,
  stagePrefix,
}: {
  readonly rawLockfile: string
  readonly stagePrefix: string
}): string => {
  const parsed = parseYamlRecord({ source: rawLockfile, field: 'pruned lockfile' })
  requireRecord({ value: parsed.importers, field: 'pruned lockfile.importers' })
  requireRecord({ value: parsed.packages, field: 'pruned lockfile.packages' })
  requireRecord({ value: parsed.snapshots, field: 'pruned lockfile.snapshots' })

  const canonical = canonicalizeValue({ value: parsed, stagePrefix })
  const canonicalPackages = requireRecord({
    value: requireRecord({ value: canonical, field: 'canonical lockfile' }).packages,
    field: 'canonical lockfile.packages',
  })
  for (const [packageKey, packageValue] of Object.entries(canonicalPackages)) {
    const packageRecord = requireRecord({
      value: packageValue,
      field: `canonical lockfile.packages.${packageKey}`,
    })
    delete packageRecord.peerDependencies
  }

  const serialized: string = pinnedYaml.stringify({
    value: sortValue(canonical),
    replacer: null,
    indentation: 2,
  })
  const normalizedStage = resolve(stagePrefix)
  if (serialized.includes(normalizedStage) === true)
    fail(`canonical lockfile retains staging prefix: ${normalizedStage}`)
  if (/file:\/(?!\/<WS>)/.test(serialized) === true) {
    fail('canonical lockfile retains an unresolved absolute file reference')
  }
  return serialized.endsWith('\n') === true ? serialized : `${serialized}\n`
}

const readManifest = ({
  source,
  field,
}: {
  readonly source: string
  readonly field: string
}): JsonRecord => {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    failWithCause({
      message: `${field} is malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    })
  }
  return requireRecord({ value, field })
}

const findTargetManifest = ({
  packageName,
  packageManifests,
}: {
  readonly packageName: string
  readonly packageManifests: ReadonlyMap<string, string>
}): { readonly path: string; readonly manifest: JsonRecord } => {
  const matches = [...packageManifests].flatMap(([path, source]) => {
    const manifest = readManifest({ source, field: `workspace manifest ${path}` })
    return manifest.name === packageName ? [{ path, manifest }] : []
  })
  if (matches.length !== 1)
    fail(`expected exactly one manifest named ${packageName}, found ${matches.length}`)
  return matches[0]!
}

const replayManifest = ({
  target,
  importer,
}: {
  readonly target: JsonRecord
  readonly importer: JsonRecord
}): JsonRecord => {
  const result = structuredClone(target)
  for (const field of dependencyFields) {
    const importerDependencies = importer[field]
    if (importerDependencies === undefined) {
      delete result[field]
      continue
    }
    const dependencies = requireRecord({
      value: importerDependencies,
      field: `pruned lockfile.importers...${field}`,
    })
    result[field] = Object.fromEntries(
      Object.entries(dependencies)
        .toSorted(([left], [right]) => compareCodeUnits({ left, right }))
        .map(([alias, value]) => {
          const dependency = requireRecord({
            value,
            field: `pruned lockfile importer ${field}.${alias}`,
          })
          if (typeof dependency.specifier !== 'string') {
            fail(`pruned lockfile importer ${field}.${alias}.specifier must be a string`)
          }
          return [alias, dependency.specifier]
        }),
    )
  }
  return sortValue(result) as JsonRecord
}

const collectFileReferences = ({
  value,
  references,
}: {
  readonly value: unknown
  readonly references: Set<string>
}): void => {
  const collect = (text: string): void => {
    const matches = text.matchAll(/file:(?:\/\/<WS>\/?)?([^()\s'"\\]+)/g)
    for (const match of matches) {
      const path = requireDefined({ value: match[1], field: `file reference ${match[0]}` })
      if (path.length === 0 || path.startsWith('/') === true)
        fail(`unresolved file reference: ${match[0]}`)
      references.add(path.replace(/\/$/, ''))
    }
  }
  if (typeof value === 'string') {
    collect(value)
    return
  }
  if (Array.isArray(value) === true) {
    for (const entry of value) collectFileReferences({ value: entry, references })
    return
  }
  if (isRecord(value) === true) {
    for (const [key, entry] of Object.entries(value)) {
      collect(key)
      collectFileReferences({ value: entry, references })
    }
  }
}

const canonicalJson = (value: unknown): string => `${JSON.stringify(sortValue(value), null, 2)}\n`

/** Prepares the canonical descriptor and files for the install stage. */
export const preparePnpmInstallDescriptor = (
  input: DescriptorInput,
): PreparedPnpmInstallDescriptor => {
  if (input.packageName.length === 0) fail('packageName must not be empty')
  const canonicalLockfile = canonicalizePnpmPrunedLock(input)
  const canonicalLock = parseYamlRecord({ source: canonicalLockfile, field: 'canonical lockfile' })
  const importers = requireRecord({
    value: canonicalLock.importers,
    field: 'canonical lockfile.importers',
  })
  const importer = requireRecord({ value: importers['.'], field: 'canonical lockfile.importers..' })
  const target = findTargetManifest({
    packageName: input.packageName,
    packageManifests: input.packageManifests,
  })

  const fileReferences = new Set<string>()
  collectFileReferences({ value: canonicalLock, references: fileReferences })
  const relevantManifests = new Map<string, string>()
  for (const reference of [...fileReferences].toSorted((left, right) =>
    compareCodeUnits({ left, right }),
  )) {
    const manifestPath = posix.join(reference, 'package.json')
    const source = requireDefined({
      value: input.packageManifests.get(manifestPath),
      field: `unresolved file reference ${reference}: missing ${manifestPath}`,
    })
    readManifest({ source, field: `workspace manifest ${manifestPath}` })
    relevantManifests.set(manifestPath, canonicalJson(JSON.parse(source)))
  }

  const workspace = parseYamlRecord({
    source: input.workspaceManifest,
    field: 'workspace manifest',
  })
  const configuredPatches =
    workspace.patchedDependencies === undefined
      ? {}
      : requireStringRecord({
          value: workspace.patchedDependencies,
          field: 'workspace manifest.patchedDependencies',
        })
  const lockPatches =
    canonicalLock.patchedDependencies === undefined
      ? {}
      : requireStringRecord({
          value: canonicalLock.patchedDependencies,
          field: 'canonical lockfile.patchedDependencies',
        })
  const patchMappings: Record<string, string> = {}
  const relevantPatches = new Map<string, string>()
  for (const packageKey of Object.keys(lockPatches).toSorted((left, right) =>
    compareCodeUnits({ left, right }),
  )) {
    const patchPath = requireDefined({
      value: configuredPatches[packageKey],
      field: `unresolved patch reference for ${packageKey}`,
    })
    const source = requireDefined({
      value: input.patches.get(patchPath),
      field: `unresolved patch path ${patchPath} for ${packageKey}`,
    })
    patchMappings[packageKey] = patchPath
    relevantPatches.set(patchPath, source)
  }

  const lockSettings =
    canonicalLock.settings === undefined
      ? {}
      : requireRecord({ value: canonicalLock.settings, field: 'canonical lockfile.settings' })
  const replayWorkspace: JsonRecord = {
    packages: [],
    ignoreScripts: true,
    ...(typeof lockSettings.autoInstallPeers === 'boolean'
      ? { autoInstallPeers: lockSettings.autoInstallPeers }
      : {}),
    ...(typeof lockSettings.excludeLinksFromLockfile === 'boolean'
      ? { excludeLinksFromLockfile: lockSettings.excludeLinksFromLockfile }
      : {}),
    ...(Object.keys(patchMappings).length === 0 ? {} : { patchedDependencies: patchMappings }),
  }

  const descriptor: PnpmInstallDescriptor = {
    schema: pnpmInstallDescriptorSchema,
    packageName: input.packageName,
    files: {
      lockfile: 'pnpm-lock.yaml',
      packageManifest: 'package.json',
      workspaceManifest: 'pnpm-workspace.yaml',
      workspacePackageManifests: [...relevantManifests.keys()],
      patches: [...relevantPatches.keys()],
    },
    installArgv: [
      '--dir',
      '<INSTALL_ROOT>',
      '--store-dir',
      '<STORE_DIR>',
      'install',
      '--prod=false',
      '--ignore-scripts',
      '--offline',
      '--frozen-lockfile',
    ],
  }

  return {
    descriptor,
    lockfile: canonicalLockfile,
    packageManifest: canonicalJson(replayManifest({ target: target.manifest, importer })),
    workspaceManifest: pinnedYaml.stringify({
      value: sortValue(replayWorkspace),
      replacer: null,
      indentation: 2,
    }),
    workspacePackageManifests: relevantManifests,
    patches: relevantPatches,
  }
}

const exactKeys = ({
  record,
  expected,
  field,
}: {
  readonly record: JsonRecord
  readonly expected: readonly string[]
  readonly field: string
}): void => {
  const actual = Object.keys(record).toSorted((left, right) => compareCodeUnits({ left, right }))
  const wanted = [...expected].toSorted((left, right) => compareCodeUnits({ left, right }))
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${field} has unexpected fields`)
}

/** Reads and validates a prepared pnpm install descriptor directory. */
export const readPnpmInstallDescriptor = (directory: string): PnpmInstallDescriptor => {
  const source = readFileSync(resolve(directory, 'install-descriptor.json'), 'utf8')
  const value = readManifest({ source, field: 'install-descriptor.json' })
  exactKeys({
    record: value,
    expected: ['files', 'installArgv', 'packageName', 'schema'],
    field: 'install descriptor',
  })
  if (value.schema !== pnpmInstallDescriptorSchema)
    fail(`unsupported schema: ${String(value.schema)}`)
  if (typeof value.packageName !== 'string' || value.packageName.length === 0)
    fail('packageName must be a string')
  const files = requireRecord({ value: value.files, field: 'install descriptor.files' })
  exactKeys({
    record: files,
    expected: [
      'lockfile',
      'packageManifest',
      'patches',
      'workspaceManifest',
      'workspacePackageManifests',
    ],
    field: 'install descriptor.files',
  })
  if (
    files.lockfile !== 'pnpm-lock.yaml' ||
    files.packageManifest !== 'package.json' ||
    files.workspaceManifest !== 'pnpm-workspace.yaml'
  ) {
    fail('install descriptor fixed file names do not match the schema')
  }
  for (const field of ['workspacePackageManifests', 'patches'] as const) {
    if (
      Array.isArray(files[field]) === false ||
      files[field].some((entry) => typeof entry !== 'string') === true
    ) {
      fail(`install descriptor.files.${field} must be a string array`)
    }
  }
  const expectedArgv = [
    '--dir',
    '<INSTALL_ROOT>',
    '--store-dir',
    '<STORE_DIR>',
    'install',
    '--prod=false',
    '--ignore-scripts',
    '--offline',
    '--frozen-lockfile',
  ]
  if (
    Array.isArray(value.installArgv) === false ||
    JSON.stringify(value.installArgv) !== JSON.stringify(expectedArgv)
  ) {
    fail('installArgv does not match the frozen replay contract')
  }
  return value as PnpmInstallDescriptor
}

/** Resolves the descriptor's install placeholders to concrete paths. */
export const resolvePnpmInstallArgv = ({
  descriptor,
  installRoot,
  storeDir,
}: {
  readonly descriptor: PnpmInstallDescriptor
  readonly installRoot: string
  readonly storeDir: string
}): readonly string[] =>
  descriptor.installArgv.map((argument) =>
    argument === '<INSTALL_ROOT>' ? installRoot : argument === '<STORE_DIR>' ? storeDir : argument,
  )

/** Rehydrates portable workspace references for the install stage. */
export const rehydratePnpmWorkspacePlaceholder = ({
  lockfile,
  installRoot,
}: {
  readonly lockfile: string
  readonly installRoot: string
}): string => {
  const replacement = `file:${resolve(installRoot)}`
  const rehydrated = lockfile.replaceAll(pnpmWorkspacePlaceholder, replacement)
  if (rehydrated.includes(pnpmWorkspacePlaceholder) === true)
    fail('lockfile retains workspace placeholder')
  return rehydrated
}
