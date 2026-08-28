#!/usr/bin/env -S bun
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

type PruneOptions = {
  readonly output: string
  readonly packageName: string
  readonly pnpm: string
  readonly storeDir: string
  readonly rootPackageJson: string
  readonly lockfile: string
  readonly workspaceManifest: string
  readonly packageManifests: ReadonlyMap<string, string>
  readonly patches: ReadonlyMap<string, string>
}

type MaterializeOptions = {
  readonly output: string
  readonly descriptor: string
  readonly pnpm: string
  readonly storeDir: string
}

type AssembleOptions = {
  readonly output: string
  readonly nodeModules: string
  readonly files: ReadonlyMap<string, string>
  readonly workspaceFiles: ReadonlyMap<string, string>
  readonly workspaceLinks: ReadonlyMap<string, string>
}

const invalidArguments = (message: string): never => {
  throw new Error(`buck2 materializer: ${message}`)
}

const requireValue = ({
  args,
  index,
  flag,
}: {
  readonly args: readonly string[]
  readonly index: number
  readonly flag: string
}): string => args[index] ?? invalidArguments(`missing value for ${flag}`)

const requireOption = ({
  value,
  option,
}: {
  readonly value: string | undefined
  readonly option: string
}): string => value ?? invalidArguments(`missing required option ${option}`)

const requireRelativePath = ({
  value,
  field,
}: {
  readonly value: string
  readonly field: string
}): string => {
  if (
    value.length === 0 ||
    isAbsolute(value) === true ||
    value.includes('\\') === true ||
    value
      .split('/')
      .some((component) => component === '' || component === '.' || component === '..') === true
  ) {
    invalidArguments(`${field} must be a normalized portable relative path: ${value}`)
  }
  return value
}

const setUnique = ({
  values,
  key,
  value,
  field,
}: {
  readonly values: Map<string, string>
  readonly key: string
  readonly value: string
  readonly field: string
}): void => {
  if (values.has(key) === true) invalidArguments(`duplicate ${field}: ${key}`)
  values.set(key, value)
}

const parsePruneOptions = (args: readonly string[]): PruneOptions => {
  let output: string | undefined
  let packageName: string | undefined
  let pnpm: string | undefined
  let storeDir: string | undefined
  let rootPackageJson: string | undefined
  let lockfile: string | undefined
  let workspaceManifest: string | undefined
  const packageManifests = new Map<string, string>()
  const patches = new Map<string, string>()

  for (let index = 0; index < args.length; ) {
    const flag = requireValue({ args, index, flag: 'argument' })
    if (flag === '--package-manifest' || flag === '--patch') {
      const destination = requireRelativePath({
        value: requireValue({ args, index: index + 1, flag }),
        field: `${flag} destination`,
      })
      const source = requireValue({ args, index: index + 2, flag })
      setUnique({
        values: flag === '--package-manifest' ? packageManifests : patches,
        key: destination,
        value: source,
        field: flag,
      })
      index += 3
      continue
    }
    const value = requireValue({ args, index: index + 1, flag })
    if (flag === '--output' && output === undefined) output = value
    else if (flag === '--package-name' && packageName === undefined) packageName = value
    else if (flag === '--pnpm' && pnpm === undefined) pnpm = value
    else if (flag === '--store-dir' && storeDir === undefined) storeDir = value
    else if (flag === '--root-package-json' && rootPackageJson === undefined)
      rootPackageJson = value
    else if (flag === '--lockfile' && lockfile === undefined) lockfile = value
    else if (flag === '--workspace-manifest' && workspaceManifest === undefined)
      workspaceManifest = value
    else invalidArguments(`unexpected argument: ${flag}`)
    index += 2
  }

  if (
    output === undefined ||
    packageName === undefined ||
    pnpm === undefined ||
    storeDir === undefined ||
    rootPackageJson === undefined ||
    lockfile === undefined ||
    workspaceManifest === undefined
  )
    invalidArguments('prune-node-modules is missing a required option')
  if (packageManifests.size === 0) invalidArguments('no workspace package manifests were declared')
  return {
    output: requireOption({ value: output, option: '--output' }),
    packageName: requireOption({ value: packageName, option: '--package-name' }),
    pnpm: requireOption({ value: pnpm, option: '--pnpm' }),
    storeDir: requireOption({ value: storeDir, option: '--store-dir' }),
    rootPackageJson: requireOption({ value: rootPackageJson, option: '--root-package-json' }),
    lockfile: requireOption({ value: lockfile, option: '--lockfile' }),
    workspaceManifest: requireOption({ value: workspaceManifest, option: '--workspace-manifest' }),
    packageManifests,
    patches,
  }
}

const parseMaterializeOptions = (args: readonly string[]): MaterializeOptions => {
  let output: string | undefined
  let descriptor: string | undefined
  let pnpm: string | undefined
  let storeDir: string | undefined
  for (let index = 0; index < args.length; index += 2) {
    const flag = requireValue({ args, index, flag: 'argument' })
    const value = requireValue({ args, index: index + 1, flag })
    if (flag === '--output' && output === undefined) output = value
    else if (flag === '--descriptor' && descriptor === undefined) descriptor = value
    else if (flag === '--pnpm' && pnpm === undefined) pnpm = value
    else if (flag === '--store-dir' && storeDir === undefined) storeDir = value
    else invalidArguments(`unexpected argument: ${flag}`)
  }
  if (
    output === undefined ||
    descriptor === undefined ||
    pnpm === undefined ||
    storeDir === undefined
  ) {
    invalidArguments('materialize-node-modules is missing a required option')
  }
  return {
    output: requireOption({ value: output, option: '--output' }),
    descriptor: requireOption({ value: descriptor, option: '--descriptor' }),
    pnpm: requireOption({ value: pnpm, option: '--pnpm' }),
    storeDir: requireOption({ value: storeDir, option: '--store-dir' }),
  }
}

const parseAssembleOptions = (args: readonly string[]): AssembleOptions => {
  let output: string | undefined
  let nodeModules: string | undefined
  const files = new Map<string, string>()
  const workspaceFiles = new Map<string, string>()
  const workspaceLinks = new Map<string, string>()

  for (let index = 0; index < args.length; ) {
    const flag = requireValue({ args, index, flag: 'argument' })
    if (flag === '--file' || flag === '--workspace-file' || flag === '--workspace-link') {
      const destination = requireRelativePath({
        value: requireValue({ args, index: index + 1, flag }),
        field: `${flag} destination`,
      })
      const value = requireValue({ args, index: index + 2, flag })
      if (flag === '--workspace-link') requireRelativePath({ value, field: `${flag} target` })
      const values =
        flag === '--file' ? files : flag === '--workspace-file' ? workspaceFiles : workspaceLinks
      setUnique({ values, key: destination, value, field: flag })
      index += 3
      continue
    }
    const value = requireValue({ args, index: index + 1, flag })
    if (flag === '--output' && output === undefined) output = value
    else if (flag === '--node-modules' && nodeModules === undefined) nodeModules = value
    else invalidArguments(`unexpected argument: ${flag}`)
    index += 2
  }
  if (output === undefined || nodeModules === undefined) {
    invalidArguments('assemble-package-tree is missing a required option')
  }
  return {
    output: requireOption({ value: output, option: '--output' }),
    nodeModules: requireOption({ value: nodeModules, option: '--node-modules' }),
    files,
    workspaceFiles,
    workspaceLinks,
  }
}

const copyFileTo = ({
  source,
  destination,
  writable,
}: {
  readonly source: string
  readonly destination: string
  readonly writable: boolean
}): void => {
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  if (writable === true) chmodSync(destination, 0o644)
}

const pathIsInside = ({
  root,
  candidate,
}: {
  readonly root: string
  readonly candidate: string
}): boolean => {
  const fromRoot = relative(root, candidate)
  return (
    fromRoot === '' ||
    (isAbsolute(fromRoot) === false &&
      fromRoot !== '..' &&
      fromRoot.startsWith(`..${sep}`) === false)
  )
}

const assertContainedSymlinks = (root: string): void => {
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    )) {
      const path = join(directory, entry.name)
      if (entry.isDirectory() === true) {
        visit(path)
        continue
      }
      if (entry.isSymbolicLink() === false) continue

      const target = readlinkSync(path)
      const displayPath = relative(root, path).split(sep).join('/')
      if (isAbsolute(target) === true) {
        throw new Error(
          `buck2 materializer: unsafe symlink ${displayPath}: absolute target ${target}`,
        )
      }
      const lexicalDestination = resolve(dirname(path), target)
      if (pathIsInside({ root, candidate: lexicalDestination }) === false) {
        throw new Error(`buck2 materializer: unsafe symlink ${displayPath}: target escapes tree`)
      }

      let resolvedDestination: string
      try {
        resolvedDestination = realpathSync(path)
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP')
        ) {
          throw new Error(`buck2 materializer: unsafe symlink ${displayPath}: target is dangling`, {
            cause: error,
          })
        }
        throw error
      }
      if (pathIsInside({ root, candidate: resolvedDestination }) === false) {
        throw new Error(
          `buck2 materializer: unsafe symlink ${displayPath}: chained target resolves outside tree`,
        )
      }
    }
  }

  visit(root)
}

const hardlinkTree = ({
  source,
  destination,
}: {
  readonly source: string
  readonly destination: string
}): void => {
  const metadata = lstatSync(source)
  if (metadata.isDirectory() === true) {
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(source).toSorted()) {
      hardlinkTree({ source: join(source, entry), destination: join(destination, entry) })
    }
    return
  }
  mkdirSync(dirname(destination), { recursive: true })
  if (metadata.isSymbolicLink() === true) {
    symlinkSync(readlinkSync(source), destination)
  } else if (metadata.isFile() === true) {
    linkSync(source, destination)
  } else {
    throw new Error(`buck2 materializer: unsupported filesystem entry: ${source}`)
  }
}

const runPnpm = ({
  pnpm,
  args,
}: {
  readonly pnpm: string
  readonly args: readonly string[]
}): void => {
  const result = Bun.spawnSync([pnpm, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) {
    throw new Error(`buck2 materializer: pnpm exited with status ${result.exitCode}`)
  }
}

const requireWarmStore = ({
  storeDir,
  outputParent,
}: {
  readonly storeDir: string
  readonly outputParent: string
}): void => {
  if (existsSync(storeDir) === false) {
    throw new Error(`buck2 materializer: pnpm store is not warm: ${storeDir}`)
  }
  if (statSync(storeDir).dev !== statSync(outputParent).dev) {
    throw new Error(
      `buck2 materializer: pnpm store and Buck output are on different filesystems: ${storeDir} vs ${outputParent}`,
    )
  }
}

const requirePinnedPnpm = (pnpm: string): void => {
  if (pnpm.startsWith('/nix/store/') === false) {
    invalidArguments(`--pnpm must be an immutable /nix/store executable: ${pnpm}`)
  }
}

const writePreparedDescriptor = ({
  output,
  prepared,
}: {
  readonly output: string
  readonly prepared: unknown
}): void => {
  if (prepared === null || typeof prepared !== 'object') {
    throw new Error('buck2 materializer: descriptor preparer returned a non-object')
  }
  const descriptor = Reflect.get(prepared, 'descriptor')
  const lockfile = Reflect.get(prepared, 'lockfile')
  const packageManifest = Reflect.get(prepared, 'packageManifest')
  const workspaceManifest = Reflect.get(prepared, 'workspaceManifest')
  const workspacePackageManifests = Reflect.get(prepared, 'workspacePackageManifests')
  const patches = Reflect.get(prepared, 'patches')
  if (
    descriptor === null ||
    typeof descriptor !== 'object' ||
    typeof lockfile !== 'string' ||
    typeof packageManifest !== 'string' ||
    typeof workspaceManifest !== 'string' ||
    workspacePackageManifests instanceof Map === false ||
    patches instanceof Map === false
  ) {
    throw new Error('buck2 materializer: descriptor preparer returned an invalid result')
  }
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'install-descriptor.json'), `${JSON.stringify(descriptor, null, 2)}\n`)
  writeFileSync(join(output, 'pnpm-lock.yaml'), lockfile)
  writeFileSync(join(output, 'package.json'), packageManifest)
  writeFileSync(join(output, 'pnpm-workspace.yaml'), workspaceManifest)
  for (const [destination, content] of workspacePackageManifests) {
    if (typeof destination !== 'string' || typeof content !== 'string') {
      throw new Error(
        'buck2 materializer: relevant workspace manifests must map strings to strings',
      )
    }
    const path = destinationInside({ root: output, relativePath: destination })
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  for (const [destination, content] of patches) {
    if (typeof destination !== 'string' || typeof content !== 'string') {
      throw new Error('buck2 materializer: relevant patches must map strings to strings')
    }
    const path = destinationInside({ root: output, relativePath: destination })
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}

const pruneNodeModules = async (options: PruneOptions): Promise<void> => {
  if (options.packageName.length === 0) invalidArguments('--package-name must not be empty')
  requirePinnedPnpm(options.pnpm)
  const output = resolve(options.output)
  const stage = `${output}.stage`
  const deploy = join(stage, '.deploy')
  const pendingOutput = `${output}.pending`
  const storeDir = resolve(options.storeDir)
  requireWarmStore({ storeDir, outputParent: dirname(output) })

  rmSync(stage, { recursive: true, force: true })
  rmSync(pendingOutput, { recursive: true, force: true })
  rmSync(output, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  try {
    copyFileTo({
      source: options.rootPackageJson,
      destination: join(stage, 'package.json'),
      writable: true,
    })
    copyFileTo({
      source: options.lockfile,
      destination: join(stage, 'pnpm-lock.yaml'),
      writable: false,
    })
    copyFileTo({
      source: options.workspaceManifest,
      destination: join(stage, 'pnpm-workspace.yaml'),
      writable: false,
    })
    for (const [destination, source] of options.packageManifests) {
      copyFileTo({ source, destination: join(stage, destination), writable: true })
    }
    for (const [destination, source] of options.patches) {
      copyFileTo({ source, destination: join(stage, destination), writable: false })
    }

    runPnpm({
      pnpm: options.pnpm,
      args: [
        '--dir',
        stage,
        '--store-dir',
        storeDir,
        'deploy',
        '--filter',
        options.packageName,
        '--prod=false',
        '--ignore-scripts',
        '--offline',
        '--frozen-lockfile',
        deploy,
      ],
    })
    const rawLockfile = readFileSync(join(deploy, 'node_modules', '.pnpm', 'lock.yaml'), 'utf8')
    const { preparePnpmInstallDescriptor } = await import('./pnpm-install-descriptor.ts')
    const prepared: unknown = preparePnpmInstallDescriptor({
      rawLockfile,
      stagePrefix: stage,
      packageName: options.packageName,
      workspaceManifest: readFileSync(options.workspaceManifest, 'utf8'),
      packageManifests: new Map(
        [...options.packageManifests].map(([destination, source]) => [
          destination,
          readFileSync(source, 'utf8'),
        ]),
      ),
      patches: new Map(
        [...options.patches].map(([destination, source]) => [
          destination,
          readFileSync(source, 'utf8'),
        ]),
      ),
    })
    writePreparedDescriptor({ output: pendingOutput, prepared })
    renameSync(pendingOutput, output)
  } catch (error) {
    rmSync(output, { recursive: true, force: true })
    rmSync(pendingOutput, { recursive: true, force: true })
    throw error
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

const copyTree = ({
  source,
  destination,
}: {
  readonly source: string
  readonly destination: string
}): void => {
  const metadata = lstatSync(source)
  if (metadata.isDirectory() === true) {
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(source).toSorted())
      copyTree({ source: join(source, entry), destination: join(destination, entry) })
    return
  }
  if (metadata.isFile() === false) {
    throw new Error(
      `buck2 materializer: descriptor contains unsupported filesystem entry: ${source}`,
    )
  }
  copyFileTo({ source, destination, writable: true })
}

const materializeNodeModules = async (options: MaterializeOptions): Promise<void> => {
  requirePinnedPnpm(options.pnpm)
  const output = resolve(options.output)
  const stageRoot = `${output}.stage`
  const installRoot = join(stageRoot, 'package')
  const storeDir = resolve(options.storeDir)
  requireWarmStore({ storeDir, outputParent: dirname(output) })

  rmSync(stageRoot, { recursive: true, force: true })
  rmSync(output, { recursive: true, force: true })
  mkdirSync(installRoot, { recursive: true })
  try {
    copyTree({ source: resolve(options.descriptor), destination: installRoot })
    const [descriptorModule, normalizerModule] = await Promise.all([
      import('./pnpm-install-descriptor.ts'),
      import('./pnpm-deploy-normalizer.ts'),
    ])
    const descriptor = descriptorModule.readPnpmInstallDescriptor(installRoot)
    for (const file of [descriptor.files.lockfile, descriptor.files.packageManifest]) {
      const filePath = join(installRoot, file)
      const rehydrated: unknown = descriptorModule.rehydratePnpmWorkspaceReferences({
        source: readFileSync(filePath, 'utf8'),
      })
      if (typeof rehydrated !== 'string') {
        throw new Error('buck2 materializer: workspace rehydrator returned a non-string')
      }
      writeFileSync(filePath, rehydrated)
    }
    for (const file of descriptor.files.workspacePackageManifests) {
      const source = join(installRoot, file)
      const destination = join(stageRoot, file)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileTo({ source, destination, writable: true })
    }
    const installArgv: unknown = descriptorModule.resolvePnpmInstallArgv({
      descriptor,
      installRoot,
      storeDir,
    })
    if (
      Array.isArray(installArgv) === false ||
      installArgv.some((entry) => typeof entry !== 'string') === true
    ) {
      throw new Error('buck2 materializer: descriptor resolved a non-string pnpm argv')
    }
    runPnpm({ pnpm: options.pnpm, args: installArgv })
    rmSync(join(stageRoot, 'packages'), { recursive: true, force: true })

    normalizerModule.normalizePnpmDeploy({
      tree: installRoot,
      stagePrefix: installRoot,
      forbiddenPrefixes: [
        storeDir,
        realpathSync(storeDir),
        output,
        resolve(process.cwd()),
        realpathSync(process.cwd()),
      ],
    })
    renameSync(join(installRoot, 'node_modules'), output)
    assertContainedSymlinks(output)
  } catch (error) {
    rmSync(output, { recursive: true, force: true })
    throw error
  } finally {
    rmSync(stageRoot, { recursive: true, force: true })
  }
}

const destinationInside = ({
  root,
  relativePath,
}: {
  readonly root: string
  readonly relativePath: string
}): string => {
  const destination = resolve(
    root,
    requireRelativePath({ value: relativePath, field: 'destination' }),
  )
  const fromRoot = relative(root, destination)
  if (fromRoot === '' || fromRoot.startsWith(`..${sep}`) === true || fromRoot === '..') {
    invalidArguments(`destination escapes package tree: ${relativePath}`)
  }
  return destination
}

const assemblePackageTree = (options: AssembleOptions): void => {
  const output = resolve(options.output)
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  try {
    hardlinkTree({ source: options.nodeModules, destination: join(output, 'node_modules') })
    for (const [destination, source] of [...options.files, ...options.workspaceFiles]) {
      hardlinkTree({
        source,
        destination: destinationInside({ root: output, relativePath: destination }),
      })
    }
    for (const [linkPath, targetPath] of options.workspaceLinks) {
      const link = destinationInside({ root: output, relativePath: linkPath })
      const target = destinationInside({ root: output, relativePath: targetPath })
      rmSync(link, { recursive: true, force: true })
      mkdirSync(dirname(link), { recursive: true })
      const relativeTarget = relative(dirname(link), target)
      if (isAbsolute(relativeTarget) === true) {
        invalidArguments(
          `workspace link target cannot be represented as a relative path: ${targetPath}`,
        )
      }
      symlinkSync(relativeTarget, link)
      statSync(link)
    }
    assertContainedSymlinks(output)
  } catch (error) {
    rmSync(output, { recursive: true, force: true })
    throw error
  }
}

/** Runs the Buck2 pnpm materialization command-line interface. */
export const runBuck2MaterializerCli = async (args: readonly string[]): Promise<void> => {
  const [command, ...commandArgs] = args
  if (command === 'prune-node-modules') {
    await pruneNodeModules(parsePruneOptions(commandArgs))
  } else if (command === 'materialize-node-modules') {
    await materializeNodeModules(parseMaterializeOptions(commandArgs))
  } else if (command === 'assemble-package-tree') {
    assemblePackageTree(parseAssembleOptions(commandArgs))
  } else {
    invalidArguments(
      `expected materialize-node-modules or assemble-package-tree, got ${String(command)}`,
    )
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runBuck2MaterializerCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
