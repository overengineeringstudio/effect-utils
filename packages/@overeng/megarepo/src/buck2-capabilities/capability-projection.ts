import { createHash } from 'node:crypto'
import { access, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'
import process from 'node:process'

import type { BuckMemberCapability } from '../buck2-manifest.ts'

type DirectoryCapability = {
  readonly toolId: string
  readonly protocol: string
  readonly flakePackage: string
  readonly kind: 'directory'
}

/** Exact Nix realization and complete immutable closure of one projected input. */
type ResolvedCapability =
  | {
      readonly kind: 'executable'
      readonly capability: BuckMemberCapability
      readonly nixOutputPath: string
      readonly executablePath: string
      readonly executableDigest: `sha256:${string}`
      readonly closureStorePaths: readonly string[]
    }
  | {
      readonly kind: 'directory'
      readonly capability: DirectoryCapability
      readonly nixOutputPath: string
      readonly closureStorePaths: readonly string[]
    }

/** Supported host tuples for materialized capability projections. */
export type CapabilityProjectionPlatform = 'aarch64-linux' | 'aarch64-macos' | 'x86_64-linux'

/** Immutable manifest describing one exact projected capability realization. */
export type CapabilityProjectionManifest =
  | {
      readonly closureIdentity: string
      readonly closureStorePaths: readonly string[]
      readonly contentDigest: string
      readonly executableStorePath: string
      readonly executionPlatform: CapabilityProjectionPlatform
      readonly protocol: string
      readonly runtimeContract: 'native-executable/v1'
      readonly schema: 'effect-utils/buck2-support-tools/v1'
      readonly toolId: string
    }
  | {
      readonly closureIdentity: string
      readonly closureStorePaths: readonly string[]
      readonly contentDigest: string
      readonly directoryStorePath: string
      readonly executionPlatform: CapabilityProjectionPlatform
      readonly protocol: string
      readonly runtimeContract: 'immutable-directory/v1'
      readonly schema: 'effect-utils/buck2-store-inputs/v1'
      readonly toolId: string
    }

/** Converts an exact Nix realization into the matching capability manifest. */
export const makeCapabilityProjectionManifest = ({
  platform,
  resolved,
}: {
  readonly platform: CapabilityProjectionPlatform
  readonly resolved: ResolvedCapability
}): CapabilityProjectionManifest =>
  resolved.kind === 'directory'
    ? {
        closureIdentity: resolved.nixOutputPath,
        closureStorePaths: resolved.closureStorePaths,
        // Nix store paths name verified immutable contents; this digest identifies
        // the directory realization rather than hashing an arbitrary filesystem walk.
        contentDigest: createHash('sha256').update(resolved.nixOutputPath).digest('hex'),
        directoryStorePath: resolved.nixOutputPath,
        executionPlatform: platform,
        protocol: resolved.capability.protocol,
        runtimeContract: 'immutable-directory/v1',
        schema: 'effect-utils/buck2-store-inputs/v1',
        toolId: resolved.capability.toolId,
      }
    : {
        closureIdentity: resolved.nixOutputPath,
        closureStorePaths: resolved.closureStorePaths,
        contentDigest: resolved.executableDigest.slice('sha256:'.length),
        executableStorePath: resolved.executablePath,
        executionPlatform: platform,
        protocol: resolved.capability.protocol,
        runtimeContract: 'native-executable/v1',
        schema: 'effect-utils/buck2-support-tools/v1',
        toolId: resolved.capability.toolId,
      }

/** Generated Buck package exposing one projected capability executable and manifest. */
export const capabilityToolBuckBytes =
  'export_file(name = "executable", src = "executable", visibility = ["PUBLIC"])\n' +
  'export_file(name = "manifest", src = "manifest.json", visibility = ["PUBLIC"])\n'
/** Generated Buck package exposing one immutable directory and its manifest. */
export const capabilityDirectoryBuckBytes =
  'export_file(name = "directory", src = "directory", visibility = ["PUBLIC"])\n' +
  'export_file(name = "manifest", src = "manifest.json", visibility = ["PUBLIC"])\n'
/** Generated Buck package marker for the capability projection root. */
export const capabilityRootBuckBytes = '# Generated from exact Nix realizations.\n'

const manifestBytes = (manifest: CapabilityProjectionManifest): string =>
  `${JSON.stringify(manifest)}\n`

/** Computes the stable generation identity for an ordered capability file set. */
export const computeCapabilityProjectionGeneration = (
  files: ReadonlyArray<{ readonly path: string; readonly bytes: string }>,
): string => {
  const framed = files
    .toSorted((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map(({ path, bytes }) => `${createHash('sha256').update(bytes).digest('hex')}  ./${path}\n`)
    .join('')
  const payloadDigest = createHash('sha256').update(framed).digest('hex')
  return createHash('sha256').update(`${payloadDigest}  -\n`).digest('hex')
}

/** Renders the generated Buck definitions for one capability generation. */
export const renderCapabilityProjectionDefs = ({
  generation,
  platform,
  manifests,
}: {
  readonly generation: string
  readonly platform: CapabilityProjectionPlatform
  readonly manifests: ReadonlyArray<CapabilityProjectionManifest>
}): string =>
  [
    `GENERATION = "${generation}"`,
    'CAPABILITIES = {',
    `  "${platform}": {`,
    ...manifests.map((manifest) => {
      const pathField =
        manifest.runtimeContract === 'immutable-directory/v1'
          ? `"directoryStorePath": "${manifest.directoryStorePath}"`
          : `"executableStorePath": "${manifest.executableStorePath}"`
      return `    "${manifest.toolId}": {"generation": "${generation}", "contentDigest": "${manifest.contentDigest}", "closureIdentity": "${manifest.closureIdentity}", ${pathField}, "closureStorePaths": [${manifest.closureStorePaths.map((path) => `"${path}"`).join(', ')}]},`
    }),
    '  },',
    '}',
    '',
  ].join('\n')

/** Materializes one immutable generation of resolved capabilities. */
export const projectResolvedCapabilities = async ({
  projectionPath,
  platform,
  resolved,
}: {
  readonly projectionPath: string
  readonly platform: CapabilityProjectionPlatform
  readonly resolved: ReadonlyArray<ResolvedCapability>
}): Promise<{ readonly projectionPath: string; readonly generation: string }> => {
  const manifests = resolved.map((resolvedCapability) =>
    makeCapabilityProjectionManifest({ platform, resolved: resolvedCapability }),
  )
  const files = manifests.flatMap((manifest) => [
    {
      path: `${platform}/${manifest.toolId}/BUCK`,
      bytes:
        manifest.runtimeContract === 'immutable-directory/v1'
          ? capabilityDirectoryBuckBytes
          : capabilityToolBuckBytes,
    },
    { path: `${platform}/${manifest.toolId}/manifest.json`, bytes: manifestBytes(manifest) },
  ])
  const generation = computeCapabilityProjectionGeneration(files)
  const generationRoot = NodePath.join(projectionPath, 'generations', generation, platform)
  await mkdir(generationRoot, { recursive: true })
  await Promise.all(
    manifests.map(async (manifest) => {
      const directory = NodePath.join(generationRoot, manifest.toolId)
      await mkdir(directory)
      if (manifest.runtimeContract === 'immutable-directory/v1') {
        await symlink(manifest.directoryStorePath, NodePath.join(directory, 'directory'))
      } else {
        await symlink(manifest.executableStorePath, NodePath.join(directory, 'executable'))
      }
      await writeFile(NodePath.join(directory, 'manifest.json'), manifestBytes(manifest), {
        flag: 'wx',
      })
      await writeFile(
        NodePath.join(directory, 'BUCK'),
        manifest.runtimeContract === 'immutable-directory/v1'
          ? capabilityDirectoryBuckBytes
          : capabilityToolBuckBytes,
        { flag: 'wx' },
      )
    }),
  )
  await writeFile(NodePath.join(projectionPath, 'BUCK'), capabilityRootBuckBytes, { flag: 'wx' })
  await writeFile(
    NodePath.join(projectionPath, 'defs.bzl'),
    renderCapabilityProjectionDefs({ generation, platform, manifests }),
    { flag: 'wx' },
  )
  return { projectionPath, generation }
}

type NixCapabilityProjectionInput = {
  readonly capability: BuckMemberCapability | DirectoryCapability
  readonly closurePathsFile: string
  readonly nixOutputPath: string
}

const decodeNixProjectionInput = (value: unknown): readonly NixCapabilityProjectionInput[] => {
  if (Array.isArray(value) === false)
    throw new TypeError('capability projection input must be an array')
  return value.map((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      Array.isArray(entry) === true ||
      'capability' in entry === false ||
      typeof entry.capability !== 'object' ||
      entry.capability === null ||
      Array.isArray(entry.capability) === true
    ) {
      throw new TypeError('capability projection entry must contain a capability')
    }
    const capability = entry.capability
    const toolId = 'toolId' in capability ? capability.toolId : undefined
    const protocol = 'protocol' in capability ? capability.protocol : undefined
    const flakePackage = 'flakePackage' in capability ? capability.flakePackage : undefined
    const executable = 'executable' in capability ? capability.executable : undefined
    const closurePathsFile = 'closurePathsFile' in entry ? entry.closurePathsFile : undefined
    const nixOutputPath = 'nixOutputPath' in entry ? entry.nixOutputPath : undefined
    if (
      typeof toolId !== 'string' ||
      typeof protocol !== 'string' ||
      typeof flakePackage !== 'string' ||
      typeof closurePathsFile !== 'string' ||
      typeof nixOutputPath !== 'string'
    ) {
      throw new TypeError('capability projection entry contains a non-string field')
    }
    if ('kind' in capability && capability.kind === 'directory') {
      return {
        capability: { toolId, protocol, flakePackage, kind: 'directory' },
        closurePathsFile,
        nixOutputPath,
      }
    }
    if (typeof executable !== 'string' || 'kind' in capability) {
      throw new TypeError('capability projection executable must name a relative executable')
    }
    return {
      capability: { toolId, protocol, flakePackage, executable },
      closurePathsFile,
      nixOutputPath,
    }
  })
}

const executableDigest = async (path: string): Promise<`sha256:${string}`> =>
  `sha256:${createHash('sha256')
    .update(await readFile(path))
    .digest('hex')}`

const resolveNixProjectionInput = async (
  input: NixCapabilityProjectionInput,
): Promise<ResolvedCapability> => {
  const outputRoot = await realpath(input.nixOutputPath)
  const outputInfo = await stat(outputRoot)
  if (outputInfo.isDirectory() === false) {
    throw new TypeError(`capability output must be a directory: ${input.capability.toolId}`)
  }
  const isDirectory = 'kind' in input.capability
  const executablePath = isDirectory
    ? undefined
    : await realpath(NodePath.join(outputRoot, input.capability.executable))
  if (executablePath !== undefined) {
    const executableInfo = await stat(executablePath)
    if (
      executableInfo.isFile() === false ||
      (executablePath !== outputRoot &&
        executablePath.startsWith(`${outputRoot}${NodePath.sep}`) === false)
    ) {
      throw new TypeError(`capability executable escapes its Nix output: ${input.capability.toolId}`)
    }
    await access(executablePath, 1)
  }
  const closureStorePaths = [
    ...new Set(
      (await readFile(input.closurePathsFile, 'utf8'))
        .split(/\r?\n/u)
        .filter((path) => path.length > 0),
    ),
  ].toSorted()
  if (closureStorePaths.includes(outputRoot) === false) {
    throw new TypeError(`capability closure omits its Nix output: ${input.capability.toolId}`)
  }
  if (isDirectory) {
    return {
      kind: 'directory',
      capability: input.capability,
      nixOutputPath: outputRoot,
      closureStorePaths,
    }
  }
  return {
    kind: 'executable',
    capability: input.capability,
    nixOutputPath: outputRoot,
    executablePath,
    executableDigest: await executableDigest(executablePath),
    closureStorePaths,
  }
}

const main = async (): Promise<void> => {
  const [inputFlag, inputPath, outputFlag, outputPath, platformFlag, platform, ...unexpected] =
    process.argv.slice(2)
  if (
    inputFlag !== '--input' ||
    inputPath === undefined ||
    outputFlag !== '--output' ||
    outputPath === undefined ||
    platformFlag !== '--platform' ||
    (platform !== 'x86_64-linux' && platform !== 'aarch64-linux' && platform !== 'aarch64-macos') ||
    unexpected.length > 0
  ) {
    throw new TypeError(
      'usage: capability-projection.ts --input <json> --output <directory> --platform <platform>',
    )
  }
  const input = decodeNixProjectionInput(JSON.parse(await readFile(inputPath, 'utf8')))
  const resolved = await Promise.all(input.map(resolveNixProjectionInput))
  await projectResolvedCapabilities({ projectionPath: outputPath, platform, resolved })
}

if (import.meta.main === true) await main()
