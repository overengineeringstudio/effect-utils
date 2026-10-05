import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context, Data, Effect, Layer, Schedule } from 'effect'
import type { Duration } from 'effect'

/** Raised when the scratch daemon cannot be started or never opens its socket. */
export class ScratchDaemonError extends Data.TaggedError('ScratchDaemonError')<{
  readonly message: string
}> {}

/** Result of one `st` CLI invocation against the scratch daemon. */
export interface ScratchCommandResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Isolated `st up` daemon bound to a scoped temp directory. */
export class ScratchDaemon extends Context.Service<
  ScratchDaemon,
  {
    /** Scratch root holding state, sockets and the isolated HOME/XDG directories. */
    readonly directory: string
    /** Absolute `st` binary path used for the daemon and `run`. */
    readonly binary: string
    /** Daemon unix socket path. */
    readonly socket: string
    /** `unix://` endpoint for `st --endpoint`. */
    readonly endpoint: string
    /** Isolated environment (HOME, XDG_*, PATH) for every `st` invocation. */
    readonly env: Readonly<Record<string, string>>
    /** Runs `st --endpoint <endpoint> ...args` in the isolated environment; never fails on non-zero exit. */
    readonly run: (
      args: ReadonlyArray<string>,
    ) => Effect.Effect<ScratchCommandResult, ScratchDaemonError>
  }
>()('@overeng/genie-smalltalk/testing/ScratchDaemon') {}

/** Options for {@link scratchDaemonLayer}. */
export interface ScratchDaemonOptions {
  /** `st` binary: absolute path, or a name resolved against the caller's PATH. */
  readonly binary: string
  /** Daemon node name. Default `scratch`. */
  readonly node?: string
  /** PATH visible to the daemon and CLI. Default `/nonexistent`, so seats cannot reach host tools by accident. */
  readonly path?: string
  /** Socket readiness timeout. Default 10 seconds. */
  readonly readyTimeout?: Duration.Input
  /** Per-`run` timeout; the CLI process is killed and `run` fails with {@link ScratchDaemonError}. Default 30 seconds. */
  readonly commandTimeout?: Duration.Input
  /** Keep the scratch directory after scope close for debugging. Default false. */
  readonly keepDirectory?: boolean
}

const resolveBinary = (binary: string) => {
  if (binary.includes('/') === true) return binary
  for (const directory of (process.env.PATH ?? '').split(':')) {
    const candidate = join(directory, binary)
    if (directory !== '' && existsSync(candidate) === true) return candidate
  }
  return binary
}

/** Signals the daemon's process group; false once no member is left. */
const signalGroup = ({ pid, signal }: { pid: number; signal: NodeJS.Signals | 0 }) => {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

/**
 * Processes that escaped the daemon's process group (e.g. `pty run -d` session daemons that
 * double-fork into a new session) but still carry the scratch environment. Linux `/proc` only;
 * elsewhere this finds nothing and teardown falls back to the process group.
 */
const escapedProcesses = (marker: string) => {
  let entries: Array<string>
  try {
    entries = readdirSync('/proc')
  } catch {
    return []
  }
  const pids: Array<number> = []
  for (const entry of entries) {
    const pid = Number(entry)
    if (Number.isInteger(pid) === false || pid === process.pid) continue
    try {
      const environ = readFileSync(`/proc/${pid}/environ`, 'latin1')
      if (environ.split('\0').includes(marker) === true) pids.push(pid)
    } catch {
      // Exited or not ours.
    }
  }
  return pids
}

/**
 * Stops `st up` (its own process-group leader) and every process still carrying the scratch
 * environment, so nothing can recreate files in the directory after it is removed. SIGTERM first,
 * SIGKILL after 5 seconds; gives up 2 seconds later (unreapable zombies, D-state) and logs the
 * survivors instead of hanging the finalizer.
 */
const stop = ({ child, marker }: { child: ChildProcess; marker: string }) =>
  Effect.callback<void>((resume) => {
    const pid = child.pid
    const signalAll = (signal: NodeJS.Signals | 0) => {
      const escaped = escapedProcesses(marker)
      const groupAlive = pid !== undefined && signalGroup({ pid, signal })
      if (signal !== 0) {
        for (const survivor of escaped) {
          try {
            process.kill(survivor, signal)
          } catch {
            // Already gone.
          }
        }
      }
      return { alive: groupAlive === true || escaped.length > 0, escaped }
    }
    if (signalAll('SIGTERM').alive === false) return resume(Effect.void)
    const killAt = Date.now() + 5000
    const giveUpAt = killAt + 2000
    const poll = setInterval(() => {
      const now = Date.now()
      const { alive, escaped } = signalAll(now > killAt ? 'SIGKILL' : 0)
      if (alive === true && now <= giveUpAt) return
      clearInterval(poll)
      resume(
        alive === true
          ? Effect.logWarning(
              `scratch daemon teardown gave up; group ${pid} or pids [${escaped.join(', ')}] still alive`,
            )
          : Effect.void,
      )
    }, 50)
    return Effect.sync(() => clearInterval(poll))
  })

const capture = ({
  binary,
  args,
  env,
}: {
  binary: string
  args: ReadonlyArray<string>
  env: Readonly<Record<string, string>>
}) =>
  Effect.callback<ScratchCommandResult, ScratchDaemonError>((resume) => {
    const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.once('error', (cause) =>
      resume(
        Effect.fail(new ScratchDaemonError({ message: `st ${args.join(' ')}: ${cause.message}` })),
      ),
    )
    child.once('close', (status) => resume(Effect.succeed({ status, stdout, stderr })))
    return Effect.sync(() => child.kill('SIGKILL'))
  })

/**
 * Starts an isolated `st up` (own HOME/XDG dirs, state dir, PTY root, daemon and gateway sockets
 * under one temp directory), waits for its socket, and on scope close stops the daemon and removes
 * the directory. Node-only.
 */
export const scratchDaemonLayer = (options: ScratchDaemonOptions) =>
  Layer.effect(
    ScratchDaemon,
    Effect.gen(function* () {
      const binary = resolveBinary(options.binary)
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => mkdtempSync(join(tmpdir(), 'genie-st-'))),
        (created) =>
          options.keepDirectory === true
            ? Effect.logInfo(`kept scratch daemon directory ${created}`)
            : Effect.sync(() => rmSync(created, { recursive: true, force: true, maxRetries: 3 })),
      )
      const env = {
        HOME: join(directory, 'home'),
        XDG_CONFIG_HOME: join(directory, 'config'),
        XDG_DATA_HOME: join(directory, 'data'),
        XDG_STATE_HOME: join(directory, 'xdg-state'),
        XDG_RUNTIME_DIR: join(directory, 'runtime'),
      }
      for (const path of Object.values(env)) mkdirSync(path)
      const isolatedEnv = { ...env, PATH: options.path ?? '/nonexistent' }
      const socket = join(directory, 'daemon.sock')
      const endpoint = `unix://${socket}`
      const stderr: Array<string> = []
      let ready = false
      const daemon = yield* Effect.acquireRelease(
        Effect.callback<ChildProcess, ScratchDaemonError>((resume) => {
          const child = spawn(
            binary,
            [
              'up',
              '--node',
              options.node ?? 'scratch',
              '--state-dir',
              join(directory, 'state'),
              '--pty-root',
              join(directory, 'pty'),
              '--socket',
              socket,
              '--client-gateway-socket',
              join(directory, 'gateway.sock'),
            ],
            { env: isolatedEnv, stdio: ['ignore', 'ignore', 'pipe'], detached: true },
          )
          // Keep draining stderr for the daemon's lifetime but only buffer it for startup diagnostics.
          child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
            if (ready === false) stderr.push(chunk)
          })
          child.once('spawn', () => resume(Effect.succeed(child)))
          child.once('error', (cause) =>
            resume(
              Effect.fail(
                new ScratchDaemonError({ message: `cannot spawn ${binary}: ${cause.message}` }),
              ),
            ),
          )
        }),
        (child) => stop({ child, marker: `HOME=${env.HOME}` }),
      )
      yield* Effect.suspend(() => {
        if (daemon.exitCode !== null || daemon.signalCode !== null)
          return Effect.fail(
            new ScratchDaemonError({
              message: `st up failed to start or exited: ${stderr.join('')}`,
            }),
          )
        if (existsSync(socket) === true) return Effect.void
        return Effect.fail(new ScratchDaemonError({ message: 'socket not ready' }))
      }).pipe(
        Effect.retry({
          schedule: Schedule.spaced('50 millis'),
          while: (error) => error.message === 'socket not ready',
        }),
        Effect.timeoutOrElse({
          duration: options.readyTimeout ?? '10 seconds',
          orElse: () =>
            Effect.fail(
              new ScratchDaemonError({
                message: `st up socket ${socket} not ready: ${stderr.join('')}`,
              }),
            ),
        }),
      )
      ready = true
      const commandTimeout = options.commandTimeout ?? '30 seconds'
      return {
        directory,
        binary,
        socket,
        endpoint,
        env: isolatedEnv,
        run: (args) =>
          capture({ binary, args: ['--endpoint', endpoint, ...args], env: isolatedEnv }).pipe(
            Effect.timeoutOrElse({
              duration: commandTimeout,
              orElse: () =>
                Effect.fail(new ScratchDaemonError({ message: `st ${args.join(' ')} timed out` })),
            }),
          ),
      }
    }),
  )
