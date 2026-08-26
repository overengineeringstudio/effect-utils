#!/usr/bin/env -S bun
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Paths and policy inputs for normalizing a pnpm deploy tree in place. */
export type PnpmDeployNormalizationOptions = {
  readonly tree: string
  readonly stagePrefix: string
  readonly forbiddenPrefixes?: readonly string[]
}

/** Observable changes made while normalizing a pnpm deploy tree. */
export type PnpmDeployNormalizationReport = {
  readonly removedPrunedAt: boolean
  readonly removedStoreDir: boolean
  readonly deletedMetadataFiles: number
  readonly rewrittenShims: number
  readonly prunedDanglingSymlinks: number
}

type TreeEntry = {
  readonly path: string
  readonly kind: 'file' | 'symlink'
}

/** Typed failure for invalid input, malformed metadata, or unsafe deploy-tree residue. */
export class PnpmDeployNormalizationError extends Error {
  readonly code:
    | 'invalid-arguments'
    | 'invalid-modules-metadata'
    | 'residual-absolute-prefix'
    | 'unsafe-symlink'

  constructor({
    code,
    message,
    options,
  }: {
    readonly code: PnpmDeployNormalizationError['code']
    readonly message: string
    readonly options?: ErrorOptions
  }) {
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
    const children = readdirSync(directory, { withFileTypes: true }).toSorted((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    )
    for (const child of children) {
      const path = join(directory, child.name)
      if (child.isDirectory() === true) {
        visit(path)
      } else if (child.isFile() === true) {
        entries.push({ path, kind: 'file' })
      } else if (child.isSymbolicLink() === true) {
        entries.push({ path, kind: 'symlink' })
      }
    }
  }

  visit(root)
  return entries
}

const relativePath = ({ root, path }: { readonly root: string; readonly path: string }) =>
  relative(root, path).split(sep).join('/')

const isDanglingSymlink = (path: string) => {
  try {
    statSync(path)
    return false
  } catch (error) {
    if (isErrnoException(error) === true && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return true
    }
    throw error
  }
}

const pathIsInside = ({
  root,
  candidate,
}: {
  readonly root: string
  readonly candidate: string
}) => {
  const fromRoot = relative(root, candidate)
  return (
    fromRoot === '' ||
    (isAbsolute(fromRoot) === false &&
      fromRoot !== '..' &&
      fromRoot.startsWith(`..${sep}`) === false)
  )
}

const symlinkViolation = ({
  root,
  path,
}: {
  readonly root: string
  readonly path: string
}): string | undefined => {
  const target = readlinkSync(path)
  if (isAbsolute(target) === true) return `target is absolute: ${target}`

  const lexicalDestination = resolve(dirname(path), target)
  if (pathIsInside({ root, candidate: lexicalDestination }) === false) {
    return `target escapes the output tree: ${target}`
  }

  let resolvedDestination: string
  try {
    resolvedDestination = realpathSync(path)
  } catch (error) {
    if (
      isErrnoException(error) === true &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP')
    ) {
      return `target does not resolve inside the output tree: ${target}`
    }
    throw error
  }
  if (pathIsInside({ root, candidate: resolvedDestination }) === false) {
    return `target resolves outside the output tree: ${target}`
  }
  return undefined
}

const assertContainedSymlinks = ({
  root,
  entries,
}: {
  readonly root: string
  readonly entries: readonly TreeEntry[]
}) => {
  const violations = entries.flatMap((entry) => {
    if (entry.kind !== 'symlink') return []
    const violation = symlinkViolation({ root, path: entry.path })
    return violation === undefined
      ? []
      : [`${relativePath({ root, path: entry.path })} (${violation})`]
  })
  if (violations.length > 0) {
    throw new PnpmDeployNormalizationError({
      code: 'unsafe-symlink',
      message: `unsafe symlink remains in: ${violations.join(', ')}`,
    })
  }
}

const unlinkIfPresent = (path: string) => {
  try {
    lstatSync(path)
  } catch (error) {
    if (isErrnoException(error) === true && error.code === 'ENOENT') return false
    throw error
  }
  unlinkSync(path)
  return true
}

const shellPathFromBasedir = ({
  shimDirectory,
  target,
}: {
  readonly shimDirectory: string
  readonly target: string
}) => {
  const targetFromShim = relative(shimDirectory, target).split(sep).join('/')
  return targetFromShim === '' ? '$basedir' : `$basedir/${targetFromShim}`
}

const rewriteShim = ({
  path,
  tree,
  nodeModules,
}: {
  readonly path: string
  readonly tree: string
  readonly nodeModules: string
}) => {
  const original = readFileSync(path, 'utf8')
  const shimDirectory = resolve(path, '..')
  const rewritten = original
    .replaceAll(nodeModules, shellPathFromBasedir({ shimDirectory, target: nodeModules }))
    .replaceAll(tree, shellPathFromBasedir({ shimDirectory, target: tree }))
  if (rewritten === original) return false
  writeFileSync(path, rewritten)
  return true
}

const fileContainsAny = ({
  path,
  needles,
}: {
  readonly path: string
  readonly needles: readonly Buffer[]
}) => {
  const chunkSize = 64 * 1024
  const overlapSize = Math.max(...needles.map((needle) => needle.length - 1), 0)
  const buffer = Buffer.allocUnsafe(chunkSize + overlapSize)
  const descriptor = openSync(path, 'r')
  let overlap = 0
  try {
    while (true) {
      const bytesRead = readSync(descriptor, buffer, overlap, chunkSize, null)
      if (bytesRead === 0) return false
      const populated = overlap + bytesRead
      const chunk = buffer.subarray(0, populated)
      if (needles.some((needle) => chunk.includes(needle)) === true) return true
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
    throw new PnpmDeployNormalizationError({
      code: 'invalid-modules-metadata',
      message: `${path} is not valid JSON`,
      options: { cause: error },
    })
  }
  if (isRecord(parsed) === false) {
    throw new PnpmDeployNormalizationError({
      code: 'invalid-modules-metadata',
      message: `${path} must contain a JSON object`,
    })
  }
  const removedPrunedAt = Object.hasOwn(parsed, 'prunedAt')
  const removedStoreDir = Object.hasOwn(parsed, 'storeDir')
  if (removedPrunedAt === true) delete parsed.prunedAt
  if (removedStoreDir === true) delete parsed.storeDir
  if (removedPrunedAt === true || removedStoreDir === true) {
    writeFileSync(path, `${JSON.stringify(parsed, undefined, 2)}\n`)
  }
  return { removedPrunedAt, removedStoreDir }
}

/** Normalizes a deploy tree in place and rejects unsafe links or residual absolute paths. */
export const normalizePnpmDeploy = (
  options: PnpmDeployNormalizationOptions,
): PnpmDeployNormalizationReport => {
  const tree = resolve(options.tree)
  if (isAbsolute(options.stagePrefix) === false || resolve(options.stagePrefix) === '/') {
    throw new PnpmDeployNormalizationError({
      code: 'invalid-arguments',
      message: '--stage-prefix must be an absolute path other than the filesystem root',
    })
  }
  const stagePrefix = resolve(options.stagePrefix)
  const forbiddenPrefixes = [...new Set([stagePrefix, ...(options.forbiddenPrefixes ?? [])])].map(
    (prefix) => {
      if (isAbsolute(prefix) === false || resolve(prefix) === '/') {
        throw new PnpmDeployNormalizationError({
          code: 'invalid-arguments',
          message: 'forbidden prefixes must be absolute paths other than the filesystem root',
        })
      }
      return resolve(prefix)
    },
  )
  const nodeModules = join(tree, 'node_modules')
  const modulesMetadata = join(nodeModules, '.modules.yaml')

  try {
    statSync(nodeModules)
  } catch (error) {
    throw new PnpmDeployNormalizationError({
      code: 'invalid-arguments',
      message: `--tree must name a pnpm deploy root containing node_modules: ${tree}`,
      options: { cause: error },
    })
  }

  const { removedPrunedAt, removedStoreDir } = normalizeModulesMetadata(modulesMetadata)
  let deletedMetadataFiles = 0
  for (const path of [
    join(nodeModules, '.pnpm', 'lock.yaml'),
    join(nodeModules, '.pnpm-workspace-state-v1.json'),
    join(tree, 'pnpm-lock.yaml'),
  ]) {
    if (unlinkIfPresent(path) === true) deletedMetadataFiles += 1
  }

  let rewrittenShims = 0
  let prunedDanglingSymlinks = 0
  for (const entry of walkTree(tree)) {
    const relativeEntry = relativePath({ root: tree, path: entry.path })
    if (entry.kind === 'file' && relativeEntry.split('/').at(-2) === '.bin') {
      if (rewriteShim({ path: entry.path, tree, nodeModules }) === true) {
        rewrittenShims += 1
      }
    } else if (
      entry.kind === 'symlink' &&
      relativeEntry.startsWith('node_modules/') === true &&
      isDanglingSymlink(entry.path) === true
    ) {
      unlinkSync(entry.path)
      prunedDanglingSymlinks += 1
    }
  }

  const finalEntries = walkTree(tree)
  assertContainedSymlinks({ root: tree, entries: finalEntries })

  const forbiddenPrefixBytes = forbiddenPrefixes.map((prefix) => Buffer.from(prefix))
  const residualAbsolutePaths: string[] = []
  for (const entry of finalEntries) {
    const relativeEntry = relativePath({ root: tree, path: entry.path })
    if (entry.kind === 'file') {
      if (fileContainsAny({ path: entry.path, needles: forbiddenPrefixBytes }) === true) {
        residualAbsolutePaths.push(relativeEntry)
      }
    } else if (
      forbiddenPrefixes.some((prefix) => readlinkSync(entry.path).includes(prefix)) === true
    ) {
      residualAbsolutePaths.push(relativeEntry)
    }
  }

  if (residualAbsolutePaths.length > 0) {
    throw new PnpmDeployNormalizationError({
      code: 'residual-absolute-prefix',
      message: `forbidden absolute prefix remains in: ${residualAbsolutePaths.join(', ')}`,
    })
  }

  return {
    removedPrunedAt,
    removedStoreDir,
    deletedMetadataFiles,
    rewrittenShims,
    prunedDanglingSymlinks,
  }
}

const parseCliArguments = (args: readonly string[]): PnpmDeployNormalizationOptions => {
  let tree: string | undefined
  let stagePrefix: string | undefined
  const forbiddenPrefixes: string[] = []
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (value === undefined) {
      throw new PnpmDeployNormalizationError({
        code: 'invalid-arguments',
        message: `missing value for ${flag}`,
      })
    }
    if (flag === '--tree' && tree === undefined) tree = value
    else if (flag === '--stage-prefix' && stagePrefix === undefined) stagePrefix = value
    else if (flag === '--forbidden-prefix') forbiddenPrefixes.push(value)
    else
      throw new PnpmDeployNormalizationError({
        code: 'invalid-arguments',
        message: `unexpected argument: ${flag}`,
      })
  }
  if (tree === undefined || stagePrefix === undefined) {
    throw new PnpmDeployNormalizationError({
      code: 'invalid-arguments',
      message:
        'usage: pnpm-deploy-normalizer.ts --tree <deploy-root> --stage-prefix <absolute-prefix> [--forbidden-prefix <absolute-prefix>]...',
    })
  }
  return { tree, stagePrefix, forbiddenPrefixes }
}

/** Applies the normalizer using the command-line argument contract. */
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
