#!/usr/bin/env -S bun
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

type MaterializeOptions = {
  readonly output: string
  readonly packageName: string
  readonly pnpm: string
  readonly normalizer: string
  readonly storeDir: string
  readonly rootPackageJson: string
  readonly lockfile: string
  readonly workspaceManifest: string
  readonly packageManifests: ReadonlyMap<string, string>
  readonly patches: ReadonlyMap<string, string>
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

const requireValue = (args: readonly string[], index: number, flag: string): string =>
  args[index] ?? invalidArguments(`missing value for ${flag}`)

const requireRelativePath = (value: string, field: string): string => {
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some((component) => component === '' || component === '.' || component === '..')
  ) {
    invalidArguments(`${field} must be a normalized portable relative path: ${value}`)
  }
  return value
}

const setUnique = (values: Map<string, string>, key: string, value: string, field: string): void => {
  if (values.has(key)) invalidArguments(`duplicate ${field}: ${key}`)
  values.set(key, value)
}

const parseMaterializeOptions = (args: readonly string[]): MaterializeOptions => {
  let output: string | undefined
  let packageName: string | undefined
  let pnpm: string | undefined
  let normalizer: string | undefined
  let storeDir: string | undefined
  let rootPackageJson: string | undefined
  let lockfile: string | undefined
  let workspaceManifest: string | undefined
  const packageManifests = new Map<string, string>()
  const patches = new Map<string, string>()

  for (let index = 0; index < args.length; ) {
    const flag = requireValue(args, index, 'argument')
    if (flag === '--package-manifest' || flag === '--patch') {
      const destination = requireRelativePath(
        requireValue(args, index + 1, flag),
        `${flag} destination`,
      )
      const source = requireValue(args, index + 2, flag)
      setUnique(
        flag === '--package-manifest' ? packageManifests : patches,
        destination,
        source,
        flag,
      )
      index += 3
      continue
    }
    const value = requireValue(args, index + 1, flag)
    if (flag === '--output' && output === undefined) output = value
    else if (flag === '--package-name' && packageName === undefined) packageName = value
    else if (flag === '--pnpm' && pnpm === undefined) pnpm = value
    else if (flag === '--normalizer' && normalizer === undefined) normalizer = value
    else if (flag === '--store-dir' && storeDir === undefined) storeDir = value
    else if (flag === '--root-package-json' && rootPackageJson === undefined) rootPackageJson = value
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
    normalizer === undefined ||
    storeDir === undefined ||
    rootPackageJson === undefined ||
    lockfile === undefined ||
    workspaceManifest === undefined
  ) {
    invalidArguments('materialize-node-modules is missing a required option')
  }
  if (packageManifests.size === 0) invalidArguments('no workspace package manifests were declared')
  return {
    output,
    packageName,
    pnpm,
    normalizer,
    storeDir,
    rootPackageJson,
    lockfile,
    workspaceManifest,
    packageManifests,
    patches,
  }
}

const parseAssembleOptions = (args: readonly string[]): AssembleOptions => {
  let output: string | undefined
  let nodeModules: string | undefined
  const files = new Map<string, string>()
  const workspaceFiles = new Map<string, string>()
  const workspaceLinks = new Map<string, string>()

  for (let index = 0; index < args.length; ) {
    const flag = requireValue(args, index, 'argument')
    if (flag === '--file' || flag === '--workspace-file' || flag === '--workspace-link') {
      const destination = requireRelativePath(
        requireValue(args, index + 1, flag),
        `${flag} destination`,
      )
      const value = requireValue(args, index + 2, flag)
      if (flag === '--workspace-link') requireRelativePath(value, `${flag} target`)
      const values =
        flag === '--file' ? files : flag === '--workspace-file' ? workspaceFiles : workspaceLinks
      setUnique(values, destination, value, flag)
      index += 3
      continue
    }
    const value = requireValue(args, index + 1, flag)
    if (flag === '--output' && output === undefined) output = value
    else if (flag === '--node-modules' && nodeModules === undefined) nodeModules = value
    else invalidArguments(`unexpected argument: ${flag}`)
    index += 2
  }
  if (output === undefined || nodeModules === undefined) {
    invalidArguments('assemble-package-tree is missing a required option')
  }
  return { output, nodeModules, files, workspaceFiles, workspaceLinks }
}

const copyFileTo = (source: string, destination: string, writable: boolean): void => {
  mkdirSync(dirname(destination), { recursive: true })
  copyFileSync(source, destination)
  if (writable) chmodSync(destination, 0o644)
}

const hardlinkTree = (source: string, destination: string): void => {
  const metadata = lstatSync(source)
  if (metadata.isDirectory()) {
    mkdirSync(destination, { recursive: true })
    for (const entry of readdirSync(source).toSorted()) {
      hardlinkTree(join(source, entry), join(destination, entry))
    }
    return
  }
  mkdirSync(dirname(destination), { recursive: true })
  if (metadata.isSymbolicLink()) {
    symlinkSync(readlinkSync(source), destination)
  } else if (metadata.isFile()) {
    linkSync(source, destination)
  } else {
    throw new Error(`buck2 materializer: unsupported filesystem entry: ${source}`)
  }
}

const runPnpm = (pnpm: string, args: readonly string[]): void => {
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

const materializeNodeModules = async (options: MaterializeOptions): Promise<void> => {
  if (options.packageName.length === 0) invalidArguments('--package-name must not be empty')
  if (options.pnpm.startsWith('/nix/store/') === false) {
    invalidArguments(`--pnpm must be an immutable /nix/store executable: ${options.pnpm}`)
  }

  const output = resolve(options.output)
  const stage = `${output}.stage`
  const deploy = join(stage, '.deploy')
  const storeDir = resolve(options.storeDir)
  const outputParent = dirname(output)
  if (existsSync(storeDir) === false) {
    throw new Error(`buck2 materializer: pnpm store is not warm: ${storeDir}`)
  }
  if (statSync(storeDir).dev !== statSync(outputParent).dev) {
    throw new Error(
      `buck2 materializer: pnpm store and Buck output are on different filesystems: ${storeDir} vs ${outputParent}`,
    )
  }

  rmSync(stage, { recursive: true, force: true })
  rmSync(output, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  try {
    copyFileTo(options.rootPackageJson, join(stage, 'package.json'), true)
    copyFileTo(options.lockfile, join(stage, 'pnpm-lock.yaml'), false)
    copyFileTo(options.workspaceManifest, join(stage, 'pnpm-workspace.yaml'), false)
    for (const [destination, source] of options.packageManifests) {
      copyFileTo(source, join(stage, destination), true)
    }
    for (const [destination, source] of options.patches) {
      copyFileTo(source, join(stage, destination), false)
    }

    runPnpm(options.pnpm, [
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
    ])
    const normalizerModule: unknown = await import(pathToFileURL(resolve(options.normalizer)).href)
    if (normalizerModule === null || typeof normalizerModule !== 'object') {
      throw new Error('buck2 materializer: normalizer module must export normalizePnpmDeploy')
    }
    const normalizePnpmDeploy = Reflect.get(normalizerModule, 'normalizePnpmDeploy')
    if (typeof normalizePnpmDeploy !== 'function') {
      throw new Error('buck2 materializer: normalizer module must export normalizePnpmDeploy')
    }
    normalizePnpmDeploy({ tree: deploy, stagePrefix: stage })
    renameSync(join(deploy, 'node_modules'), output)
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

const destinationInside = (root: string, relativePath: string): string => {
  const destination = resolve(root, requireRelativePath(relativePath, 'destination'))
  const fromRoot = relative(root, destination)
  if (fromRoot === '' || fromRoot.startsWith(`..${sep}`) || fromRoot === '..') {
    invalidArguments(`destination escapes package tree: ${relativePath}`)
  }
  return destination
}

const assemblePackageTree = (options: AssembleOptions): void => {
  const output = resolve(options.output)
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  try {
    hardlinkTree(options.nodeModules, join(output, 'node_modules'))
    for (const [destination, source] of [...options.files, ...options.workspaceFiles]) {
      hardlinkTree(source, destinationInside(output, destination))
    }
    for (const [linkPath, targetPath] of options.workspaceLinks) {
      const link = destinationInside(output, linkPath)
      const target = destinationInside(output, targetPath)
      rmSync(link, { recursive: true, force: true })
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(relative(dirname(link), target), link)
      statSync(link)
    }
  } catch (error) {
    rmSync(output, { recursive: true, force: true })
    throw error
  }
}

export const runBuck2MaterializerCli = async (args: readonly string[]): Promise<void> => {
  const [command, ...commandArgs] = args
  if (command === 'materialize-node-modules') {
    await materializeNodeModules(parseMaterializeOptions(commandArgs))
  } else if (command === 'assemble-package-tree') {
    assemblePackageTree(parseAssembleOptions(commandArgs))
  } else {
    invalidArguments(`expected materialize-node-modules or assemble-package-tree, got ${String(command)}`)
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
