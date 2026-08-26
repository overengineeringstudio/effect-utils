import { readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'

export const pnpmInstallDescriptorSchema = 'effect-utils/pnpm-install-descriptor/v1' as const
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

const requireDefined = <TValue>(value: TValue | undefined, field: string): TValue =>
  value ?? fail(`${field} is required`)

const pinnedYaml = (() => {
  const bun = Reflect.get(globalThis, 'Bun')
  const yaml = bun === null || typeof bun !== 'object' ? undefined : Reflect.get(bun, 'YAML')
  const parse = yaml === null || typeof yaml !== 'object' ? undefined : Reflect.get(yaml, 'parse')
  const stringify = yaml === null || typeof yaml !== 'object' ? undefined : Reflect.get(yaml, 'stringify')
  if (typeof parse !== 'function' || typeof stringify !== 'function') {
    fail('pinned Bun runtime does not provide YAML.parse and YAML.stringify')
  }
  return { parse, stringify }
})()

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && Array.isArray(value) === false && typeof value === 'object'

const requireRecord = (value: unknown, field: string): JsonRecord =>
  isRecord(value) ? value : fail(`${field} must be a mapping`)

const requireStringRecord = (value: unknown, field: string): Record<string, string> => {
  const record = requireRecord(value, field)
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') fail(`${field}.${key} must be a string`)
  }
  return record as Record<string, string>
}

const parseYamlRecord = (source: string, field: string): JsonRecord => {
  let value: unknown
  try {
    value = pinnedYaml.parse(source)
  } catch (error) {
    fail(`${field} is malformed YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  return requireRecord(value, field)
}

const compareCodeUnits = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0)

const sortValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortValue)
  if (isRecord(value) === false) return value
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, entry]) => [key, sortValue(entry)]),
  )
}

const replaceStagePrefix = (value: string, stagePrefix: string): string => {
  const normalizedStage = resolve(stagePrefix)
  return value
    .replaceAll(`file://${normalizedStage}`, pnpmWorkspacePlaceholder)
    .replaceAll(`file:${normalizedStage}`, pnpmWorkspacePlaceholder)
    .replaceAll(normalizedStage, pnpmWorkspacePlaceholder)
}

const canonicalizeValue = (value: unknown, stagePrefix: string): unknown => {
  if (typeof value === 'string') return replaceStagePrefix(value, stagePrefix)
  if (Array.isArray(value)) return value.map((entry) => canonicalizeValue(entry, stagePrefix))
  if (isRecord(value) === false) return value

  const entries: [string, unknown][] = []
  const seen = new Set<string>()
  for (const [rawKey, rawEntry] of Object.entries(value)) {
    const key = replaceStagePrefix(rawKey, stagePrefix)
    if (seen.has(key)) fail(`stage-prefix replacement produces duplicate mapping key: ${key}`)
    seen.add(key)
    entries.push([key, canonicalizeValue(rawEntry, stagePrefix)])
  }
  return Object.fromEntries(entries)
}

export const canonicalizePnpmPrunedLock = ({
  rawLockfile,
  stagePrefix,
}: {
  readonly rawLockfile: string
  readonly stagePrefix: string
}): string => {
  const parsed = parseYamlRecord(rawLockfile, 'pruned lockfile')
  requireRecord(parsed.importers, 'pruned lockfile.importers')
  const packages = requireRecord(parsed.packages, 'pruned lockfile.packages')
  requireRecord(parsed.snapshots, 'pruned lockfile.snapshots')

  const canonical = canonicalizeValue(parsed, stagePrefix)
  const canonicalPackages = requireRecord(requireRecord(canonical, 'canonical lockfile').packages, 'canonical lockfile.packages')
  for (const [packageKey, packageValue] of Object.entries(canonicalPackages)) {
    const packageRecord = requireRecord(packageValue, `canonical lockfile.packages.${packageKey}`)
    delete packageRecord.peerDependencies
  }

  const serialized: string = pinnedYaml.stringify(sortValue(canonical), null, 2)
  const normalizedStage = resolve(stagePrefix)
  if (serialized.includes(normalizedStage)) fail(`canonical lockfile retains staging prefix: ${normalizedStage}`)
  if (/file:\/(?!\/<WS>)/.test(serialized)) {
    fail('canonical lockfile retains an unresolved absolute file reference')
  }
  return serialized.endsWith('\n') ? serialized : `${serialized}\n`
}

const readManifest = (source: string, field: string): JsonRecord => {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (error) {
    fail(`${field} is malformed JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  return requireRecord(value, field)
}

const findTargetManifest = (
  packageName: string,
  packageManifests: ReadonlyMap<string, string>,
): { readonly path: string; readonly manifest: JsonRecord } => {
  const matches = [...packageManifests].flatMap(([path, source]) => {
    const manifest = readManifest(source, `workspace manifest ${path}`)
    return manifest.name === packageName ? [{ path, manifest }] : []
  })
  if (matches.length !== 1) fail(`expected exactly one manifest named ${packageName}, found ${matches.length}`)
  return matches[0]!
}

const replayManifest = (target: JsonRecord, importer: JsonRecord): JsonRecord => {
  const result = structuredClone(target)
  for (const field of dependencyFields) {
    const importerDependencies = importer[field]
    if (importerDependencies === undefined) {
      delete result[field]
      continue
    }
    const dependencies = requireRecord(importerDependencies, `pruned lockfile.importers...${field}`)
    result[field] = Object.fromEntries(
      Object.entries(dependencies)
        .toSorted(([left], [right]) => compareCodeUnits(left, right))
        .map(([alias, value]) => {
          const dependency = requireRecord(value, `pruned lockfile importer ${field}.${alias}`)
          if (typeof dependency.specifier !== 'string') {
            fail(`pruned lockfile importer ${field}.${alias}.specifier must be a string`)
          }
          return [alias, dependency.specifier]
        }),
    )
  }
  return sortValue(result) as JsonRecord
}

const collectFileReferences = (value: unknown, references: Set<string>): void => {
  const collect = (text: string): void => {
    const matches = text.matchAll(/file:(?:\/\/<WS>\/?)?([^()\s'"\\]+)/g)
    for (const match of matches) {
      const path = requireDefined(match[1], `file reference ${match[0]}`)
      if (path.length === 0 || path.startsWith('/')) fail(`unresolved file reference: ${match[0]}`)
      references.add(path.replace(/\/$/, ''))
    }
  }
  if (typeof value === 'string') {
    collect(value)
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectFileReferences(entry, references)
    return
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      collect(key)
      collectFileReferences(entry, references)
    }
  }
}

const canonicalJson = (value: unknown): string => `${JSON.stringify(sortValue(value), null, 2)}\n`

export const preparePnpmInstallDescriptor = (input: DescriptorInput): PreparedPnpmInstallDescriptor => {
  if (input.packageName.length === 0) fail('packageName must not be empty')
  const canonicalLockfile = canonicalizePnpmPrunedLock(input)
  const canonicalLock = parseYamlRecord(canonicalLockfile, 'canonical lockfile')
  const importers = requireRecord(canonicalLock.importers, 'canonical lockfile.importers')
  const importer = requireRecord(importers['.'], 'canonical lockfile.importers..')
  const target = findTargetManifest(input.packageName, input.packageManifests)

  const fileReferences = new Set<string>()
  collectFileReferences(canonicalLock, fileReferences)
  const relevantManifests = new Map<string, string>()
  for (const reference of [...fileReferences].toSorted(compareCodeUnits)) {
    const manifestPath = posix.join(reference, 'package.json')
    const source = requireDefined(
      input.packageManifests.get(manifestPath),
      `unresolved file reference ${reference}: missing ${manifestPath}`,
    )
    readManifest(source, `workspace manifest ${manifestPath}`)
    relevantManifests.set(manifestPath, canonicalJson(JSON.parse(source)))
  }

  const workspace = parseYamlRecord(input.workspaceManifest, 'workspace manifest')
  const configuredPatches = workspace.patchedDependencies === undefined
    ? {}
    : requireStringRecord(workspace.patchedDependencies, 'workspace manifest.patchedDependencies')
  const lockPatches = canonicalLock.patchedDependencies === undefined
    ? {}
    : requireStringRecord(canonicalLock.patchedDependencies, 'canonical lockfile.patchedDependencies')
  const patchMappings: Record<string, string> = {}
  const relevantPatches = new Map<string, string>()
  for (const packageKey of Object.keys(lockPatches).toSorted(compareCodeUnits)) {
    const patchPath = requireDefined(
      configuredPatches[packageKey],
      `unresolved patch reference for ${packageKey}`,
    )
    const source = requireDefined(
      input.patches.get(patchPath),
      `unresolved patch path ${patchPath} for ${packageKey}`,
    )
    patchMappings[packageKey] = patchPath
    relevantPatches.set(patchPath, source)
  }

  const lockSettings = canonicalLock.settings === undefined
    ? {}
    : requireRecord(canonicalLock.settings, 'canonical lockfile.settings')
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
    packageManifest: canonicalJson(replayManifest(target.manifest, importer)),
    workspaceManifest: pinnedYaml.stringify(sortValue(replayWorkspace), null, 2),
    workspacePackageManifests: relevantManifests,
    patches: relevantPatches,
  }
}

const exactKeys = (record: JsonRecord, expected: readonly string[], field: string): void => {
  const actual = Object.keys(record).toSorted(compareCodeUnits)
  const wanted = [...expected].toSorted(compareCodeUnits)
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${field} has unexpected fields`)
}

export const readPnpmInstallDescriptor = (directory: string): PnpmInstallDescriptor => {
  const source = readFileSync(resolve(directory, 'install-descriptor.json'), 'utf8')
  const value = readManifest(source, 'install-descriptor.json')
  exactKeys(value, ['files', 'installArgv', 'packageName', 'schema'], 'install descriptor')
  if (value.schema !== pnpmInstallDescriptorSchema) fail(`unsupported schema: ${String(value.schema)}`)
  if (typeof value.packageName !== 'string' || value.packageName.length === 0) fail('packageName must be a string')
  const files = requireRecord(value.files, 'install descriptor.files')
  exactKeys(files, ['lockfile', 'packageManifest', 'patches', 'workspaceManifest', 'workspacePackageManifests'], 'install descriptor.files')
  if (files.lockfile !== 'pnpm-lock.yaml' || files.packageManifest !== 'package.json' || files.workspaceManifest !== 'pnpm-workspace.yaml') {
    fail('install descriptor fixed file names do not match the schema')
  }
  for (const field of ['workspacePackageManifests', 'patches'] as const) {
    if (Array.isArray(files[field]) === false || files[field].some((entry) => typeof entry !== 'string')) {
      fail(`install descriptor.files.${field} must be a string array`)
    }
  }
  const expectedArgv = ['--dir', '<INSTALL_ROOT>', '--store-dir', '<STORE_DIR>', 'install', '--prod=false', '--ignore-scripts', '--offline', '--frozen-lockfile']
  if (Array.isArray(value.installArgv) === false || JSON.stringify(value.installArgv) !== JSON.stringify(expectedArgv)) {
    fail('installArgv does not match the frozen replay contract')
  }
  return value as PnpmInstallDescriptor
}

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

export const rehydratePnpmWorkspacePlaceholder = (lockfile: string, installRoot: string): string => {
  const replacement = `file:${resolve(installRoot)}`
  const rehydrated = lockfile.replaceAll(pnpmWorkspacePlaceholder, replacement)
  if (rehydrated.includes(pnpmWorkspacePlaceholder)) fail('lockfile retains workspace placeholder')
  return rehydrated
}
