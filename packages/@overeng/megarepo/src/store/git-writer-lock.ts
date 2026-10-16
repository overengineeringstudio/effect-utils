import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import { constants as osConstants } from 'node:os'
import { basename, dirname, resolve } from 'node:path'

import { Clock, Context, Effect, Option, Schedule, Schema, Stream } from 'effect'
import type { PlatformError } from 'effect/PlatformError'
import * as Command from 'effect/process/ChildProcess'

import * as Observability from '../core/observability.ts'

/** A failed lock acquisition is never downgraded to an unlocked write. */
export class GitWriterLockError extends Schema.TaggedError<GitWriterLockError>()(
  'GitWriterLockError',
  { path: Schema.String, cause: Schema.Defect() },
) {}

class WriterDescriptor extends Context.Service<WriterDescriptor, number>()(
  'megarepo/GitWriterDescriptor',
) {}

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
        Effect.all([
          Stream.runCollect(child.stdout),
          Stream.runCollect(child.stderr),
          child.exitCode,
        ]),
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

/**
 * One host-local, kernel-released lock per real common dir. The sibling control
 * file survives clone and must NEVER be removed (unlinking splits ownership).
 * No TTL, stale-owner recovery or lock-file deletion participates in admission.
 */
export const withGitWriterLock =
  ({ path, create = false }: { readonly path: string; readonly create?: boolean }) =>
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
      const lockPath = `${common}.mr-writer.lock`
      const native = yield* io(lockPath)(() => (flockLibrary ??= loadFlock()))
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* Effect.acquireRelease(
            io(lockPath)(() =>
              open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600),
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
            if (native.flock(file.fd, 2 | 4) === 0) return Effect.succeed(true)
            const errno = native.errno()
            if (errno === 4 || errno === (process.platform === 'darwin' ? 35 : 11))
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
          return yield* effect.pipe(Effect.provideService(WriterDescriptor, file.fd))
        }),
      )
    }).pipe(Observability.withRepoPathSpan({ name: 'git/writer-lock', path }))
/** Minimal process handle shared by the standard and descriptor-inheriting spawners. */
export interface GitWriterProcess {
  readonly stdout: Stream.Stream<Uint8Array, GitWriterLockError | PlatformError>
  readonly stderr: Stream.Stream<Uint8Array, GitWriterLockError | PlatformError>
  readonly exitCode: Effect.Effect<number, GitWriterLockError | PlatformError>
}

/**
 * Effect's spawner cannot inherit an existing descriptor. Writers use this narrow
 * adapter so fd3 retains the SAME open-file-description lock after mr is killed,
 * until the actual writer exits. Unlocked commands keep the standard spawner.
 */
export const startGitWriterProcess = Effect.fnUntraced(
  function* ({
    command,
    args,
    cwd,
    inheritStdio = false,
  }: {
    command: string
    args: ReadonlyArray<string>
    cwd?: string
    inheritStdio?: boolean
  }) {
    const descriptor = yield* Effect.serviceOption(WriterDescriptor)
    if (Option.isNone(descriptor) === true) {
      const child: GitWriterProcess = yield* Command.make(command, args, {
        cwd,
        stdin: inheritStdio === true ? 'inherit' : 'pipe',
        stdout: inheritStdio === true ? 'inherit' : 'pipe',
        stderr: inheritStdio === true ? 'inherit' : 'pipe',
      })
      return child
    }
    // Native spawn is required solely for numeric fd inheritance, unavailable in
    // ChildProcess.CommandOptions. No shell parsing or command rewriting occurs.
    const child = spawn(command, args, {
      cwd,
      stdio: [
        inheritStdio === true ? 'inherit' : 'pipe',
        inheritStdio === true ? 'inherit' : 'pipe',
        inheritStdio === true ? 'inherit' : 'pipe',
        descriptor.value,
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
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (child.exitCode !== null || child.signalCode !== null) return
        child.kill('SIGTERM')
        const escalation = setTimeout(() => child.kill('SIGKILL'), 1_000)
        escalation.unref()
        try {
          await exited.catch(() => undefined)
        } finally {
          clearTimeout(escalation)
        }
      }),
    )
    const result: GitWriterProcess = {
      stdout:
        child.stdout === null
          ? Stream.empty
          : Stream.fromAsyncIterable<Uint8Array, GitWriterLockError>(
              child.stdout,
              (cause) => new GitWriterLockError({ path: command, cause }),
            ),
      stderr:
        child.stderr === null
          ? Stream.empty
          : Stream.fromAsyncIterable<Uint8Array, GitWriterLockError>(
              child.stderr,
              (cause) => new GitWriterLockError({ path: command, cause }),
            ),
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
