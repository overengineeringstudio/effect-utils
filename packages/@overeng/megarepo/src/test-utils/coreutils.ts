import { constants } from 'node:fs'
import { access, lstat, readlink, realpath } from 'node:fs/promises'
import * as NodePath from 'node:path'

import { compositionRuntimeEnvironmentNames } from '../composition/apply/composition-runtime.ts'

const toolNames = ['cp', 'mv'] as const
type CoreutilsTool = (typeof toolNames)[number]

const validateExecutable = async ({
  name,
  path,
  source,
}: {
  readonly name: CoreutilsTool
  readonly path: string
  readonly source: string
}): Promise<string> => {
  if (
    NodePath.isAbsolute(path) === false ||
    NodePath.normalize(path) !== path ||
    NodePath.basename(path) !== name
  ) {
    throw new TypeError(`${source} must provide an exact normalized absolute ${name} path`)
  }
  const target = await realpath(path)
  const info = await lstat(target)
  if (info.isFile() === false) {
    throw new TypeError(`${source} ${name} target is not a regular file: ${target}`)
  }
  await access(target, constants.X_OK)
  return path
}

const nixCoreutilsRoot = ({
  name,
  path,
}: {
  readonly name: CoreutilsTool
  readonly path: string
}) => {
  if (NodePath.basename(path) !== name || NodePath.basename(NodePath.dirname(path)) !== 'bin') {
    return undefined
  }
  const root = NodePath.dirname(NodePath.dirname(path))
  return /^[0-9a-z]{32}-coreutils(?:-full)?-/u.test(NodePath.basename(root)) === true
    ? root
    : undefined
}

const resolvePinnedPathEntry = async ({
  name,
  candidate,
  depth = 0,
}: {
  readonly name: CoreutilsTool
  readonly candidate: string
  readonly depth?: number
}): Promise<{ readonly path: string; readonly storeRoot: string }> => {
  if (depth >= 16) throw new TypeError(`PATH ${name} exceeded the symlink resolution limit`)
  const path = NodePath.normalize(candidate)
  const storeRoot = nixCoreutilsRoot({ name, path })
  if (storeRoot !== undefined) {
    const target = await realpath(path)
    const relativeTarget = NodePath.relative(storeRoot, target)
    if (
      relativeTarget === '' ||
      relativeTarget === '..' ||
      relativeTarget.startsWith(`..${NodePath.sep}`) === true
    ) {
      throw new TypeError(`Resolved ${name} escapes its pinned coreutils store item: ${target}`)
    }
    await validateExecutable({ name, path, source: 'PATH' })
    return { path, storeRoot }
  }
  const info = await lstat(path)
  if (info.isSymbolicLink() === false) {
    throw new TypeError(`PATH ${name} is not pinned to a Nix coreutils store item: ${path}`)
  }
  const linked = await readlink(path)
  return resolvePinnedPathEntry({
    name,
    candidate: NodePath.resolve(NodePath.dirname(path), linked),
    depth: depth + 1,
  })
}

const findPathCandidate = async ({
  name,
  directories,
  index = 0,
}: {
  readonly name: CoreutilsTool
  readonly directories: ReadonlyArray<string>
  readonly index?: number
}): Promise<string> => {
  const directory = directories[index]
  if (directory === undefined) {
    throw new TypeError(`Could not find ${name} in the explicit test PATH`)
  }
  if (directory.length === 0 || NodePath.isAbsolute(directory) === false) {
    return findPathCandidate({ name, directories, index: index + 1 })
  }
  const candidate = NodePath.join(directory, name)
  try {
    await access(candidate, constants.X_OK)
    return candidate
  } catch {
    return findPathCandidate({ name, directories, index: index + 1 })
  }
}

/** Resolve exact cp/mv paths from complete runtime injection or a verified Nix coreutils PATH item. */
export const resolvePinnedCoreutils = async ({
  env = process.env,
  searchPath = env.PATH ?? '',
}: {
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly searchPath?: string
} = {}): Promise<{ readonly cpPath: string; readonly mvPath: string }> => {
  const injected = {
    cp: env[compositionRuntimeEnvironmentNames.cpPath],
    mv: env[compositionRuntimeEnvironmentNames.mvPath],
  }
  const injectedCount = toolNames.filter((name) => injected[name] !== undefined).length
  if (injectedCount !== 0 && injectedCount !== toolNames.length) {
    throw new TypeError('Pinned coreutils injection must provide both cp and mv')
  }
  if (injectedCount === toolNames.length) {
    return {
      cpPath: await validateExecutable({
        name: 'cp',
        path: injected.cp!,
        source: compositionRuntimeEnvironmentNames.cpPath,
      }),
      mvPath: await validateExecutable({
        name: 'mv',
        path: injected.mv!,
        source: compositionRuntimeEnvironmentNames.mvPath,
      }),
    }
  }

  const cp = await resolvePinnedPathEntry({
    name: 'cp',
    candidate: await findPathCandidate({
      name: 'cp',
      directories: searchPath.split(NodePath.delimiter),
    }),
  })
  const mv = await resolvePinnedPathEntry({
    name: 'mv',
    candidate: await findPathCandidate({
      name: 'mv',
      directories: searchPath.split(NodePath.delimiter),
    }),
  })
  if (cp.storeRoot !== mv.storeRoot) {
    throw new TypeError(`PATH cp and mv do not share one pinned coreutils store item`)
  }
  return { cpPath: cp.path, mvPath: mv.path }
}
