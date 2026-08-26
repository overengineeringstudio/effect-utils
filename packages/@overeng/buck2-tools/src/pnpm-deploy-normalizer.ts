#!/usr/bin/env -S bun
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export type PnpmDeployNormalizationOptions = {
  readonly tree: string
  readonly stagePrefix: string
}

export type PnpmDeployNormalizationReport = {
  readonly removedPrunedAt: boolean
  readonly deletedMetadataFiles: number
  readonly rewrittenShims: number
  readonly prunedDanglingSymlinks: number
}

type TreeEntry = {
  readonly path: string
  readonly kind: 'file' | 'symlink'
}

export class PnpmDeployNormalizationError extends Error {
  readonly code:
    | 'invalid-arguments'
    | 'invalid-modules-metadata'
    | 'residual-stage-prefix'
    | 'residual-dangling-symlink'

  constructor(
    code: PnpmDeployNormalizationError['code'],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'PnpmDeployNormalizationError'
    this.code = code
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && Array.isArray(value) === false

const isErrnoException = (value: unknown): value is NodeJS.ErrnoException =>
  value instanceof Error && 'code' in value

const walkTree = (root: string): readonly TreeEntry[] => {
  const entries: TreeEntry[] = []
  const visit = (directory: string) => {
    const children = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    )
    for (const child of children) {
      const path = join(directory, child.name)
      if (child.isDirectory()) {
        visit(path)
      } else if (child.isFile()) {
        entries.push({ path, kind: 'file' })
      } else if (child.isSymbolicLink()) {
        entries.push({ path, kind: 'symlink' })
      }
    }
  }

  visit(root)
  return entries
}

const relativePath = (root: string, path: string) => relative(root, path).split(sep).join('/')

const isDanglingSymlink = (path: string) => {
  try {
    statSync(path)
    return false
  } catch (error) {
    if (isErrnoException(error) && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return true
    }
    throw error
  }
}

const unlinkIfPresent = (path: string) => {
  try {
    lstatSync(path)
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return false
    throw error
  }
  unlinkSync(path)
  return true
}

const shellPathFromBasedir = (shimDirectory: string, target: string) => {
  const targetFromShim = relative(shimDirectory, target).split(sep).join('/')
  return targetFromShim === '' ? '$basedir' : `$basedir/${targetFromShim}`
}

const rewriteShim = (path: string, tree: string, nodeModules: string) => {
  const original = readFileSync(path, 'utf8')
  const shimDirectory = resolve(path, '..')
  const rewritten = original
    .replaceAll(nodeModules, shellPathFromBasedir(shimDirectory, nodeModules))
    .replaceAll(tree, shellPathFromBasedir(shimDirectory, tree))
  if (rewritten === original) return false
  writeFileSync(path, rewritten)
  return true
}

const fileContains = (path: string, needle: Buffer) => {
  const chunkSize = 64 * 1024
  const overlapSize = Math.max(needle.length - 1, 0)
  const buffer = Buffer.allocUnsafe(chunkSize + overlapSize)
  const descriptor = openSync(path, 'r')
  let overlap = 0
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, overlap, chunkSize, null)
      if (bytesRead === 0) return false
      const populated = overlap + bytesRead
      if (buffer.subarray(0, populated).includes(needle)) return true
      overlap = Math.min(overlapSize, populated)
      buffer.copyWithin(0, populated - overlap, populated)
    }
  } finally {
    closeSync(descriptor)
  }
}

const normalizeModulesMetadata = (path: string) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new PnpmDeployNormalizationError(
      'invalid-modules-metadata',
      `${path} is not valid JSON`,
      { cause: error },
    )
  }
  if (isRecord(parsed) === false) {
    throw new PnpmDeployNormalizationError(
      'invalid-modules-metadata',
      `${path} must contain a JSON object`,
    )
  }
  if (Object.hasOwn(parsed, 'prunedAt') === false) return false
  delete parsed.prunedAt
  writeFileSync(path, `${JSON.stringify(parsed, undefined, 2)}\n`)
  return true
}

export const normalizePnpmDeploy = (
  options: PnpmDeployNormalizationOptions,
): PnpmDeployNormalizationReport => {
  const tree = resolve(options.tree)
  if (isAbsolute(options.stagePrefix) === false || resolve(options.stagePrefix) === '/') {
    throw new PnpmDeployNormalizationError(
      'invalid-arguments',
      '--stage-prefix must be an absolute path other than the filesystem root',
    )
  }
  const stagePrefix = resolve(options.stagePrefix)
  const nodeModules = join(tree, 'node_modules')
  const modulesMetadata = join(nodeModules, '.modules.yaml')

  try {
    statSync(nodeModules)
  } catch (error) {
    throw new PnpmDeployNormalizationError(
      'invalid-arguments',
      `--tree must name a pnpm deploy root containing node_modules: ${tree}`,
      { cause: error },
    )
  }

  const removedPrunedAt = normalizeModulesMetadata(modulesMetadata)
  let deletedMetadataFiles = 0
  for (const path of [
    join(nodeModules, '.pnpm', 'lock.yaml'),
    join(nodeModules, '.pnpm-workspace-state-v1.json'),
    join(tree, 'pnpm-lock.yaml'),
  ]) {
    if (unlinkIfPresent(path)) deletedMetadataFiles += 1
  }

  let rewrittenShims = 0
  let prunedDanglingSymlinks = 0
  for (const entry of walkTree(tree)) {
    const relativeEntry = relativePath(tree, entry.path)
    if (entry.kind === 'file' && relativeEntry.split('/').at(-2) === '.bin') {
      if (rewriteShim(entry.path, tree, nodeModules)) rewrittenShims += 1
    } else if (
      entry.kind === 'symlink' &&
      relativeEntry.startsWith('node_modules/') &&
      isDanglingSymlink(entry.path)
    ) {
      unlinkSync(entry.path)
      prunedDanglingSymlinks += 1
    }
  }

  const stagePrefixBytes = Buffer.from(stagePrefix)
  const residualStagePaths: string[] = []
  const danglingSymlinks: string[] = []
  for (const entry of walkTree(tree)) {
    const relativeEntry = relativePath(tree, entry.path)
    if (entry.kind === 'file') {
      if (fileContains(entry.path, stagePrefixBytes)) residualStagePaths.push(relativeEntry)
    } else {
      if (readlinkSync(entry.path).includes(stagePrefix)) residualStagePaths.push(relativeEntry)
      if (isDanglingSymlink(entry.path)) danglingSymlinks.push(relativeEntry)
    }
  }

  if (residualStagePaths.length > 0) {
    throw new PnpmDeployNormalizationError(
      'residual-stage-prefix',
      `stage prefix remains in: ${residualStagePaths.join(', ')}`,
    )
  }
  if (danglingSymlinks.length > 0) {
    throw new PnpmDeployNormalizationError(
      'residual-dangling-symlink',
      `dangling symlink remains in: ${danglingSymlinks.join(', ')}`,
    )
  }

  return {
    removedPrunedAt,
    deletedMetadataFiles,
    rewrittenShims,
    prunedDanglingSymlinks,
  }
}

const parseCliArguments = (args: readonly string[]): PnpmDeployNormalizationOptions => {
  let tree: string | undefined
  let stagePrefix: string | undefined
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (value === undefined) {
      throw new PnpmDeployNormalizationError('invalid-arguments', `missing value for ${flag}`)
    }
    if (flag === '--tree' && tree === undefined) tree = value
    else if (flag === '--stage-prefix' && stagePrefix === undefined) stagePrefix = value
    else throw new PnpmDeployNormalizationError('invalid-arguments', `unexpected argument: ${flag}`)
  }
  if (tree === undefined || stagePrefix === undefined) {
    throw new PnpmDeployNormalizationError(
      'invalid-arguments',
      'usage: pnpm-deploy-normalizer.ts --tree <deploy-root> --stage-prefix <absolute-prefix>',
    )
  }
  return { tree, stagePrefix }
}

export const runPnpmDeployNormalizerCli = (args: readonly string[]): void => {
  normalizePnpmDeploy(parseCliArguments(args))
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runPnpmDeployNormalizerCli(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
