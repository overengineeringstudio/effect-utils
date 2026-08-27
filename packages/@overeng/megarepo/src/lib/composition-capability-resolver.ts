import { execFile as execFileCallback } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, lstat, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import * as NodePath from 'node:path'
import { promisify } from 'node:util'

import { Schema } from 'effect'

import {
  COMPOSITION_CAPABILITY_PROJECTOR_PATH,
  CompositionCapabilityResolutionError,
  CompositionCapabilitySystemSchema,
  type CompositionCapabilityCommand,
  type CompositionCapabilityPlan,
  type CompositionCapabilityResolution,
  type CompositionCapabilitySystem,
  type ResolvedCompositionCapability,
} from './composition-capability-resolver-schema.ts'
import {
  decodeBuckMemberManifest,
  type BuckMemberCapability,
  type BuckMemberManifest,
} from './generators/composition-root.ts'

const execFile = promisify(execFileCallback)
const strictParseOptions = { errors: 'all', onExcessProperty: 'error' } as const

/** Exact binaries used by Nix resolution and by every external command named by the projector. */
export interface CompositionCapabilityRuntime {
  readonly nixPath: string
  readonly bashPath: string
  readonly gawkPath: string
  readonly awkPath: string
  readonly grepPath: string
  readonly jqPath: string
  readonly mkdirPath: string
  readonly rmPath: string
  readonly mvPath: string
  readonly lnPath: string
  readonly readlinkPath: string
  readonly dirnamePath: string
  readonly basenamePath: string
  readonly sha256Path: string
  readonly sortPath: string
  readonly xargsPath: string
  readonly findPath: string
  readonly flockPath: string
  readonly diffPath: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly nonce?: () => string
}

/** Strict member, platform, scratch ownership, and pinned runtime resolver input. */
export interface ResolveCompositionCapabilitiesInput {
  readonly memberRoot: string
  readonly scratchRoot: string
  readonly system: CompositionCapabilitySystem
  readonly manifest: BuckMemberManifest | unknown
  readonly dryRun: boolean
  readonly runtime: CompositionCapabilityRuntime
}

/** Validated dry-run plan or completed scratch projection. */
export type ResolveCompositionCapabilitiesResult =
  | CompositionCapabilityPlan
  | CompositionCapabilityResolution

const runtimeEnvironmentNames = {
  nixPath: 'MR_CAPABILITY_NIX_BIN',
  bashPath: 'MR_CAPABILITY_BASH_BIN',
  gawkPath: 'MR_CAPABILITY_GAWK_BIN',
  awkPath: 'MR_CAPABILITY_AWK_BIN',
  grepPath: 'MR_CAPABILITY_GREP_BIN',
  jqPath: 'MR_CAPABILITY_JQ_BIN',
  mkdirPath: 'MR_CAPABILITY_MKDIR_BIN',
  rmPath: 'MR_CAPABILITY_RM_BIN',
  mvPath: 'MR_CAPABILITY_MV_BIN',
  lnPath: 'MR_CAPABILITY_LN_BIN',
  readlinkPath: 'MR_CAPABILITY_READLINK_BIN',
  dirnamePath: 'MR_CAPABILITY_DIRNAME_BIN',
  basenamePath: 'MR_CAPABILITY_BASENAME_BIN',
  sha256Path: 'MR_CAPABILITY_SHA256_BIN',
  sortPath: 'MR_CAPABILITY_SORT_BIN',
  xargsPath: 'MR_CAPABILITY_XARGS_BIN',
  findPath: 'MR_CAPABILITY_FIND_BIN',
  flockPath: 'MR_CAPABILITY_FLOCK_BIN',
  diffPath: 'MR_CAPABILITY_DIFF_BIN',
} as const satisfies Record<keyof Omit<CompositionCapabilityRuntime, 'env' | 'nonce'>, string>

type RuntimePathKey = keyof typeof runtimeEnvironmentNames

const requiredRuntimePath = ({
  env,
  name,
}: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly name: string
}): string => {
  const value = env[name]
  if (value === undefined || value.length === 0) {
    throw new CompositionCapabilityResolutionError({
      reason: 'InvalidRuntime',
      message: `Missing pinned capability runtime path in ${name}`,
    })
  }
  return value
}

/** Runtime config injected by the Nix wrapper. Missing tools fail closed; PATH is never consulted. */
export const compositionCapabilityRuntimeFromEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): CompositionCapabilityRuntime => ({
  nixPath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.nixPath }),
  bashPath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.bashPath }),
  gawkPath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.gawkPath }),
  awkPath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.awkPath }),
  grepPath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.grepPath }),
  jqPath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.jqPath }),
  mkdirPath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.mkdirPath }),
  rmPath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.rmPath }),
  mvPath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.mvPath }),
  lnPath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.lnPath }),
  readlinkPath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.readlinkPath }),
  dirnamePath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.dirnamePath }),
  basenamePath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.basenamePath }),
  sha256Path: requiredRuntimePath({ env, name: runtimeEnvironmentNames.sha256Path }),
  sortPath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.sortPath }),
  xargsPath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.xargsPath }),
  findPath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.findPath }),
  flockPath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.flockPath }),
  diffPath: requiredRuntimePath({ env, name: runtimeEnvironmentNames.diffPath }),
})

const invalidInput = ({
  message,
  path,
  cause,
}: {
  readonly message: string
  readonly path?: string
  readonly cause?: unknown
}) =>
  new CompositionCapabilityResolutionError({
    reason: 'InvalidInput',
    message,
    ...(path === undefined ? {} : { path }),
    ...(cause === undefined ? {} : { cause }),
  })

const assertAbsoluteNormalized = ({
  value,
  name,
}: {
  readonly value: string
  readonly name: string
}): void => {
  if (NodePath.isAbsolute(value) === false || NodePath.normalize(value) !== value) {
    throw invalidInput({ message: `${name} must be a normalized absolute path`, path: value })
  }
}

const containedBy = ({ root, path }: { readonly root: string; readonly path: string }): boolean =>
  path === root || path.startsWith(`${root}${NodePath.sep}`) === true

const platformFor = (system: CompositionCapabilitySystem) => {
  switch (system) {
    case 'x86_64-linux':
      return 'x86_64-linux' as const
    case 'aarch64-linux':
      return 'aarch64-linux' as const
    case 'aarch64-darwin':
      return 'aarch64-macos' as const
  }
}

const command = ({
  executable,
  args,
}: {
  readonly executable: string
  readonly args: ReadonlyArray<string>
}): CompositionCapabilityCommand => ({
  executable,
  args: [...args],
})

const commandFailure = ({
  value,
  message,
  reason = 'CommandFailure',
  cause,
}: {
  readonly value: CompositionCapabilityCommand
  readonly message: string
  readonly reason?: 'CommandFailure' | 'ProjectionFailure'
  readonly cause: unknown
}) =>
  new CompositionCapabilityResolutionError({
    reason,
    message,
    command: value,
    cause,
  })

const run = async ({
  value,
  env,
  reason,
}: {
  readonly value: CompositionCapabilityCommand
  readonly env: NodeJS.ProcessEnv
  readonly reason?: 'CommandFailure' | 'ProjectionFailure'
}): Promise<{ readonly stdout: string; readonly stderr: string }> => {
  try {
    return await execFile(value.executable, [...value.args], {
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024,
    })
  } catch (cause) {
    throw commandFailure({
      value,
      message: `Exact command failed: ${value.executable} ${value.args.join(' ')}`,
      ...(reason === undefined ? {} : { reason }),
      cause,
    })
  }
}

const assertExecutable = async ({
  path,
  name,
}: {
  readonly path: string
  readonly name: string
}) => {
  assertAbsoluteNormalized({ value: path, name })
  try {
    const info = await stat(path)
    if (info.isFile() === false) throw new Error('not a regular file')
    await access(path, 1)
  } catch (cause) {
    throw new CompositionCapabilityResolutionError({
      reason: 'InvalidRuntime',
      message: `${name} is not a regular executable file`,
      path,
      cause,
    })
  }
}

const validateRuntime = async (runtime: CompositionCapabilityRuntime): Promise<void> => {
  await Promise.all(
    (Object.keys(runtimeEnvironmentNames) as ReadonlyArray<RuntimePathKey>).map((key) =>
      assertExecutable({ path: runtime[key], name: key }),
    ),
  )
}

const validateRootsAndProjector = async ({
  memberRoot,
  scratchRoot,
}: {
  readonly memberRoot: string
  readonly scratchRoot: string
}): Promise<{
  readonly memberRoot: string
  readonly scratchRoot: string
  readonly projectorPath: string
}> => {
  assertAbsoluteNormalized({ value: memberRoot, name: 'memberRoot' })
  assertAbsoluteNormalized({ value: scratchRoot, name: 'scratchRoot' })
  try {
    const [canonicalMemberRoot, canonicalScratchRoot] = await Promise.all([
      realpath(memberRoot),
      realpath(scratchRoot),
    ])
    const [memberInfo, scratchInfo] = await Promise.all([
      stat(canonicalMemberRoot),
      stat(canonicalScratchRoot),
    ])
    if (memberInfo.isDirectory() === false || scratchInfo.isDirectory() === false) {
      throw new Error('memberRoot and scratchRoot must be directories')
    }
    const declaredProjectorPath = NodePath.join(
      canonicalMemberRoot,
      COMPOSITION_CAPABILITY_PROJECTOR_PATH,
    )
    const projectorInfo = await lstat(declaredProjectorPath)
    if (projectorInfo.isFile() === false) throw new Error('projector is not a regular tracked file')
    const projectorPath = await realpath(declaredProjectorPath)
    if (containedBy({ root: canonicalMemberRoot, path: projectorPath }) === false) {
      throw new Error('projector escapes member root')
    }
    return {
      memberRoot: canonicalMemberRoot,
      scratchRoot: canonicalScratchRoot,
      projectorPath,
    }
  } catch (cause) {
    throw new CompositionCapabilityResolutionError({
      reason: 'MissingProjector',
      message: `Member must contain regular tracked projector '${COMPOSITION_CAPABILITY_PROJECTOR_PATH}'`,
      path: NodePath.join(memberRoot, COMPOSITION_CAPABILITY_PROJECTOR_PATH),
      cause,
    })
  }
}

const executableDigest = async (path: string): Promise<`sha256:${string}`> => {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return `sha256:${hash.digest('hex')}`
}

const singleNixOutput = ({
  stdout,
  capability,
  value,
}: {
  readonly stdout: string
  readonly capability: BuckMemberCapability
  readonly value: CompositionCapabilityCommand
}): string => {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0)
  if (lines.length !== 1 || /^\/nix\/store\/[^/\s]+$/u.test(lines[0] ?? '') === false) {
    throw new CompositionCapabilityResolutionError({
      reason: 'InvalidNixOutput',
      message: `Nix must return exactly one /nix/store output for capability '${capability.toolId}'`,
      command: value,
    })
  }
  return lines[0]!
}

const resolveCapability = async ({
  capability,
  nixCommand,
  env,
}: {
  readonly capability: BuckMemberCapability
  readonly nixCommand: CompositionCapabilityCommand
  readonly env: NodeJS.ProcessEnv
}): Promise<ResolvedCompositionCapability> => {
  const { stdout } = await run({ value: nixCommand, env })
  const nixOutputPath = singleNixOutput({ stdout, capability, value: nixCommand })
  const declaredExecutable = NodePath.join(nixOutputPath, capability.executable)
  try {
    const [canonicalOutput, outputInfo, executableInfo] = await Promise.all([
      realpath(nixOutputPath),
      stat(nixOutputPath),
      stat(declaredExecutable),
    ])
    if (outputInfo.isDirectory() === false || executableInfo.isFile() === false) {
      throw new Error('output must be a directory and executable must be a regular file')
    }
    await access(declaredExecutable, 1)
    const executablePath = await realpath(declaredExecutable)
    if (containedBy({ root: canonicalOutput, path: executablePath }) === false) {
      throw new Error('executable realpath escapes its exact Nix output')
    }
    return {
      capability,
      nixOutputPath,
      executablePath,
      executableDigest: await executableDigest(executablePath),
    }
  } catch (cause) {
    throw new CompositionCapabilityResolutionError({
      reason: 'InvalidExecutable',
      message: `Capability '${capability.toolId}' does not provide a contained regular executable '${capability.executable}'`,
      path: declaredExecutable,
      cause,
    })
  }
}

const resolveCapabilitiesInOrder = ({
  capabilities,
  nixCommands,
  env,
}: {
  readonly capabilities: ReadonlyArray<BuckMemberCapability>
  readonly nixCommands: ReadonlyArray<CompositionCapabilityCommand>
  readonly env: NodeJS.ProcessEnv
}): Promise<Array<ResolvedCompositionCapability>> => {
  const resolved = [] as Array<ResolvedCompositionCapability>
  const next = (index: number): Promise<Array<ResolvedCompositionCapability>> => {
    const capability = capabilities[index]
    if (capability === undefined) return Promise.resolve(resolved)
    return resolveCapability({ capability, nixCommand: nixCommands[index]!, env }).then((value) => {
      resolved.push(value)
      return next(index + 1)
    })
  }
  return next(0)
}

const projectorEnv = (runtime: CompositionCapabilityRuntime): NodeJS.ProcessEnv => ({
  ...process.env,
  ...runtime.env,
  GAWK_BIN: runtime.gawkPath,
  AWK_BIN: runtime.awkPath,
  GREP_BIN: runtime.grepPath,
  JQ_BIN: runtime.jqPath,
  MKDIR_BIN: runtime.mkdirPath,
  RM_BIN: runtime.rmPath,
  MV_BIN: runtime.mvPath,
  LN_BIN: runtime.lnPath,
  READLINK_BIN: runtime.readlinkPath,
  DIRNAME_BIN: runtime.dirnamePath,
  BASENAME_BIN: runtime.basenamePath,
  SHA256_BIN: runtime.sha256Path,
  SORT_BIN: runtime.sortPath,
  XARGS_BIN: runtime.xargsPath,
  FIND_BIN: runtime.findPath,
  FLOCK_BIN: runtime.flockPath,
  DIFF_BIN: runtime.diffPath,
})

const plannedOutput = (capability: BuckMemberCapability): string =>
  `/nix/store/${'0'.repeat(32)}-planned-${capability.toolId}/${capability.executable}`

const projectionDigest = async (projectionPath: string): Promise<string> => {
  const defs = await readFile(NodePath.join(projectionPath, 'defs.bzl'), 'utf8')
  const matches = [...defs.matchAll(/^GENERATION = "([0-9a-f]{64})"$/gmu)]
  if (matches.length !== 1) {
    throw new CompositionCapabilityResolutionError({
      reason: 'ProjectionFailure',
      message: 'Checked projection does not declare exactly one valid GENERATION',
      path: NodePath.join(projectionPath, 'defs.bzl'),
    })
  }
  return matches[0]![1]!
}

/**
 * Resolve and project one strict tracked member manifest without ever writing into the member.
 * On failure only this call's candidate below `scratchRoot` is removed.
 */
export const resolveCompositionCapabilities = async (
  input: ResolveCompositionCapabilitiesInput,
): Promise<ResolveCompositionCapabilitiesResult> => {
  let candidateRoot: string | undefined
  let candidateOwned = false
  try {
    const manifest = decodeBuckMemberManifest(input.manifest)
    const system = Schema.decodeUnknownSync(
      CompositionCapabilitySystemSchema,
      strictParseOptions,
    )(input.system)
    await validateRuntime(input.runtime)
    const roots = await validateRootsAndProjector(input)
    const capabilities = [...manifest.capabilities].toSorted((left, right) =>
      left.toolId < right.toolId ? -1 : left.toolId > right.toolId ? 1 : 0,
    )
    const nonce = (input.runtime.nonce ?? randomUUID)()
    if (/^[A-Za-z0-9._-]+$/u.test(nonce) === false) {
      throw invalidInput({
        message: 'runtime nonce must contain only portable filename characters',
      })
    }
    candidateRoot = NodePath.join(roots.scratchRoot, `.megarepo-capabilities-${nonce}`)
    const projectorPlatform = platformFor(system)
    const nixCommands = capabilities.map((capability) =>
      command({
        executable: input.runtime.nixPath,
        args: [
          'build',
          '--no-link',
          '--print-out-paths',
          `${roots.memberRoot}#${capability.flakePackage}`,
        ],
      }),
    )
    const plannedProjectorCommand = command({
      executable: input.runtime.bashPath,
      args: [
        roots.projectorPath,
        candidateRoot,
        projectorPlatform,
        ...capabilities.flatMap((capability) => [
          capability.toolId,
          capability.protocol,
          plannedOutput(capability),
        ]),
      ],
    })
    if (input.dryRun === true) {
      return {
        _tag: 'Planned',
        system,
        projectorPlatform,
        projectorPath: roots.projectorPath,
        candidateRoot,
        nixCommands,
        projectorCommand: plannedProjectorCommand,
      }
    }

    await mkdir(candidateRoot)
    candidateOwned = true
    const env: NodeJS.ProcessEnv = { ...process.env, ...input.runtime.env }
    const resolved = await resolveCapabilitiesInOrder({ capabilities, nixCommands, env })
    const projectorCommand = command({
      executable: input.runtime.bashPath,
      args: [
        roots.projectorPath,
        candidateRoot,
        projectorPlatform,
        ...resolved.flatMap(({ capability, executablePath }) => [
          capability.toolId,
          capability.protocol,
          executablePath,
        ]),
      ],
    })
    await run({
      value: projectorCommand,
      env: projectorEnv(input.runtime),
      reason: 'ProjectionFailure',
    })
    const checkCommand = command({
      executable: input.runtime.bashPath,
      args: [roots.projectorPath, '--check', candidateRoot],
    })
    await run({
      value: checkCommand,
      env: projectorEnv(input.runtime),
      reason: 'ProjectionFailure',
    })
    const projectionPath = NodePath.join(candidateRoot, '.buck2', 'capabilities')
    const digest = await projectionDigest(projectionPath)
    return {
      _tag: 'Resolved',
      system,
      projectorPlatform,
      projectorPath: roots.projectorPath,
      candidateRoot,
      projectionPath,
      projectionDigest: digest,
      capabilities: resolved,
      capabilitiesByToolId: Object.fromEntries(
        resolved.map((capability) => [capability.capability.toolId, capability]),
      ),
      nixCommands,
      projectorCommand,
      checkCommand,
    }
  } catch (cause) {
    if (candidateOwned === true && candidateRoot !== undefined) {
      await rm(candidateRoot, { recursive: true, force: true })
    }
    if (cause instanceof CompositionCapabilityResolutionError) throw cause
    throw invalidInput({ message: 'Invalid composition capability resolver input', cause })
  }
}

/** Fail-closed resolved capability lookup used by Buck/tool consumers. */
export const resolvedCompositionCapabilityByToolId = ({
  resolution,
  toolId,
}: {
  readonly resolution: CompositionCapabilityResolution
  readonly toolId: string
}): ResolvedCompositionCapability => {
  const capability = resolution.capabilitiesByToolId[toolId]
  if (capability === undefined) {
    throw invalidInput({ message: `Resolved capability '${toolId}' is absent` })
  }
  return capability
}
