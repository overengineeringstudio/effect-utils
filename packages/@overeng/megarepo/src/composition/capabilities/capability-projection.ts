import { createHash } from 'node:crypto'
import { access, mkdir, readFile, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import * as NodePath from 'node:path'
import process from 'node:process'

import type { BuckMemberCapability } from '../../buck2-manifest.ts'
import type { ResolvedCompositionCapability } from './composition-capability-resolver-schema.ts'

export type CapabilityProjectionPlatform = 'aarch64-linux' | 'aarch64-macos' | 'x86_64-linux'

export type CapabilityProjectionManifest = {
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

export const makeCapabilityProjectionManifest = ({
  platform,
  resolved,
}: {
  readonly platform: CapabilityProjectionPlatform
  readonly resolved: ResolvedCompositionCapability
}): CapabilityProjectionManifest => ({
  closureIdentity: resolved.nixOutputPath,
  closureStorePaths: resolved.closureStorePaths,
  contentDigest: resolved.executableDigest.slice('sha256:'.length),
  executableStorePath: resolved.executablePath,
  executionPlatform: platform,
  protocol: resolved.capability.protocol,
  runtimeContract: 'native-executable/v1',
  schema: 'effect-utils/buck2-support-tools/v1',
  toolId: resolved.capability.toolId,
})

export const capabilityToolBuckBytes =
  'export_file(name = "executable", src = "executable", visibility = ["PUBLIC"])\n' +
  'export_file(name = "manifest", src = "manifest.json", visibility = ["PUBLIC"])\n'
export const capabilityRootBuckBytes = '# Generated from exact Nix realizations.\n'

const manifestBytes = (manifest: CapabilityProjectionManifest): string =>
  `${JSON.stringify(manifest)}\n`

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
    ...manifests.map(
      (manifest) =>
        `    "${manifest.toolId}": {"generation": "${generation}", "contentDigest": "${manifest.contentDigest}", "closureIdentity": "${manifest.closureIdentity}", "executableStorePath": "${manifest.executableStorePath}", "closureStorePaths": [${manifest.closureStorePaths.map((path) => `"${path}"`).join(', ')}]},`,
    ),
    '  },',
    '}',
    '',
  ].join('\n')

export const projectResolvedCapabilities = async ({
  projectionPath,
  platform,
  resolved,
}: {
  readonly projectionPath: string
  readonly platform: CapabilityProjectionPlatform
  readonly resolved: ReadonlyArray<ResolvedCompositionCapability>
}): Promise<{ readonly projectionPath: string; readonly generation: string }> => {
  const manifests = resolved.map((resolvedCapability) =>
    makeCapabilityProjectionManifest({ platform, resolved: resolvedCapability }),
  )
  const files = manifests.flatMap((manifest) => [
    { path: `${platform}/${manifest.toolId}/BUCK`, bytes: capabilityToolBuckBytes },
    { path: `${platform}/${manifest.toolId}/manifest.json`, bytes: manifestBytes(manifest) },
  ])
  const generation = computeCapabilityProjectionGeneration(files)
  const generationRoot = NodePath.join(projectionPath, 'generations', generation, platform)
  await mkdir(generationRoot, { recursive: true })
  await Promise.all(
    manifests.map(async (manifest) => {
      const directory = NodePath.join(generationRoot, manifest.toolId)
      await mkdir(directory)
      await symlink(manifest.executableStorePath, NodePath.join(directory, 'executable'))
      await writeFile(NodePath.join(directory, 'manifest.json'), manifestBytes(manifest), {
        flag: 'wx',
      })
      await writeFile(NodePath.join(directory, 'BUCK'), capabilityToolBuckBytes, { flag: 'wx' })
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
  readonly capability: BuckMemberCapability
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
      typeof executable !== 'string' ||
      typeof closurePathsFile !== 'string' ||
      typeof nixOutputPath !== 'string'
    ) {
      throw new TypeError('capability projection entry contains a non-string field')
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
): Promise<ResolvedCompositionCapability> => {
  const outputRoot = await realpath(input.nixOutputPath)
  const executablePath = await realpath(NodePath.join(outputRoot, input.capability.executable))
  const outputInfo = await stat(outputRoot)
  const executableInfo = await stat(executablePath)
  if (
    outputInfo.isDirectory() === false ||
    executableInfo.isFile() === false ||
    (executablePath !== outputRoot &&
      executablePath.startsWith(`${outputRoot}${NodePath.sep}`) === false)
  ) {
    throw new TypeError(`capability executable escapes its Nix output: ${input.capability.toolId}`)
  }
  await access(executablePath, 1)
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
  return {
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
  const resolved: ResolvedCompositionCapability[] = []
  for (const capability of input) resolved.push(await resolveNixProjectionInput(capability))
  await projectResolvedCapabilities({ projectionPath: outputPath, platform, resolved })
}

if (import.meta.main === true) await main()
