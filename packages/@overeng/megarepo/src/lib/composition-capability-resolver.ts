import { execFile as execFileCallback } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { access, chmod, lstat, mkdir, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
  /** Deterministic interruption seam after private candidate creation and identity capture. */
  readonly afterCandidateCreated?: (candidateRoot: string) => Promise<void>
  /** Deterministic seam immediately before projection identity capture and digesting. */
  readonly beforeProjectionDigest?: (input: {
    readonly candidateRoot: string
    readonly projectionPath: string
  }) => Promise<void>
  /** Test seam. The returned private root and cleanup capability are resolver-owned. */
  readonly createPrivateScratch?: () => Promise<CompositionCapabilityPrivateScratch>
}

/** Resolver-owned private scratch capability. Callers may inject creation, never a mutable path. */
export interface CompositionCapabilityPrivateScratch {
  readonly path: string
  readonly cleanup: () => Promise<void>
}

/** Realized resolution handle. `release` destroys the resolver-owned private scratch tree. */
export interface CompositionCapabilityResolutionHandle extends CompositionCapabilityResolution {
  readonly release: () => Promise<void>
}

/** Strict member, platform, scratch ownership, and pinned runtime resolver input. */
export interface ResolveCompositionCapabilitiesInput {
  readonly memberRoot: string
  readonly system: CompositionCapabilitySystem
  readonly manifest: BuckMemberManifest | unknown
  readonly dryRun: boolean
  readonly runtime: CompositionCapabilityRuntime
}

/** Validated dry-run plan or completed scratch projection. */
export type ResolveCompositionCapabilitiesResult =
  | CompositionCapabilityPlan
  | CompositionCapabilityResolutionHandle

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
} as const satisfies Record<
  keyof Omit<
    CompositionCapabilityRuntime,
    'env' | 'nonce' | 'afterCandidateCreated' | 'beforeProjectionDigest' | 'createPrivateScratch'
  >,
  string
>

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

interface RegularFileIdentity {
  readonly path: string
  readonly realpath: string
  readonly device: number
  readonly inode: number
  readonly digest: string
}

const captureContainedRegularFile = async ({
  root,
  path,
  label,
}: {
  readonly root: string
  readonly path: string
  readonly label: string
}): Promise<RegularFileIdentity> => {
  let handle
  try {
    const pathInfo = await lstat(path)
    const canonicalPath = await realpath(path)
    if (
      pathInfo.isFile() === false ||
      pathInfo.isSymbolicLink() === true ||
      containedBy({ root, path: canonicalPath }) === false
    ) {
      throw invalidInput({ message: `${label} must be a contained regular file`, path })
    }
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat()
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (
      before.isFile() === false ||
      before.dev !== pathInfo.dev ||
      before.ino !== pathInfo.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw invalidInput({ message: `${label} identity changed while reading`, path })
    }
    return {
      path,
      realpath: canonicalPath,
      device: before.dev,
      inode: before.ino,
      digest: createHash('sha256').update(bytes).digest('hex'),
    }
  } finally {
    await handle?.close()
  }
}

const assertRegularFileIdentity = async (identity: RegularFileIdentity): Promise<void> => {
  try {
    const current = await captureContainedRegularFile({
      root: NodePath.dirname(identity.realpath),
      path: identity.path,
      label: 'flake.lock',
    })
    if (
      current.realpath !== identity.realpath ||
      current.device !== identity.device ||
      current.inode !== identity.inode ||
      current.digest !== identity.digest
    ) {
      throw new TypeError('flake.lock identity changed')
    }
  } catch (cause) {
    throw new CompositionCapabilityResolutionError({
      reason: 'InvalidLock',
      message: 'flake.lock bytes or inode changed during capability resolution',
      path: identity.path,
      cause,
    })
  }
}

const validateMemberAndProjector = async ({
  memberRoot,
}: {
  readonly memberRoot: string
}): Promise<{
  readonly memberRoot: string
  readonly projectorPath: string
  readonly lock: RegularFileIdentity
}> => {
  assertAbsoluteNormalized({ value: memberRoot, name: 'memberRoot' })
  let canonicalMemberRoot: string
  let projectorPath: string
  try {
    canonicalMemberRoot = await realpath(memberRoot)
    if ((await stat(canonicalMemberRoot)).isDirectory() === false) {
      throw new TypeError('memberRoot must be a directory')
    }
    const declaredProjectorPath = NodePath.join(
      canonicalMemberRoot,
      COMPOSITION_CAPABILITY_PROJECTOR_PATH,
    )
    const projectorInfo = await lstat(declaredProjectorPath)
    if (projectorInfo.isFile() === false || projectorInfo.isSymbolicLink() === true) {
      throw new TypeError('projector is not a regular tracked file')
    }
    projectorPath = await realpath(declaredProjectorPath)
    if (containedBy({ root: canonicalMemberRoot, path: projectorPath }) === false) {
      throw new TypeError('projector escapes member root')
    }
  } catch (cause) {
    throw new CompositionCapabilityResolutionError({
      reason: 'MissingProjector',
      message: `Member must contain regular tracked projector '${COMPOSITION_CAPABILITY_PROJECTOR_PATH}'`,
      path: NodePath.join(memberRoot, COMPOSITION_CAPABILITY_PROJECTOR_PATH),
      cause,
    })
  }
  try {
    const lock = await captureContainedRegularFile({
      root: canonicalMemberRoot,
      path: NodePath.join(canonicalMemberRoot, 'flake.lock'),
      label: 'flake.lock',
    })
    return { memberRoot: canonicalMemberRoot, projectorPath, lock }
  } catch (cause) {
    throw new CompositionCapabilityResolutionError({
      reason: 'InvalidLock',
      message: 'Member must contain a regular, contained, immutable flake.lock',
      path: NodePath.join(canonicalMemberRoot, 'flake.lock'),
      cause,
    })
  }
}

interface DirectoryIdentity {
  readonly path: string
  readonly realpath: string
  readonly device: number
  readonly inode: number
  readonly owner: number
}

type CandidateRootIdentity = DirectoryIdentity

type PrivateScratchIdentity = DirectoryIdentity

const candidateReplaced = ({ path, cause }: { readonly path: string; readonly cause?: unknown }) =>
  new CompositionCapabilityResolutionError({
    reason: 'CandidateReplaced',
    message: `Capability projection candidate ownership changed at '${path}'`,
    path,
    ...(cause === undefined ? {} : { cause }),
  })

const currentUid = (): number => {
  const uid = process.getuid?.()
  if (uid === undefined) {
    throw new CompositionCapabilityResolutionError({
      reason: 'InvalidRuntime',
      message: 'Capability resolution requires a POSIX process uid',
    })
  }
  return uid
}

const assertSecureParent = async ({
  path,
  uid,
}: {
  readonly path: string
  readonly uid: number
}) => {
  const parent = NodePath.dirname(path)
  const info = await lstat(parent)
  const sticky = (info.mode & 0o1000) !== 0
  const ownerPrivate = info.uid === uid && (info.mode & 0o022) === 0
  if (
    info.isDirectory() === false ||
    info.isSymbolicLink() === true ||
    (sticky === false && ownerPrivate === false)
  ) {
    throw new Error(`private scratch parent is neither sticky nor owner-private: ${parent}`)
  }
}

const defaultCreatePrivateScratch = async (): Promise<CompositionCapabilityPrivateScratch> => {
  const uid = currentUid()
  const tempRoot = await realpath(tmpdir())
  await assertSecureParent({ path: NodePath.join(tempRoot, 'entry'), uid })
  const path = await mkdtemp(NodePath.join(tempRoot, 'megarepo-capabilities-'))
  await chmod(path, 0o700)
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) }
}

const capturePrivateScratchIdentity = async (
  scratch: CompositionCapabilityPrivateScratch,
): Promise<PrivateScratchIdentity> => {
  assertAbsoluteNormalized({ value: scratch.path, name: 'private scratch path' })
  try {
    const uid = currentUid()
    const info = await lstat(scratch.path)
    const canonicalPath = await realpath(scratch.path)
    await assertSecureParent({ path: scratch.path, uid })
    if (
      info.isDirectory() === false ||
      info.isSymbolicLink() === true ||
      (info.mode & 0o777) !== 0o700 ||
      info.uid !== uid ||
      canonicalPath !== scratch.path
    ) {
      throw new Error('private scratch is not a canonical mode-0700 directory owned by this uid')
    }
    return {
      path: scratch.path,
      realpath: canonicalPath,
      device: info.dev,
      inode: info.ino,
      owner: info.uid,
    }
  } catch (cause) {
    throw candidateReplaced({ path: scratch.path, cause })
  }
}

const captureCandidateRootIdentity = async ({
  path,
  scratch,
}: {
  readonly path: string
  readonly scratch: PrivateScratchIdentity
}): Promise<CandidateRootIdentity> => {
  try {
    const info = await lstat(path)
    const canonicalPath = await realpath(path)
    if (
      info.isDirectory() === false ||
      info.isSymbolicLink() === true ||
      (info.mode & 0o777) !== 0o700 ||
      info.uid !== scratch.owner ||
      containedBy({ root: scratch.realpath, path: canonicalPath }) === false
    ) {
      throw new Error('candidate is not a private contained directory')
    }
    return {
      path,
      realpath: canonicalPath,
      device: info.dev,
      inode: info.ino,
      owner: info.uid,
    }
  } catch (cause) {
    throw candidateReplaced({ path, cause })
  }
}

const assertDirectoryIdentity = async (identity: DirectoryIdentity): Promise<void> => {
  try {
    const info = await lstat(identity.path)
    const canonicalPath = await realpath(identity.path)
    if (
      info.isDirectory() === false ||
      info.isSymbolicLink() === true ||
      (info.mode & 0o777) !== 0o700 ||
      info.dev !== identity.device ||
      info.ino !== identity.inode ||
      info.uid !== identity.owner ||
      canonicalPath !== identity.realpath
    ) {
      throw new Error('directory identity no longer matches its captured inode')
    }
  } catch (cause) {
    throw candidateReplaced({ path: identity.path, cause })
  }
}

const makeScratchRelease = ({
  scratch,
  identity,
}: {
  readonly scratch: CompositionCapabilityPrivateScratch
  readonly identity: PrivateScratchIdentity
}): (() => Promise<void>) => {
  let released = false
  return async () => {
    if (released === true) return
    await assertDirectoryIdentity(identity)
    await scratch.cleanup()
    released = true
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
  lock,
}: {
  readonly capability: BuckMemberCapability
  readonly nixCommand: CompositionCapabilityCommand
  readonly env: NodeJS.ProcessEnv
  readonly lock: RegularFileIdentity
}): Promise<ResolvedCompositionCapability> => {
  const { stdout } = await run({ value: nixCommand, env }).finally(() =>
    assertRegularFileIdentity(lock),
  )
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
  lock,
}: {
  readonly capabilities: ReadonlyArray<BuckMemberCapability>
  readonly nixCommands: ReadonlyArray<CompositionCapabilityCommand>
  readonly env: NodeJS.ProcessEnv
  readonly lock: RegularFileIdentity
}): Promise<Array<ResolvedCompositionCapability>> => {
  const resolved = [] as Array<ResolvedCompositionCapability>
  const next = (index: number): Promise<Array<ResolvedCompositionCapability>> => {
    const capability = capabilities[index]
    if (capability === undefined) return Promise.resolve(resolved)
    return resolveCapability({ capability, nixCommand: nixCommands[index]!, env, lock }).then(
      (value) => {
        resolved.push(value)
        return next(index + 1)
      },
    )
  }
  return next(0)
}

const safeNixEnvironment = ({
  runtime,
  privateRoot,
}: {
  readonly runtime: CompositionCapabilityRuntime
  readonly privateRoot: string
}): NodeJS.ProcessEnv => {
  const source = runtime.env ?? {}
  return {
    HOME: privateRoot,
    TMPDIR: privateRoot,
    ...(source['NIX_SSL_CERT_FILE'] === undefined
      ? {}
      : { NIX_SSL_CERT_FILE: source['NIX_SSL_CERT_FILE'] }),
    ...(source['SSL_CERT_FILE'] === undefined ? {} : { SSL_CERT_FILE: source['SSL_CERT_FILE'] }),
  }
}

/** Secret-free environment for tracked projector execution. */
export const compositionCapabilityProjectorEnvironment = ({
  runtime,
  privateRoot,
}: {
  readonly runtime: CompositionCapabilityRuntime
  readonly privateRoot: string
}): NodeJS.ProcessEnv => ({
  ...safeNixEnvironment({ runtime, privateRoot }),
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

interface ProjectionIdentity {
  readonly path: string
  readonly realpath: string
  readonly device: number
  readonly inode: number
}

const captureProjectionIdentity = async ({
  projectionPath,
  candidate,
}: {
  readonly projectionPath: string
  readonly candidate: CandidateRootIdentity
}): Promise<ProjectionIdentity> => {
  try {
    const info = await lstat(projectionPath)
    const canonicalPath = await realpath(projectionPath)
    if (
      info.isDirectory() === false ||
      info.isSymbolicLink() === true ||
      containedBy({ root: candidate.realpath, path: canonicalPath }) === false
    ) {
      throw new Error('projection is not a real directory contained by the candidate')
    }
    return {
      path: projectionPath,
      realpath: canonicalPath,
      device: info.dev,
      inode: info.ino,
    }
  } catch (cause) {
    throw new CompositionCapabilityResolutionError({
      reason: 'ProjectionFailure',
      message: 'Checked projection directory identity is invalid',
      path: projectionPath,
      cause,
    })
  }
}

const assertProjectionIdentity = async (identity: ProjectionIdentity): Promise<void> => {
  try {
    const info = await lstat(identity.path)
    const canonicalPath = await realpath(identity.path)
    if (
      info.isDirectory() === false ||
      info.isSymbolicLink() === true ||
      info.dev !== identity.device ||
      info.ino !== identity.inode ||
      canonicalPath !== identity.realpath
    ) {
      throw new Error('projection identity changed')
    }
  } catch (cause) {
    throw new CompositionCapabilityResolutionError({
      reason: 'ProjectionFailure',
      message: 'Checked projection directory was replaced while digesting',
      path: identity.path,
      cause,
    })
  }
}

const projectionDigest = async ({
  projection,
  candidate,
}: {
  readonly projection: ProjectionIdentity
  readonly candidate: CandidateRootIdentity
}): Promise<string> => {
  await assertDirectoryIdentity(candidate)
  await assertProjectionIdentity(projection)
  const defsPath = NodePath.join(projection.path, 'defs.bzl')
  let handle
  try {
    const pathInfo = await lstat(defsPath)
    const canonicalPath = await realpath(defsPath)
    if (
      pathInfo.isFile() === false ||
      pathInfo.isSymbolicLink() === true ||
      containedBy({ root: projection.realpath, path: canonicalPath }) === false
    ) {
      throw new Error('defs.bzl is not a contained regular file')
    }
    handle = await open(defsPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const before = await handle.stat()
    const defs = await handle.readFile({ encoding: 'utf8' })
    const after = await handle.stat()
    if (
      before.isFile() === false ||
      before.dev !== pathInfo.dev ||
      before.ino !== pathInfo.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error('defs.bzl inode changed while reading')
    }
    const matches = [...defs.matchAll(/^GENERATION = "([0-9a-f]{64})"$/gmu)]
    if (matches.length !== 1) {
      throw new Error('defs.bzl does not declare exactly one valid GENERATION')
    }
    await assertProjectionIdentity(projection)
    await assertDirectoryIdentity(candidate)
    return matches[0]![1]!
  } catch (cause) {
    throw new CompositionCapabilityResolutionError({
      reason: 'ProjectionFailure',
      message: 'Checked projection could not be digested without following links',
      path: defsPath,
      cause,
    })
  } finally {
    await handle?.close()
  }
}

/**
 * Resolve and project one strict tracked member manifest without writing into the member.
 *
 * The resolver creates and owns a private scratch parent. Other processes running as the same uid
 * are inside the trust boundary; arbitrary caller-controlled workspace paths are not. A successful
 * handle retains the projection until `release` is called. Failures release only the captured
 * private scratch inode.
 */
export const resolveCompositionCapabilities = async (
  input: ResolveCompositionCapabilitiesInput,
): Promise<ResolveCompositionCapabilitiesResult> => {
  let release: (() => Promise<void>) | undefined
  try {
    const manifest = decodeBuckMemberManifest(input.manifest)
    const system = Schema.decodeUnknownSync(
      CompositionCapabilitySystemSchema,
      strictParseOptions,
    )(input.system)
    await validateRuntime(input.runtime)
    const roots = await validateMemberAndProjector(input)
    const capabilities = [...manifest.capabilities].toSorted((left, right) =>
      left.toolId < right.toolId ? -1 : left.toolId > right.toolId ? 1 : 0,
    )
    const nonce = (input.runtime.nonce ?? randomUUID)()
    if (/^[A-Za-z0-9._-]+$/u.test(nonce) === false) {
      throw invalidInput({
        message: 'runtime nonce must contain only portable filename characters',
      })
    }
    const plannedPrivateRoot = NodePath.join(
      NodePath.resolve(tmpdir()),
      `.megarepo-capabilities-planned-${nonce}`,
    )
    const plannedCandidateRoot = NodePath.join(plannedPrivateRoot, 'candidate')
    const projectorPlatform = platformFor(system)
    const nixCommands = capabilities.map((capability) =>
      command({
        executable: input.runtime.nixPath,
        args: [
          'build',
          '--no-link',
          '--print-out-paths',
          '--no-write-lock-file',
          '--no-update-lock-file',
          `${roots.memberRoot}#${capability.flakePackage}`,
        ],
      }),
    )
    const plannedProjectorCommand = command({
      executable: input.runtime.bashPath,
      args: [
        roots.projectorPath,
        plannedCandidateRoot,
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
        candidateRoot: plannedCandidateRoot,
        nixCommands,
        projectorCommand: plannedProjectorCommand,
      }
    }

    const scratch = await (input.runtime.createPrivateScratch ?? defaultCreatePrivateScratch)()
    const scratchIdentity = await capturePrivateScratchIdentity(scratch)
    release = makeScratchRelease({ scratch, identity: scratchIdentity })
    const env = safeNixEnvironment({ runtime: input.runtime, privateRoot: scratchIdentity.path })
    const resolved = await resolveCapabilitiesInOrder({
      capabilities,
      nixCommands,
      env,
      lock: roots.lock,
    })
    await assertRegularFileIdentity(roots.lock)
    const candidateRoot = NodePath.join(scratchIdentity.path, 'candidate')
    await mkdir(candidateRoot, { mode: 0o700 })
    const candidateIdentity = await captureCandidateRootIdentity({
      path: candidateRoot,
      scratch: scratchIdentity,
    })
    await input.runtime.afterCandidateCreated?.(candidateRoot)
    await assertDirectoryIdentity(scratchIdentity)
    await assertDirectoryIdentity(candidateIdentity)

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
    await assertDirectoryIdentity(candidateIdentity)
    await run({
      value: projectorCommand,
      env: compositionCapabilityProjectorEnvironment({
        runtime: input.runtime,
        privateRoot: scratchIdentity.path,
      }),
      reason: 'ProjectionFailure',
    })
    await assertDirectoryIdentity(candidateIdentity)
    const checkCommand = command({
      executable: input.runtime.bashPath,
      args: [roots.projectorPath, '--check', candidateRoot],
    })
    await assertDirectoryIdentity(candidateIdentity)
    await run({
      value: checkCommand,
      env: compositionCapabilityProjectorEnvironment({
        runtime: input.runtime,
        privateRoot: scratchIdentity.path,
      }),
      reason: 'ProjectionFailure',
    })
    await assertDirectoryIdentity(candidateIdentity)
    const projectionPath = NodePath.join(candidateRoot, '.buck2', 'capabilities')
    await input.runtime.beforeProjectionDigest?.({ candidateRoot, projectionPath })
    await assertDirectoryIdentity(candidateIdentity)
    const projection = await captureProjectionIdentity({
      projectionPath,
      candidate: candidateIdentity,
    })
    const digest = await projectionDigest({ projection, candidate: candidateIdentity })
    await assertRegularFileIdentity(roots.lock)
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
      release,
    }
  } catch (cause) {
    if (release !== undefined) {
      try {
        await release()
      } catch {
        // Refuse to invoke an injected cleanup after the captured private root was replaced.
      }
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
  readonly resolution: CompositionCapabilityResolutionHandle
  readonly toolId: string
}): ResolvedCompositionCapability => {
  const capability = resolution.capabilitiesByToolId[toolId]
  if (capability === undefined) {
    throw invalidInput({ message: `Resolved capability '${toolId}' is absent` })
  }
  return capability
}
