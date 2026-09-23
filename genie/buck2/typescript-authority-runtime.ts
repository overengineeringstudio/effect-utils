import { spawn } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdtemp,
  rm,
  stat,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import {
  authoritativeBuck2TypeScriptDeclarations,
  type AuthoritativeBuck2TypeScriptDeclaration,
} from './typescript-admissions.ts'

/** Executable followed by its exact ordered argument vector. */
export type CommandArgv = [executable: string, ...args: string[]]

/** Termination signals forwarded by the task wrapper to its active child. */
export type ForwardedSignal = 'SIGINT' | 'SIGTERM'

/** Observable command completion propagated to the task process. */
export type CommandOutcome =
  | { readonly _tag: 'Status'; readonly status: number }
  | { readonly _tag: 'Signal'; readonly signal: NodeJS.Signals }

/** Active child boundary used by the sequential command executor. */
export type RunningCommand = {
  readonly completion: Promise<CommandOutcome>
  readonly forwardSignal: (signal: ForwardedSignal) => void
}

/** Injectable process and signal boundary for command execution tests. */
export type CommandRuntime = {
  readonly spawn: (command: CommandArgv) => RunningCommand
  readonly addSignalListener: (options: {
    readonly signal: ForwardedSignal
    readonly listener: () => void
  }) => void
  readonly removeSignalListener: (options: {
    readonly signal: ForwardedSignal
    readonly listener: () => void
  }) => void
}

/** Plans one in-process declaration publisher invocation for every emitting project. */
export const planTypeScriptDistMaterialization = ({
  admissions = authoritativeBuck2TypeScriptDeclarations,
  buck2Bin,
  bunBin,
  chmodBin,
  mvBin,
  root,
  runtimeSource,
  workspaceRoot,
}: {
  readonly admissions?: readonly AuthoritativeBuck2TypeScriptDeclaration[]
  readonly buck2Bin: string
  readonly bunBin: string
  readonly chmodBin: string
  readonly mvBin: string
  readonly root: string
  readonly runtimeSource: string
  readonly workspaceRoot: string
}): readonly CommandArgv[] =>
  admissions.map(
    ({ declarationEntrypoint, distTarget, packagePath }): CommandArgv => [
      bunBin,
      runtimeSource,
      'materialize-one',
      root,
      workspaceRoot,
      buck2Bin,
      mvBin,
      chmodBin,
      packagePath,
      qualifyEffectUtilsLabel(distTarget),
      declarationEntrypoint,
    ],
  )

/** Runs commands sequentially and forwards task termination signals to the active child. */
export const executeCommandPlan = async ({
  commands,
  runtime = nodeCommandRuntime,
}: {
  readonly commands: readonly CommandArgv[]
  readonly runtime?: CommandRuntime
}): Promise<CommandOutcome> => {
  for (const command of commands) {
    let runningCommand: RunningCommand | undefined
    const forwardSigint = (): void => runningCommand?.forwardSignal('SIGINT')
    const forwardSigterm = (): void => runningCommand?.forwardSignal('SIGTERM')
    runtime.addSignalListener({ signal: 'SIGINT', listener: forwardSigint })
    runtime.addSignalListener({ signal: 'SIGTERM', listener: forwardSigterm })
    try {
      runningCommand = runtime.spawn(command)
      const outcome = await runningCommand.completion
      if (outcome._tag === 'Signal' || outcome.status !== 0) return outcome
    } finally {
      runtime.removeSignalListener({ signal: 'SIGINT', listener: forwardSigint })
      runtime.removeSignalListener({ signal: 'SIGTERM', listener: forwardSigterm })
    }
  }
  return { _tag: 'Status', status: 0 }
}

const isPresent = async (path: string): Promise<boolean> => {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

const validateDist = async ({
  candidate,
  context,
  declarationEntrypoint,
}: {
  readonly candidate: string
  readonly context: string
  readonly declarationEntrypoint: string
}): Promise<void> => {
  const metadata = await stat(candidate).catch(() => undefined)
  if (metadata?.isDirectory() !== true)
    throw new Error(`${context} did not materialize a directory: ${candidate}`)
  const declaration = join(candidate, declarationEntrypoint)
  const declarationMetadata = await stat(declaration).catch(() => undefined)
  if (declarationMetadata?.isFile() !== true)
    throw new Error(`${context} is missing ${declarationEntrypoint}: ${candidate}`)
}

const successful = (outcome: CommandOutcome): boolean =>
  outcome._tag === 'Status' && outcome.status === 0

/**
 * Builds and atomically publishes one declaration tree without a shell-script producer.
 *
 * GNU `mv --exchange --no-copy` remains the filesystem primitive because Node has no
 * renameat2 exchange API. The TypeScript runtime owns validation, rollback, and cleanup.
 */
export const materializeTypeScriptDist = async ({
  buck2Bin,
  chmodBin,
  declarationEntrypoint,
  mvBin,
  packagePath,
  root,
  runtime = nodeCommandRuntime,
  target,
  workspaceRoot,
}: {
  readonly buck2Bin: string
  readonly chmodBin: string
  readonly declarationEntrypoint: string
  readonly mvBin: string
  readonly packagePath: string
  readonly root: string
  readonly runtime?: CommandRuntime
  readonly target: string
  readonly workspaceRoot: string
}): Promise<CommandOutcome> => {
  const packageDirectory = resolve(root, packagePath)
  const dist = join(packageDirectory, 'dist')
  const stagingRoot = await mkdtemp(join(packageDirectory, '.dist-buck2.'))
  const staging = join(stagingRoot, 'dist')
  let hadDist = false
  try {
    const previousDirectory = process.cwd()
    process.chdir(workspaceRoot)
    const buildOutcome = await executeCommandPlan({
      commands: [[buck2Bin, 'build', target, '--out', staging]],
      runtime,
    }).finally(() => process.chdir(previousDirectory))
    if (successful(buildOutcome) === false) return buildOutcome
    await validateDist({
      candidate: staging,
      context: `Buck target ${target}`,
      declarationEntrypoint,
    })

    hadDist = await isPresent(dist)
    const publishOutcome = await executeCommandPlan({
      commands: [
        hadDist
          ? [mvBin, '--exchange', '--no-copy', '-T', staging, dist]
          : [mvBin, '--no-copy', '-T', staging, dist],
      ],
      runtime,
    })
    if (successful(publishOutcome) === false) return publishOutcome

    try {
      await validateDist({
        candidate: dist,
        context: `Published ${packagePath} dist`,
        declarationEntrypoint,
      })
    } catch (error) {
      console.error(
        `Published ${packagePath} dist failed validation; restoring the previous dist`,
      )
      if (hadDist === true) {
        const restoreOutcome = await executeCommandPlan({
          commands: [[mvBin, '--exchange', '--no-copy', '-T', staging, dist]],
          runtime,
        })
        if (successful(restoreOutcome) === false) return restoreOutcome
      } else {
        await rm(dist, { force: true, recursive: true })
      }
      throw error
    }
    return { _tag: 'Status', status: 0 }
  } finally {
    if (await isPresent(stagingRoot)) {
      await executeCommandPlan({
        commands: [[chmodBin, '-R', 'u+w', stagingRoot]],
        runtime,
      })
      await chmod(stagingRoot, 0o700).catch(() => undefined)
      await rm(stagingRoot, { force: true, recursive: true })
    }
  }
}

const qualifyEffectUtilsLabel = (label: `//${string}`): string => `effect_utils${label}`

const nodeCommandRuntime: CommandRuntime = {
  spawn: ([executable, ...args]) => {
    const child = spawn(executable, args, { stdio: 'inherit' })
    const completion = new Promise<CommandOutcome>((resolve) => {
      child.once('error', (error) => {
        console.error(error.message)
        resolve({ _tag: 'Status', status: 1 })
      })
      child.once('close', (status, signal) => {
        resolve(
          signal === null ? { _tag: 'Status', status: status ?? 1 } : { _tag: 'Signal', signal },
        )
      })
    })
    return {
      completion,
      forwardSignal: (signal) => {
        child.kill(signal)
      },
    }
  },
  addSignalListener: ({ signal, listener }) => process.on(signal, listener),
  removeSignalListener: ({ signal, listener }) => process.off(signal, listener),
}

const main = async (): Promise<CommandOutcome> => {
  const [operation, ...args] = process.argv.slice(2)
  if (operation === 'materialize-dist' && args.length === 5) {
    const [root, workspaceRoot, buck2Bin, mvBin, chmodBin] = args as [
      string,
      string,
      string,
      string,
      string,
    ]
    return executeCommandPlan({
      commands: planTypeScriptDistMaterialization({
        buck2Bin,
        bunBin: process.execPath,
        chmodBin,
        mvBin,
        root,
        runtimeSource: fileURLToPath(import.meta.url),
        workspaceRoot,
      }),
    })
  }
  if (operation === 'materialize-one' && args.length === 8) {
    const [
      root,
      workspaceRoot,
      buck2Bin,
      mvBin,
      chmodBin,
      packagePath,
      target,
      declarationEntrypoint,
    ] = args as [string, string, string, string, string, string, string, string]
    return materializeTypeScriptDist({
      buck2Bin,
      chmodBin,
      declarationEntrypoint,
      mvBin,
      packagePath,
      root,
      target,
      workspaceRoot,
    })
  }
  console.error(
    'usage: typescript-authority-runtime.ts materialize-dist <repo-root> <workspace-root> <buck2-bin> <mv-bin> <chmod-bin>',
  )
  return { _tag: 'Status', status: 2 }
}

if (import.meta.main === true) {
  const outcome = await main()
  if (outcome._tag === 'Signal') {
    process.exitCode = 1
    process.kill(process.pid, outcome.signal)
  } else {
    process.exit(outcome.status)
  }
}
