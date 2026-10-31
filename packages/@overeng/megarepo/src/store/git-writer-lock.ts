import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

import { NodeStream } from '@effect/platform-node'
import { Clock, Context, Effect, Option, Schedule, Schema, Stream } from 'effect'
import type { PlatformError } from 'effect/PlatformError'
import * as Command from 'effect/process/ChildProcess'

import * as Observability from '../core/observability.ts'

/** A failed lock acquisition is never downgraded to an unlocked write. */
export class GitWriterLockError extends Schema.TaggedError<GitWriterLockError>()(
  'GitWriterLockError',
  { path: Schema.String, cause: Schema.Defect() },
) {}

class WriterDescriptor extends Context.Service<
  WriterDescriptor,
  { readonly fd: number; readonly dev: number; readonly ino: number }
>()('megarepo/GitWriterDescriptor') {}

const io =
  (path: string) =>
  <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => new GitWriterLockError({ path, cause }) })

/** Resolve worktrees, bare repositories and symlinks to one identity. */
export const resolveGitCommonDir = Effect.fnUntraced(
  function* (path: string) {
    const absolute = resolve(path)
    const exists = yield* io(absolute)(() =>
      stat(absolute).then(
        () => true,
        (cause: NodeJS.ErrnoException) => {
          if (cause.code === 'ENOENT') return false
          throw cause
        },
      ),
    )
    // Clone admission uses the same name before Git has created its common dir.
    if (exists === false) {
      const parent = yield* io(absolute)(() => realpath(dirname(absolute)))
      return resolve(parent, basename(absolute))
    }
    const common = yield* Command.make(
      'git',
      ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      { cwd: absolute, stdout: 'pipe', stderr: 'pipe' },
    ).pipe(
      Effect.flatMap((child) =>
        Effect.all(
          [Stream.runCollect(child.stdout), Stream.runCollect(child.stderr), child.exitCode],
          { concurrency: 'unbounded' },
        ),
      ),
      Effect.scoped,
    )
    if (common[2] !== 0) {
      return yield* new GitWriterLockError({
        path: absolute,
        cause: new TextDecoder().decode(Buffer.concat(common[1])),
      })
    }
    const commonPath = new TextDecoder().decode(Buffer.concat(common[0])).trim()
    return yield* io(absolute)(() => realpath(commonPath))
  },
  (effect, path) =>
    effect.pipe(Observability.withRepoPathSpan({ name: 'git/resolve-common-dir', path })),
)

// Lazy loading keeps read-only Node consumers importable; the mr runtime is Bun.
interface FlockLibrary {
  readonly flock: (descriptor: number, operation: number) => number
  readonly errno: () => number
}
const loadFlock = (): Promise<FlockLibrary> =>
  import('bun:ffi').then(({ dlopen, read }) => {
    const library = process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6'
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      throw new GitWriterLockError({ path: library, cause: 'Writer locks require Linux or macOS' })
    }
    const native = dlopen(library, { flock: { args: ['i32', 'i32'], returns: 'i32' } })
    /* eslint-disable no-underscore-dangle -- libc ABI symbol names */
    const errnoAddress =
      process.platform === 'darwin'
        ? dlopen(library, { __error: { args: [], returns: 'ptr' } }).symbols.__error
        : dlopen(library, { __errno_location: { args: [], returns: 'ptr' } }).symbols
            .__errno_location
    /* eslint-enable no-underscore-dangle */
    return {
      flock: native.symbols.flock,
      errno: () => {
        const pointer = errnoAddress()
        return pointer === null ? -1 : read.i32(pointer)
      },
    }
  })
let flockLibrary: Promise<FlockLibrary> | undefined

/** Kernel lock controls persist: unlinking them would split ownership. */
const withGitLock =
  ({
    path,
    create = false,
    containerMode,
  }: {
    readonly path: string
    readonly create?: boolean
    readonly containerMode?: 'shared' | 'exclusive'
  }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const common =
        create === true
          ? yield* io(path)(async () => {
              try {
                return await realpath(path)
              } catch (cause) {
                if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
                return resolve(await realpath(dirname(resolve(path))), basename(path))
              }
            })
          : yield* resolveGitCommonDir(path)
      const lockPath = `${common}.${containerMode === undefined ? 'mr-writer' : 'mr-container'}.lock`
      const native = yield* io(lockPath)(() => (flockLibrary ??= loadFlock()))
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* Effect.acquireRelease(
            io(lockPath)(() =>
              // Bun does not add CLOEXEC for numeric open flags. Keep unrelated
              // spawns from inheriting admission; only the explicit fd3 duplicate
              // below belongs to a writer. Node's constants omit O_CLOEXEC.
              open(
                lockPath,
                constants.O_CREAT |
                  constants.O_RDWR |
                  constants.O_NOFOLLOW |
                  (process.platform === 'darwin' ? 0x1000000 : 0o2000000),
                0o600,
              ),
            ),
            (handle) => Effect.promise(() => handle.close()).pipe(Effect.orDie),
          )
          const opened = yield* io(lockPath)(() => file.stat())
          if (
            opened.isFile() === false ||
            opened.nlink !== 1 ||
            opened.uid !== process.getuid?.()
          ) {
            return yield* new GitWriterLockError({
              path: lockPath,
              cause: 'Expected an owned regular lock file',
            })
          }
          // Nonblocking flock lets fibers progress and remains interruptible while
          // waiting. Kernel acquisition, not the polling interval, grants ownership.
          yield* Effect.suspend(() => {
            if (native.flock(file.fd, (containerMode === 'shared' ? 1 : 2) | 4) === 0)
              return Effect.succeed(true)
            const errno = native.errno()
            if (
              errno === 4 ||
              (containerMode !== 'exclusive' && errno === (process.platform === 'darwin' ? 35 : 11))
            )
              return Effect.succeed(false)
            return Effect.fail(
              new GitWriterLockError({ path: lockPath, cause: `flock errno=${errno}` }),
            )
          }).pipe(
            Effect.repeat({
              while: (acquired) => acquired === false,
              schedule: Schedule.spaced('10 millis'),
            }),
            // Kernel contention follows wall time, never a caller's decision/TestClock.
            Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
          )
          const named = yield* io(lockPath)(() => lstat(lockPath))
          if (named.dev !== opened.dev || named.ino !== opened.ino || named.nlink !== 1) {
            return yield* new GitWriterLockError({
              path: lockPath,
              cause: 'Persistent lock control was replaced',
            })
          }
          return yield* containerMode === undefined
            ? effect.pipe(
                Effect.provideService(WriterDescriptor, {
                  fd: file.fd,
                  dev: opened.dev,
                  ino: opened.ino,
                }),
              )
            : effect
        }),
      )
    }).pipe(Observability.withRepoPathSpan({ name: 'git/writer-lock', path }))

/** Exclusive Git-writer admission, retained by spawned writer descendants. */
export const withGitWriterLock = ({ path, create = false }: { path: string; create?: boolean }) =>
  withGitLock({ path, create })

/** Shared activation/creation or exclusive repository-output reclamation fence. */
export const withGitContainerLock =
  ({ path, mode }: { path: string; mode: 'shared' | 'exclusive' }) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    io(path)(() => realpath(path)).pipe(
      Effect.flatMap((existing) =>
        effect.pipe(withGitLock({ path: existing, containerMode: mode })),
      ),
    )

/** Minimal process handle shared by the standard and descriptor-inheriting spawners. */
export interface GitWriterProcess {
  readonly stdout: Stream.Stream<Uint8Array, GitWriterLockError | PlatformError>
  readonly stderr: Stream.Stream<Uint8Array, GitWriterLockError | PlatformError>
  readonly exitCode: Effect.Effect<number, GitWriterLockError | PlatformError>
}

/**
 * A departed leader's pgid can be recycled. Only signal a surviving group when
 * Linux procfs proves a member still owns this admission inode. Unreadable or
 * vanished evidence never authorizes a signal. `procRoot`/`kill` are test seams.
 */
export const signalLockHoldingProcessGroup = async ({
  pgid,
  lockIdentity,
  procRoot = '/proc',
  kill = (group: number) => process.kill(-group, 'SIGKILL'),
}: {
  readonly pgid: number
  readonly lockIdentity: { readonly dev: number; readonly ino: number }
  readonly procRoot?: string
  readonly kill?: (group: number) => void
}): Promise<boolean> => {
  let processes: Array<string>
  try {
    processes = await readdir(procRoot)
  } catch {
    return false
  }
  /* eslint-disable no-await-in-loop -- Check ownership immediately before signalling; bound procfs fd usage and stop at the first proven holder. */
  for (const pid of processes) {
    if (/^[0-9]+$/u.test(pid) === false) continue
    try {
      // comm is parenthesized and may itself contain spaces or ')' characters.
      const status = await readFile(`${procRoot}/${pid}/stat`, 'utf8')
      const fields = status.slice(status.lastIndexOf(')') + 2).split(' ')
      if (Number(fields[2]) !== pgid) continue
      const descriptors = await readdir(`${procRoot}/${pid}/fd`)
      for (const fd of descriptors) {
        try {
          const owned = await stat(`${procRoot}/${pid}/fd/${fd}`)
          if (owned.dev !== lockIdentity.dev || owned.ino !== lockIdentity.ino) continue
          // Recheck membership after the fd lookup; PID reuse during the scan
          // must not turn another group's lock holder into ownership evidence.
          const current = await readFile(`${procRoot}/${pid}/stat`, 'utf8')
          if (current !== status) {
            const now = current.slice(current.lastIndexOf(')') + 2).split(' ')
            if (Number(now[2]) !== pgid || now[19] !== fields[19]) continue
          }
          kill(pgid)
          return true
        } catch {
          // Fds and processes can disappear between listing and stat.
        }
      }
    } catch {
      // Inaccessible processes do not constitute ownership proof.
    }
  }
  /* eslint-enable no-await-in-loop */
  return false
}

/**
 * Effect's spawner cannot inherit an existing descriptor. Writers use this narrow
 * adapter so fd3 retains the SAME open-file-description lock after mr is killed,
 * until the actual writer exits. Unlocked commands keep the standard spawner.
 *
 * Every descendant (remote helpers, transport commands such as `ext::`, a git
 * wrapper's real git) inherits fd3 and therefore co-owns the lock. Piped writers
 * run in their own process group, like Effect's spawner, so interruption signals
 * the whole group and the lock is released once the group is gone. Interactive
 * (`inheritStdio`) writers stay in the caller's group to keep the terminal.
 */
export const startGitWriterProcess = Effect.fnUntraced(
  function* ({
    command,
    args,
    cwd,
    env,
    inheritStdio = false,
  }: {
    command: string
    args: ReadonlyArray<string>
    cwd?: string
    env?: Record<string, string>
    inheritStdio?: boolean
  }) {
    const descriptor = yield* Effect.serviceOption(WriterDescriptor)
    if (Option.isNone(descriptor) === true) {
      const child: GitWriterProcess = yield* Command.make(command, args, {
        cwd,
        ...(env === undefined ? {} : { env, extendEnv: true }),
        stdin: inheritStdio === true ? 'inherit' : 'pipe',
        stdout: inheritStdio === true ? 'inherit' : 'pipe',
        stderr: inheritStdio === true ? 'inherit' : 'pipe',
      })
      return child
    }
    // Native spawn is required solely for numeric fd inheritance, unavailable in
    // ChildProcess.CommandOptions. No shell parsing or command rewriting occurs.
    const detached = inheritStdio === false
    const child = spawn(command, args, {
      cwd,
      detached,
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
      stdio: [
        inheritStdio === true ? 'inherit' : 'pipe',
        inheritStdio === true ? 'inherit' : 'pipe',
        inheritStdio === true ? 'inherit' : 'pipe',
        descriptor.value.fd,
      ],
    })
    const exited = new Promise<number>((accept, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) =>
        accept(code ?? 128 + (signal === null ? 0 : osConstants.signals[signal])),
      )
    })
    // Install rejection handling immediately, even while stdout is being consumed.
    void exited.catch(() => undefined)
    const signal = async (name: NodeJS.Signals) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        if (detached === true && child.pid !== undefined && process.platform === 'linux') {
          await signalLockHoldingProcessGroup({
            pgid: child.pid,
            lockIdentity: descriptor.value,
          })
        }
        // Without procfs (macOS), a departed leader cannot prove group identity.
        return
      }
      if (detached === true && child.pid !== undefined) {
        try {
          process.kill(-child.pid, name)
          return
        } catch {
          // Fall back only while the direct child is still known alive.
        }
      }
      child.kill(name)
    }
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (child.exitCode !== null || child.signalCode !== null) {
          // A lock-holding descendant may outlive the direct child.
          if (detached === true) await signal('SIGKILL')
          return
        }
        await signal('SIGTERM')
        const escalation = setTimeout(() => void signal('SIGKILL'), 1_000)
        escalation.unref()
        try {
          await exited.catch(() => undefined)
        } finally {
          clearTimeout(escalation)
          // A surviving lock holder proves this is still our group. A recycled
          // pgid without that evidence must never receive a post-exit signal.
          if (detached === true) await signal('SIGKILL')
        }
      }),
    )
    // Async-iterator `return()` queues behind a pending `next()`, so interrupting a
    // reader blocked on a silent pipe never settles and the child is never killed.
    // `NodeStream.fromReadable` destroys the readable on interruption instead.
    const result: GitWriterProcess = {
      stdout:
        child.stdout === null
          ? Stream.empty
          : NodeStream.fromReadable<Uint8Array, GitWriterLockError>({
              evaluate: () => child.stdout!,
              onError: (cause) => new GitWriterLockError({ path: command, cause }),
            }),
      stderr:
        child.stderr === null
          ? Stream.empty
          : NodeStream.fromReadable<Uint8Array, GitWriterLockError>({
              evaluate: () => child.stderr!,
              onError: (cause) => new GitWriterLockError({ path: command, cause }),
            }),
      exitCode: io(command)(() => exited),
    }
    return result
  },
  (effect, { command }) =>
    effect.pipe(
      Observability.withLabelSpan({
        name: 'git/start-writer-process',
        labelValue: command,
      }),
    ),
)
