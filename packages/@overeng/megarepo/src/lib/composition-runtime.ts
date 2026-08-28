import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rm } from 'node:fs/promises'
import * as NodePath from 'node:path'

import {
  type CompositionApplyRuntime,
  type CompositionOverlayScratchRuntime,
} from './composition-apply.ts'
import {
  compositionCapabilityRuntimeFromEnv,
  type CompositionCapabilityRuntime,
} from './composition-capability-resolver.ts'
import { COMPOSITION_CAPABILITY_PROJECTOR_PATH } from './composition-capability-resolver-schema.ts'
import {
  installOwnedCapabilityProjection,
  planOwnedCapabilityProjection,
} from './owned-capability-projection.ts'
import { WORKSPACE_UPDATE_LOCK_PATH } from './workspace-update-lock-schema.ts'

export const compositionRuntimeEnvironmentNames = {
  cpPath: 'MR_COMPOSITION_CP_BIN',
  mvPath: 'MR_CAPABILITY_MV_BIN',
  buck2Path: 'MR_COMPOSITION_BUCK2_BIN',
  buck2Protocol: 'MR_COMPOSITION_BUCK2_PROTOCOL',
  system: 'MR_COMPOSITION_SYSTEM',
  platform: 'MR_COMPOSITION_PLATFORM',
} as const

const required = ({
  env,
  name,
}: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly name: string
}) => {
  const value = env[name]
  if (value === undefined || value.length === 0) {
    throw new TypeError(`Missing pinned composition runtime value in ${name}`)
  }
  return value
}

const normalizedAbsolute = ({ value, name }: { readonly value: string; readonly name: string }) => {
  if (NodePath.isAbsolute(value) === false || NodePath.normalize(value) !== value) {
    throw new TypeError(`${name} must be an exact normalized absolute path`)
  }
  return value
}

const run = ({
  executable,
  args,
  cwd,
  env,
  stdio = 'pipe',
}: {
  readonly executable: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly stdio?: 'pipe' | 'inherit'
}) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [...args], { cwd, env, stdio })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${executable} exited ${code ?? `from signal ${signal ?? 'unknown'}`}`))
    })
  })

const projectorEnvironment = ({
  runtime,
  env,
}: {
  readonly runtime: CompositionCapabilityRuntime
  readonly env: Readonly<Record<string, string | undefined>>
}): NodeJS.ProcessEnv => ({
  ...env,
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

const checkProjection = async ({
  memberRoot,
  capabilityRuntime,
  env,
}: {
  readonly memberRoot: string
  readonly capabilityRuntime: CompositionCapabilityRuntime
  readonly env: Readonly<Record<string, string | undefined>>
}) => {
  const projector = NodePath.join(memberRoot, COMPOSITION_CAPABILITY_PROJECTOR_PATH)
  const info = await lstat(projector)
  if (info.isFile() === false || info.isSymbolicLink() === true) {
    throw new TypeError(`Capability projector is not a tracked regular file: ${projector}`)
  }
  await run({
    executable: capabilityRuntime.bashPath,
    args: [projector, '--check', memberRoot],
    cwd: memberRoot,
    env: projectorEnvironment({ runtime: capabilityRuntime, env }),
  })
}

const overlayKey = ({
  memberKey,
  target,
  destination,
}: {
  readonly memberKey: string
  readonly target: string
  readonly destination: string
}) =>
  `${memberKey}-${createHash('sha256').update(`${target}\0${destination}`).digest('hex').slice(0, 24)}`

const overlayScratchRuntime = (workspaceRoot: string): CompositionOverlayScratchRuntime => {
  const pathFor = (input: {
    readonly workspaceRoot: string
    readonly memberKey: string
    readonly target: string
    readonly destination: string
  }) => {
    if (input.workspaceRoot !== workspaceRoot) {
      throw new TypeError('Overlay scratch workspace does not match its runtime authority')
    }
    return NodePath.join(
      workspaceRoot,
      '.megarepo',
      'overlay-scratch',
      overlayKey(input),
      'output',
    )
  }
  return {
    planOutputPath: pathFor,
    create: async (input) => {
      const outputPath = pathFor(input)
      const allocationRoot = NodePath.dirname(outputPath)
      await mkdir(NodePath.dirname(allocationRoot), { recursive: true })
      try {
        await lstat(allocationRoot)
        throw new TypeError(`Overlay scratch allocation already exists: ${allocationRoot}`)
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
      }
      await mkdir(allocationRoot)
      return {
        outputPath,
        cleanup: () => rm(allocationRoot, { recursive: true, force: true }),
      }
    },
  }
}

const assertUpdateLockOwned = async (workspaceRoot: string) => {
  const lockPath = NodePath.join(workspaceRoot, WORKSPACE_UPDATE_LOCK_PATH)
  const parsed = JSON.parse(await readFile(lockPath, 'utf8')) as {
    readonly schema?: unknown
    readonly token?: unknown
    readonly pid?: unknown
  }
  if (
    parsed.schema !== 1 ||
    typeof parsed.token !== 'string' ||
    /^[0-9a-f]{32}$/u.test(parsed.token) === false ||
    parsed.pid !== process.pid
  ) {
    throw new TypeError(`Workspace update lock is not owned by this process: ${lockPath}`)
  }
}

/**
 * Construct the complete production composition runtime from Nix-wrapper injected identities.
 * No command path or platform value falls back to PATH or host inference.
 */
export const compositionApplyRuntimeFromEnv = ({
  workspaceRoot: rawWorkspaceRoot,
  env = process.env,
}: {
  readonly workspaceRoot: string
  readonly env?: Readonly<Record<string, string | undefined>>
}): CompositionApplyRuntime => {
  const workspaceRoot = normalizedAbsolute({ value: rawWorkspaceRoot, name: 'workspaceRoot' })
  const capabilityRuntime = compositionCapabilityRuntimeFromEnv(env)
  const cpPath = normalizedAbsolute({
    value: required({ env, name: compositionRuntimeEnvironmentNames.cpPath }),
    name: compositionRuntimeEnvironmentNames.cpPath,
  })
  const mvPath = normalizedAbsolute({
    value: required({ env, name: compositionRuntimeEnvironmentNames.mvPath }),
    name: compositionRuntimeEnvironmentNames.mvPath,
  })
  const buck2Path = normalizedAbsolute({
    value: required({ env, name: compositionRuntimeEnvironmentNames.buck2Path }),
    name: compositionRuntimeEnvironmentNames.buck2Path,
  })
  const buck2Protocol = required({ env, name: compositionRuntimeEnvironmentNames.buck2Protocol })
  const system = required({ env, name: compositionRuntimeEnvironmentNames.system })
  const platform = required({ env, name: compositionRuntimeEnvironmentNames.platform })
  if (system !== 'x86_64-linux' && system !== 'aarch64-linux' && system !== 'aarch64-darwin') {
    throw new TypeError(`Unsupported pinned composition system '${system}'`)
  }
  if (platform !== 'linux' && platform !== 'darwin') {
    throw new TypeError(`Unsupported pinned composition platform '${platform}'`)
  }
  if (
    (platform === 'darwin' && system !== 'aarch64-darwin') ||
    (platform === 'linux' && system === 'aarch64-darwin')
  ) {
    throw new TypeError(`Pinned composition platform '${platform}' disagrees with '${system}'`)
  }

  const check = (memberRoot: string) => checkProjection({ memberRoot, capabilityRuntime, env })
  const nonce = () => randomBytes(16).toString('hex')
  return {
    ownedCapabilityProjection: {
      plan: planOwnedCapabilityProjection,
      install: (input) =>
        installOwnedCapabilityProjection({
          ...input,
          runtime: { cpPath, mvPath, nonce },
        }),
    },
    system,
    platform,
    buck2Path,
    buck2Protocol,
    capabilityRuntime: { ...capabilityRuntime, nonce },
    mountRuntime: {
      cpPath,
      mvPath,
      platform,
      nonce,
      capabilityCheck: async ({ stagePath, capabilitiesPath }) => {
        if (capabilitiesPath !== NodePath.join(stagePath, '.buck2', 'capabilities')) {
          throw new TypeError('Mount capability path is outside its private stage')
        }
        await check(stagePath)
      },
    },
    mountRecoveryRuntime: { mvPath, platform },
    publisherRuntime: {
      assertCapabilityProjection: ({ memberRoot }) => check(memberRoot),
    },
    publisherLock: {
      owner: `mr:${process.pid}`,
      token: nonce(),
    },
    overlayRuntime: {
      assertUpdateLockOwned: ({ workspaceRoot: requestedRoot }) => {
        if (requestedRoot !== workspaceRoot) {
          throw new TypeError('Overlay workspace does not match its runtime authority')
        }
        return assertUpdateLockOwned(workspaceRoot)
      },
      nonce,
    },
    overlayScratch: overlayScratchRuntime(workspaceRoot),
    updateLockRuntime: { token: nonce },
    runBuck: (argv) => {
      if (argv[0] !== buck2Path) {
        throw new TypeError('Composition requested a Buck executable outside the pinned runtime')
      }
      return run({
        executable: argv[0],
        args: argv.slice(1),
        cwd: workspaceRoot,
        env: { ...env },
        stdio: 'inherit',
      })
    },
  }
}
