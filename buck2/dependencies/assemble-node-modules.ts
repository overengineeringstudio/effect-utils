import {
  copyFile,
  lstat,
  link,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Schema identifier for pnpm declared-closure assembly manifests. */
export const assemblyManifestSchema = 'effect-utils/pnpm-declared-closure/v1' as const

/** Complete link graph needed to assemble one pnpm importer without a package manager. */
export interface AssemblyManifest {
  readonly schema: typeof assemblyManifestSchema
  readonly packageBins: Readonly<Record<string, string>>
  readonly packageDependencies: Readonly<Record<string, string>>
  readonly rootDependencies: Readonly<Record<string, string>>
  readonly bins: Readonly<Record<string, string>>
  readonly packageWorkspaceDependencies: Readonly<Record<string, string>>
  readonly workspacePackageDependencies: Readonly<Record<string, string>>
  readonly workspaceWorkspaceDependencies: Readonly<Record<string, string>>
  readonly workspaceBins: Readonly<Record<string, string>>
  readonly rootWorkspaceDependencies: Readonly<Record<string, string>>
}

/** Extracted package tree and its pnpm virtual-store identity. */
export interface PackageInput {
  readonly key: string
  readonly name: string
  readonly source: string
}

/** Workspace tree and the key used to address it from the manifest. */
export interface WorkspaceInput {
  readonly key: string
  readonly source: string
}

/** Inputs for assembling a relocatable node_modules closure. */
export interface AssemblyOptions {
  readonly output: string
  readonly manifest: AssemblyManifest
  readonly packages: readonly PackageInput[]
  readonly workspaces: readonly WorkspaceInput[]
}

interface SequentialOptions<TValue> {
  readonly values: readonly TValue[]
  readonly visit: (value: TValue) => Promise<void>
  readonly index?: number
}

const fail = (message: string): never => {
  throw new Error(`pnpm declared-closure assembly: ${message}`)
}

const forEachSequential = async <TValue>({
  values,
  visit,
  index = 0,
}: SequentialOptions<TValue>): Promise<void> => {
  if (index >= values.length) return
  await visit(values[index] as TValue)
  return forEachSequential({ values, visit, index: index + 1 })
}

const assertPortablePath = ({
  value,
  field,
}: {
  readonly value: string
  readonly field: string
}): string => {
  if (
    value.length === 0 ||
    value.includes('\\') === true ||
    value.includes('\0') === true ||
    isAbsolute(value) === true
  ) {
    fail(`${field} must be a non-empty portable relative path: ${JSON.stringify(value)}`)
  }
  const components = value.split('/')
  if (
    components.some((component) => component === '' || component === '.' || component === '..') ===
    true
  ) {
    fail(`${field} must be normalized: ${JSON.stringify(value)}`)
  }
  return value
}

const assertStoreKey = ({
  value,
  field,
}: {
  readonly value: string
  readonly field: string
}): string => {
  assertPortablePath({ value, field })
  if (value.includes('/') === true)
    fail(`${field} must be one virtual-store path component: ${value}`)
  return value
}

const parseRecordKey = ({
  value,
  field,
}: {
  readonly value: string
  readonly field: string
}): readonly [string, string] => {
  const separator = value.indexOf('\t')
  if (separator <= 0 || separator !== value.lastIndexOf('\t') || separator === value.length - 1) {
    fail(`${field} key must be "owner\\tdependency": ${JSON.stringify(value)}`)
  }
  return [value.slice(0, separator), value.slice(separator + 1)]
}

const parseRecordValue = ({
  value,
  field,
}: {
  readonly value: string
  readonly field: string
}): readonly [string, string] => {
  const separator = value.indexOf('\t')
  if (separator <= 0 || separator !== value.lastIndexOf('\t') || separator === value.length - 1) {
    fail(`${field} value must be "owner\\tpath": ${JSON.stringify(value)}`)
  }
  return [value.slice(0, separator), value.slice(separator + 1)]
}

const isInside = ({
  root,
  candidate,
}: {
  readonly root: string
  readonly candidate: string
}): boolean => {
  const fromRoot = relative(root, candidate)
  return (
    fromRoot === '' ||
    (fromRoot.startsWith(`..${sep}`) === false &&
      fromRoot !== '..' &&
      isAbsolute(fromRoot) === false)
  )
}

const resolveLexicalLink = ({
  linkPath,
  target,
  root,
}: {
  readonly linkPath: string
  readonly target: string
  readonly root: string
}): string => {
  if (isAbsolute(target) === true)
    fail(`source symlink has an absolute target: ${linkPath} -> ${target}`)
  const destination = resolve(dirname(linkPath), target)
  if (isInside({ root, candidate: destination }) === false)
    fail(`source symlink target escapes its declared tree: ${linkPath} -> ${target}`)
  return destination
}

const materializeTree = async ({
  source,
  destination,
}: {
  readonly source: string
  readonly destination: string
}): Promise<void> => {
  const sourceRoot = await realpath(source)
  if ((await lstat(sourceRoot)).isDirectory() === false)
    fail(`source tree is not a directory: ${source}`)

  const visit = async ({
    currentSource,
    currentDestination,
  }: {
    readonly currentSource: string
    readonly currentDestination: string
  }): Promise<void> => {
    const metadata = await lstat(currentSource)
    if (metadata.isDirectory() === true) {
      await mkdir(currentDestination, { recursive: true })
      const entries = await readdir(currentSource)
      entries.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
      await forEachSequential({
        values: entries,
        visit: async (entry) =>
          visit({
            currentSource: join(currentSource, entry),
            currentDestination: join(currentDestination, entry),
          }),
      })
      return
    }
    await mkdir(dirname(currentDestination), { recursive: true })
    if (metadata.isFile() === true) {
      try {
        await link(currentSource, currentDestination)
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EXDEV') throw error
        await copyFile(currentSource, currentDestination)
      }
      return
    }
    if (metadata.isSymbolicLink() === true) {
      const target = await readlink(currentSource)
      resolveLexicalLink({ linkPath: currentSource, target, root: sourceRoot })
      const resolvedTarget = await realpath(currentSource)
      if (isInside({ root: sourceRoot, candidate: resolvedTarget }) === false) {
        fail(`source symlink resolves outside its declared tree: ${currentSource} -> ${target}`)
      }
      await symlink(target, currentDestination)
      return
    }
    fail(`source tree contains an unsupported entry: ${currentSource}`)
  }

  await visit({ currentSource: sourceRoot, currentDestination: destination })
}

const addRelativeLink = async ({
  linkPath,
  targetPath,
  root,
}: {
  readonly linkPath: string
  readonly targetPath: string
  readonly root: string
}): Promise<void> => {
  const absoluteLink = resolve(linkPath)
  const absoluteTarget = resolve(targetPath)
  if (
    isInside({ root, candidate: absoluteLink }) === false ||
    isInside({ root, candidate: absoluteTarget }) === false
  ) {
    fail(`internal link escapes assembled tree: ${linkPath} -> ${targetPath}`)
  }
  const target = relative(dirname(absoluteLink), absoluteTarget)
  if (target.length === 0 || isAbsolute(target) === true)
    fail(`could not form relative link: ${linkPath} -> ${targetPath}`)
  await mkdir(dirname(absoluteLink), { recursive: true })
  await symlink(target, absoluteLink)
}

const packageNodeModulesPath = ({
  root,
  key,
}: {
  readonly root: string
  readonly key: string
}): string =>
  join(root, '.pnpm', assertStoreKey({ value: key, field: 'package key' }), 'node_modules')

const packagePath = ({
  root,
  key,
  name,
}: {
  readonly root: string
  readonly key: string
  readonly name: string
}): string =>
  join(
    packageNodeModulesPath({ root, key }),
    assertPortablePath({ value: name, field: 'package name' }),
  )

const workspacePath = ({ root, key }: { readonly root: string; readonly key: string }): string =>
  join(root, '.workspace', assertStoreKey({ value: key, field: 'workspace key' }))

const requirePackage = ({
  packages,
  key,
  field,
}: {
  readonly packages: ReadonlyMap<string, PackageInput>
  readonly key: string
  readonly field: string
}): PackageInput =>
  packages.get(key) ?? fail(`${field} names unavailable package ${JSON.stringify(key)}`)

const requireWorkspace = ({
  workspaces,
  key,
  field,
}: {
  readonly workspaces: ReadonlyMap<string, WorkspaceInput>
  readonly key: string
  readonly field: string
}): WorkspaceInput =>
  workspaces.get(key) ?? fail(`${field} names unavailable workspace ${JSON.stringify(key)}`)

const assertManifest = (value: unknown): AssemblyManifest => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) === true)
    fail('manifest must be an object')
  const record = value as Record<string, unknown>
  if (record.schema !== assemblyManifestSchema)
    fail(`manifest schema must be ${assemblyManifestSchema}`)
  const fields = [
    'packageBins',
    'packageDependencies',
    'rootDependencies',
    'bins',
    'packageWorkspaceDependencies',
    'workspacePackageDependencies',
    'workspaceBins',
    'workspaceWorkspaceDependencies',
    'rootWorkspaceDependencies',
  ] as const
  for (const field of fields) {
    const candidate = record[field]
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate) === true) {
      fail(`manifest ${field} must be an object`)
    }
    for (const [key, entry] of Object.entries(candidate)) {
      if (typeof entry !== 'string')
        fail(`manifest ${field}[${JSON.stringify(key)}] must be a string`)
    }
  }
  return record as unknown as AssemblyManifest
}

/**
 * Materializes one importer from declared package and workspace trees.
 *
 * Writes to a staging directory and renames only after every relative link is complete.
 */
export const assembleNodeModules = async (options: AssemblyOptions): Promise<void> => {
  const output = resolve(options.output)
  const stage = `${output}.stage-${process.pid}-${crypto.randomUUID()}`
  const packages = new Map<string, PackageInput>()
  const workspaces = new Map<string, WorkspaceInput>()
  try {
    await mkdir(stage, { recursive: false })

    for (const entry of options.packages) {
      assertStoreKey({ value: entry.key, field: 'package key' })
      assertPortablePath({ value: entry.name, field: 'package name' })
      if (packages.has(entry.key) === true) fail(`duplicate package key ${entry.key}`)
      packages.set(entry.key, entry)
    }
    for (const entry of options.workspaces) {
      assertStoreKey({ value: entry.key, field: 'workspace key' })
      if (workspaces.has(entry.key) === true) fail(`duplicate workspace key ${entry.key}`)
      workspaces.set(entry.key, entry)
    }

    await forEachSequential({
      values: options.packages,
      visit: async (entry) =>
        materializeTree({
          source: entry.source,
          destination: packagePath({ root: stage, key: entry.key, name: entry.name }),
        }),
    })
    await forEachSequential({
      values: options.workspaces,
      visit: async (entry) =>
        materializeTree({
          source: entry.source,
          destination: workspacePath({ root: stage, key: entry.key }),
        }),
    })

    await forEachSequential({
      values: Object.entries(options.manifest.packageDependencies),
      visit: async ([recordKey, targetKey]) => {
        const [sourceKey, rawDependencyName] = parseRecordKey({
          value: recordKey,
          field: 'packageDependencies',
        })
        const dependencyName = assertPortablePath({
          value: rawDependencyName,
          field: 'package dependency',
        })
        const source = requirePackage({
          packages,
          key: sourceKey,
          field: 'packageDependencies',
        })
        const target = requirePackage({
          packages,
          key: targetKey,
          field: 'packageDependencies',
        })
        await addRelativeLink({
          linkPath: join(packageNodeModulesPath({ root: stage, key: source.key }), dependencyName),
          targetPath: packagePath({ root: stage, key: target.key, name: target.name }),
          root: stage,
        })
      },
    })
    await forEachSequential({
      values: Object.entries(options.manifest.packageBins),
      visit: async ([recordKey, value]) => {
        const [sourceKey, rawBinName] = parseRecordKey({
          value: recordKey,
          field: 'packageBins',
        })
        const binName = assertPortablePath({
          value: rawBinName,
          field: 'package bin name',
        })
        const [targetKey, rawExecutable] = parseRecordValue({
          value,
          field: 'packageBins',
        })
        const source = requirePackage({ packages, key: sourceKey, field: 'packageBins' })
        const target = requirePackage({ packages, key: targetKey, field: 'packageBins' })
        const executable = assertPortablePath({
          value: rawExecutable,
          field: 'package bin executable',
        })
        await addRelativeLink({
          linkPath: join(packageNodeModulesPath({ root: stage, key: source.key }), '.bin', binName),
          targetPath: join(
            packagePath({ root: stage, key: target.key, name: target.name }),
            executable,
          ),
          root: stage,
        })
      },
    })
    await forEachSequential({
      values: Object.entries(options.manifest.rootDependencies),
      visit: async ([dependencyName, targetKey]) => {
        const target = requirePackage({ packages, key: targetKey, field: 'rootDependencies' })
        await addRelativeLink({
          linkPath: join(
            stage,
            assertPortablePath({ value: dependencyName, field: 'root dependency' }),
          ),
          targetPath: packagePath({ root: stage, key: target.key, name: target.name }),
          root: stage,
        })
      },
    })
    await forEachSequential({
      values: Object.entries(options.manifest.bins),
      visit: async ([binName, value]) => {
        const [targetKey, executable] = parseRecordValue({ value, field: 'bins' })
        const target = requirePackage({ packages, key: targetKey, field: 'bins' })
        await addRelativeLink({
          linkPath: join(stage, '.bin', assertPortablePath({ value: binName, field: 'bin name' })),
          targetPath: join(
            packagePath({ root: stage, key: target.key, name: target.name }),
            assertPortablePath({ value: executable, field: 'bin executable' }),
          ),
          root: stage,
        })
      },
    })
    await forEachSequential({
      values: Object.entries(options.manifest.packageWorkspaceDependencies),
      visit: async ([recordKey, targetKey]) => {
        const [sourceKey, rawDependencyName] = parseRecordKey({
          value: recordKey,
          field: 'packageWorkspaceDependencies',
        })
        const dependencyName = assertPortablePath({
          value: rawDependencyName,
          field: 'package workspace dependency',
        })
        const source = requirePackage({
          packages,
          key: sourceKey,
          field: 'packageWorkspaceDependencies',
        })
        const target = requireWorkspace({
          workspaces,
          key: targetKey,
          field: 'packageWorkspaceDependencies',
        })
        await addRelativeLink({
          linkPath: join(packageNodeModulesPath({ root: stage, key: source.key }), dependencyName),
          targetPath: workspacePath({ root: stage, key: target.key }),
          root: stage,
        })
      },
    })
    await forEachSequential({
      values: Object.entries(options.manifest.workspacePackageDependencies),
      visit: async ([recordKey, targetKey]) => {
        const [sourceKey, rawDependencyName] = parseRecordKey({
          value: recordKey,
          field: 'workspacePackageDependencies',
        })
        const dependencyName = assertPortablePath({
          value: rawDependencyName,
          field: 'workspace package dependency',
        })
        const source = requireWorkspace({
          workspaces,
          key: sourceKey,
          field: 'workspacePackageDependencies',
        })
        const target = requirePackage({
          packages,
          key: targetKey,
          field: 'workspacePackageDependencies',
        })
        await addRelativeLink({
          linkPath: join(
            workspacePath({ root: stage, key: source.key }),
            'node_modules',
            dependencyName,
          ),
          targetPath: packagePath({ root: stage, key: target.key, name: target.name }),
          root: stage,
        })
      },
    })
    await forEachSequential({
      values: Object.entries(options.manifest.workspaceWorkspaceDependencies),
      visit: async ([recordKey, targetKey]) => {
        const [sourceKey, rawDependencyName] = parseRecordKey({
          value: recordKey,
          field: 'workspaceWorkspaceDependencies',
        })
        const dependencyName = assertPortablePath({
          value: rawDependencyName,
          field: 'workspace dependency',
        })
        const source = requireWorkspace({
          workspaces,
          key: sourceKey,
          field: 'workspaceWorkspaceDependencies',
        })
        const target = requireWorkspace({
          workspaces,
          key: targetKey,
          field: 'workspaceWorkspaceDependencies',
        })
        await addRelativeLink({
          linkPath: join(
            workspacePath({ root: stage, key: source.key }),
            'node_modules',
            dependencyName,
          ),
          targetPath: workspacePath({ root: stage, key: target.key }),
          root: stage,
        })
      },
    })
    await forEachSequential({
      values: Object.entries(options.manifest.workspaceBins),
      visit: async ([recordKey, value]) => {
        const [sourceKey, rawBinName] = parseRecordKey({
          value: recordKey,
          field: 'workspaceBins',
        })
        const binName = assertPortablePath({
          value: rawBinName,
          field: 'workspace bin name',
        })
        const [targetKey, rawExecutable] = parseRecordValue({
          value,
          field: 'workspaceBins',
        })
        const source = requireWorkspace({ workspaces, key: sourceKey, field: 'workspaceBins' })
        const target = requirePackage({ packages, key: targetKey, field: 'workspaceBins' })
        const executable = assertPortablePath({
          value: rawExecutable,
          field: 'workspace bin executable',
        })
        await addRelativeLink({
          linkPath: join(
            workspacePath({ root: stage, key: source.key }),
            'node_modules',
            '.bin',
            binName,
          ),
          targetPath: join(
            packagePath({ root: stage, key: target.key, name: target.name }),
            executable,
          ),
          root: stage,
        })
      },
    })
    await forEachSequential({
      values: Object.entries(options.manifest.rootWorkspaceDependencies),
      visit: async ([dependencyName, targetKey]) => {
        const target = requireWorkspace({
          workspaces,
          key: targetKey,
          field: 'rootWorkspaceDependencies',
        })
        await addRelativeLink({
          linkPath: join(
            stage,
            assertPortablePath({
              value: dependencyName,
              field: 'root workspace dependency',
            }),
          ),
          targetPath: workspacePath({ root: stage, key: target.key }),
          root: stage,
        })
      },
    })
    await rename(stage, output)
  } catch (error) {
    await rm(stage, { recursive: true, force: true })
    throw error
  }
}

interface ParsedCli {
  readonly output: string
  readonly manifest: string
  readonly packages: readonly PackageInput[]
  readonly workspaces: readonly WorkspaceInput[]
}

const parseCli = (args: readonly string[]): ParsedCli => {
  let output: string | undefined
  let manifest: string | undefined
  const packages: PackageInput[] = []
  const workspaces: WorkspaceInput[] = []
  for (let index = 0; index < args.length; ) {
    const argument = args[index]
    if (argument === '--output') {
      output = args[index + 1] ?? fail('--output requires one path')
      index += 2
    } else if (argument === '--manifest') {
      manifest = args[index + 1] ?? fail('--manifest requires one path')
      index += 2
    } else if (argument === '--package') {
      const key = args[index + 1] ?? fail('--package requires KEY NAME SOURCE')
      const name = args[index + 2] ?? fail('--package requires KEY NAME SOURCE')
      const source = args[index + 3] ?? fail('--package requires KEY NAME SOURCE')
      packages.push({ key, name, source })
      index += 4
    } else if (argument === '--workspace') {
      const key = args[index + 1] ?? fail('--workspace requires KEY SOURCE')
      const source = args[index + 2] ?? fail('--workspace requires KEY SOURCE')
      workspaces.push({ key, source })
      index += 3
    } else {
      fail(`unknown argument ${JSON.stringify(argument)}`)
    }
  }
  return {
    output: output ?? fail('missing --output'),
    manifest: manifest ?? fail('missing --manifest'),
    packages,
    workspaces,
  }
}

/** Parses Buck action arguments and assembles the declared closure. */
export const runAssemblyCli = async (args: readonly string[]): Promise<void> => {
  const parsed = parseCli(args)
  const manifest = assertManifest(JSON.parse(await readFile(parsed.manifest, 'utf8')))
  await assembleNodeModules({
    output: parsed.output,
    manifest,
    packages: parsed.packages,
    workspaces: parsed.workspaces,
  })
}

if (import.meta.main === true) {
  try {
    await runAssemblyCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
