/**
 * `@overeng/pty-effect/client` — Effect-native wrapper around
 * `@myobie/pty/client`.
 *
 * Where the root `@overeng/pty-effect` module wraps `@myobie/pty/testing`
 * (in-process, scope-bound, kill-on-close — useful for TUI testing), this
 * subpath wraps the *programmatic client* API: detached daemons that
 * outlive the spawning process, with `attach`-by-name connections that
 * stream raw terminal bytes.
 *
 * This is the surface real apps use when they want pty sessions to survive
 * process restarts (forge, dev shells, persistent agent runners).
 */

import { spawn as spawnChild } from 'node:child_process'
import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import type { WriteStream } from 'node:tty'

import {
  type SessionConnectionOptions,
  type SessionInfo,
  SessionConnection,
  getSocketPath,
  listSessions as upstreamListSessions,
  peekScreen as upstreamPeekScreen,
  validateName,
} from '@myobie/pty/client'
import {
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Predicate,
  Queue,
  Schedule,
  Schema,
  Stream,
  pipe,
} from 'effect'
import type { Scope } from 'effect'

import { PtyError } from './PtyError.ts'
import { PtyName, type TerminalSize } from './PtySpec.ts'
import type { Screenshot } from './Screenshot.ts'

/* ───────────────────────────── specs ────────────────────────────── */

/**
 * Spec for spawning a daemon-mode pty session via `@myobie/pty/client`'s
 * `spawnDaemon`. The daemon is detached (`child.unref()`) and outlives the
 * process that called this — clients connect to it later by name.
 *
 * `displayCommand` defaults to `command` and is what `pty ls` shows.
 */
export const PtyDaemonSpec = Schema.Struct({
  name: PtyName,
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  displayCommand: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  ephemeral: Schema.optional(Schema.Boolean),
  size: Schema.optional(
    Schema.Struct({
      rows: Schema.Number.pipe(Schema.int(), Schema.positive()),
      cols: Schema.Number.pipe(Schema.int(), Schema.positive()),
    }),
  ),
  /** Extra environment variables to merge into the daemon process env.
   *  Applied per call without mutating the parent `process.env`. */
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
})
export type PtyDaemonSpec = typeof PtyDaemonSpec.Type

/**
 * Initial terminal dimensions sent on attach. The pty server will resize
 * the underlying tty to match.
 */
export interface PtyAttachSpec {
  readonly name: PtyName
  readonly size: TerminalSize
}

/** Default polling schedule for `waitFor*` (50ms fixed). */
export const defaultPollSchedule: Schedule.Schedule<unknown> = Schedule.spaced('50 millis')

/* ──────────────────────── client session handle ─────────────────── */

/**
 * Effect-native handle for a *connected* client session.
 *
 * Acquired via `PtyClient.attach`. The session itself (the daemon) is NOT
 * owned by the surrounding scope — only this connection is. Closing the
 * scope detaches and drops the socket; the daemon keeps running and is
 * reattachable by name.
 *
 * `bytes` is a bounded queue drained on demand; if no fiber is consuming
 * it, output is buffered. Single-consumer pattern.
 */
export interface PtyClientSession {
  readonly name: PtyName
  /** Initial screen replay sent by the server right after attach. */
  readonly initialScreen: string
  /**
   * Stream of terminal output bytes (UTF-8 encoded from upstream's
   * string-typed `data` event). Ends when the session exits or the
   * connection closes. Single-consumer.
   */
  readonly bytes: Stream.Stream<Uint8Array, PtyError>
  /** Send a UTF-8 string to the session's stdin. */
  readonly write: (input: { readonly data: string }) => Effect.Effect<void, PtyError>
  /** Type text character-by-character (delegates to write). */
  readonly type: (input: { readonly text: string }) => Effect.Effect<void, PtyError>
  /** Press a named key (`return`, `up`, `ctrl+c`, etc.). */
  readonly press: (input: { readonly key: string }) => Effect.Effect<void, PtyError>
  /** Renegotiate terminal dimensions. */
  readonly resize: (input: TerminalSize) => Effect.Effect<void, PtyError>
  /** Read the current rendered screen via peek (delegates to the daemon). */
  readonly screenshot: Effect.Effect<Screenshot, PtyError>
  /**
   * Resolves with the session's exit code when the daemon's child process
   * exits. Fails with `PtyError(reason='Closed')` if the connection is
   * dropped before the session exits.
   */
  readonly exit: Effect.Effect<{ readonly code: number }, PtyError>
  /**
   * Polls the terminal on a `Schedule` until `needle` appears in the
   * rendered screen text. Compose with `Effect.timeout` for deadlines.
   */
  readonly waitForText: (input: {
    readonly needle: string | RegExp
    readonly schedule?: Schedule.Schedule<unknown>
  }) => Effect.Effect<Screenshot, PtyError>
  /**
   * Polls the terminal on a `Schedule` until `needle` is absent from the
   * rendered screen text.
   */
  readonly waitForAbsent: (input: {
    readonly needle: string | RegExp
    readonly schedule?: Schedule.Schedule<unknown>
  }) => Effect.Effect<Screenshot, PtyError>
}

/* ───────────────────────────── service ──────────────────────────── */

/**
 * Top-level service. Wraps the function-style `@myobie/pty/client` API as
 * Effects.
 *
 * `attach` is `Scope`-bound; the others are not (they're either fire-and-
 * forget like `spawnDaemon`, or one-shot RPCs like `peek`/`list`).
 */
export class PtyClient extends Context.Tag('@overeng/pty-effect/PtyClient')<
  PtyClient,
  {
    readonly spawnDaemon: (spec: PtyDaemonSpec) => Effect.Effect<void, PtyError>
    readonly attach: (spec: PtyAttachSpec) => Effect.Effect<PtyClientSession, PtyError, Scope.Scope>
    readonly peek: (input: {
      readonly name: PtyName
      readonly plain?: boolean
    }) => Effect.Effect<string, PtyError>
    readonly list: Effect.Effect<ReadonlyArray<SessionInfo>, PtyError>
    readonly exists: (input: { readonly name: PtyName }) => Effect.Effect<boolean, PtyError>
    readonly kill: (input: { readonly name: PtyName }) => Effect.Effect<void, PtyError>
  }
>() {}

/* ─────────────────────────── implementation ─────────────────────── */

const wrapPromise = <A>(opts: {
  readonly method: string
  readonly reason?: PtyError['reason']
  readonly name?: string
  readonly thunk: (signal: AbortSignal) => Promise<A>
}) =>
  Effect.tryPromise({
    try: opts.thunk,
    catch: (cause) =>
      new PtyError({
        reason: opts.reason ?? 'WriteFailed',
        method: opts.method,
        name: opts.name,
        cause,
      }),
  })

const wrapSync = <A>(opts: {
  readonly method: string
  readonly reason?: PtyError['reason']
  readonly name?: string
  readonly thunk: () => A
}) =>
  Effect.try({
    try: opts.thunk,
    catch: (cause) =>
      new PtyError({
        reason: opts.reason ?? 'WriteFailed',
        method: opts.method,
        name: opts.name,
        cause,
      }),
  })

const require = createRequire(import.meta.url)

const resolveDaemonBin = () =>
  process.env.PTY_DAEMON_BIN ??
  path.join(path.dirname(require.resolve('@myobie/pty/client')), '..', 'bin', 'pty-daemon')

const getDefaultRows = () => ((process.stdout as WriteStream | undefined)?.rows ?? 24)

const getDefaultCols = () => ((process.stdout as WriteStream | undefined)?.columns ?? 80)

const buildDaemonConfig = (spec: PtyDaemonSpec) => {
  const opts = {
    name: spec.name,
    command: spec.command,
    args: spec.args !== undefined ? [...spec.args] : [],
    displayCommand: spec.displayCommand ?? spec.command,
    cwd: spec.cwd ?? process.cwd(),
    rows: spec.size?.rows ?? getDefaultRows(),
    cols: spec.size?.cols ?? getDefaultCols(),
    ephemeral: spec.ephemeral ?? false,
  }
  return opts
}

const waitForSocket = (opts: {
  readonly name: string
  readonly signal: AbortSignal
  readonly timeoutMs: number
  readonly earlyCheck?: () => void
}) =>
  new Promise<void>((resolve, reject) => {
    const start = Date.now()
    let pollTimer: NodeJS.Timeout | undefined
    let settleTimer: NodeJS.Timeout | undefined
    let settled = false

    const finish = (effect: () => void) => {
      if (settled === true) return
      settled = true
      if (pollTimer !== undefined) clearTimeout(pollTimer)
      if (settleTimer !== undefined) clearTimeout(settleTimer)
      opts.signal.removeEventListener('abort', onAbort)
      effect()
    }

    const onAbort = () => finish(() => reject(opts.signal.reason))

    const check = () => {
      try {
        opts.earlyCheck?.()
      } catch (cause) {
        finish(() => reject(cause))
        return
      }

      if (Date.now() - start > opts.timeoutMs) {
        finish(() => reject(new Error(`Timeout waiting for session "${opts.name}" to start`)))
        return
      }

      try {
        fs.statSync(getSocketPath(opts.name))
        settleTimer = setTimeout(() => finish(resolve), 100)
        return
      } catch {
        pollTimer = setTimeout(check, 50)
      }
    }

    if (opts.signal.aborted === true) {
      onAbort()
      return
    }

    opts.signal.addEventListener('abort', onAbort, { once: true })
    check()
  })

const spawnDaemonPromise = (spec: PtyDaemonSpec, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const child = spawnChild(resolveDaemonBin(), [], {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        ...spec.env,
        PTY_SERVER_CONFIG: JSON.stringify(buildDaemonConfig(spec)),
      },
    })

    let stderrOutput = ''
    let earlyExit = false
    let earlyExitCode: number | null = null
    let settled = false

    const finish = (effect: () => void) => {
      if (settled === true) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      child.removeListener('exit', onExit)
      child.stderr?.removeListener('data', onStderr)
      effect()
    }

    const onStderr = (data: Buffer) => {
      stderrOutput += data.toString()
    }

    const onExit = (code: number | null) => {
      earlyExit = true
      earlyExitCode = code
    }

    const onAbort = () => {
      try {
        child.kill('SIGTERM')
      } catch {
        // best effort: detached daemon might already be gone
      }
    }

    if (signal.aborted === true) {
      onAbort()
      finish(() => reject(signal.reason))
      return
    }

    child.stderr?.on('data', onStderr)
    child.on('exit', onExit)
    ;(child.stderr as { unref?: () => void } | null)?.unref?.()
    child.unref()
    signal.addEventListener('abort', onAbort, { once: true })

    waitForSocket({
      name: spec.name,
      signal,
      timeoutMs: 3_000,
      earlyCheck: () => {
        if (earlyExit === false) return
        const details = stderrOutput.trim()
        const msg = `Daemon process exited immediately (code ${earlyExitCode ?? 'unknown'}).`
        throw new Error(details.length > 0 ? `${msg}\n${details}` : `${msg} Is the command valid?`)
      },
    }).then(
      () => finish(resolve),
      (cause) => finish(() => reject(cause)),
    )
  })

const connectSessionConnection = (opts: {
  readonly conn: SessionConnection
  readonly signal: AbortSignal
}) =>
  new Promise<string>((resolve, reject) => {
    const onAbort = () => {
      opts.conn.disconnect()
      reject(opts.signal.reason)
    }

    if (opts.signal.aborted === true) {
      onAbort()
      return
    }

    opts.signal.addEventListener('abort', onAbort, { once: true })
    opts.conn.connect().then(
      (screen) => {
        opts.signal.removeEventListener('abort', onAbort)
        resolve(screen)
      },
      (cause) => {
        opts.signal.removeEventListener('abort', onAbort)
        reject(cause)
      },
    )
  })

/** Regex matching helper — clones RegExp to avoid stateful `lastIndex`. */
const matches = (input: { readonly haystack: string; readonly needle: string | RegExp }) => {
  if (Predicate.isString(input.needle) === true) return input.haystack.includes(input.needle)
  const re = new RegExp(input.needle.source, input.needle.flags)
  return re.test(input.haystack)
}

/** Convenience re-export: decode a raw string into a branded PtyName.
 *  Callers should validate at their boundary, then pass the branded
 *  value through to all pty-effect methods. */
export const decodePtyName = Schema.decodeUnknown(PtyName)

/** Runtime defense-in-depth: validates even branded names to produce clean
 *  `BadName` errors when brands are bypassed via `@ts-expect-error` / casts. */
const validateNameOrFail = (name: string) =>
  Effect.try({
    try: () => {
      validateName(name)
      return name
    },
    catch: (cause) =>
      new PtyError({
        reason: 'BadName',
        method: 'validateName',
        name,
        cause,
      }),
  })

const spawnDaemon = (spec: PtyDaemonSpec): Effect.Effect<void, PtyError> =>
  Effect.gen(function* () {
    yield* validateNameOrFail(spec.name)
    yield* wrapPromise({
      method: 'spawnDaemon',
      reason: 'SpawnFailed',
      name: spec.name,
      thunk: (signal) => spawnDaemonPromise(spec, signal),
    })
  }).pipe(Effect.withSpan('pty-client.spawnDaemon', { attributes: { 'span.label': spec.name } }))

const peek = (input: { readonly name: PtyName; readonly plain?: boolean }) =>
  wrapPromise({
    method: 'peek',
    reason: 'ConnectFailed',
    name: input.name,
    thunk: () =>
      upstreamPeekScreen(
        input.plain !== undefined ? { name: input.name, plain: input.plain } : { name: input.name },
      ),
  }).pipe(Effect.withSpan('pty-client.peek', { attributes: { 'span.label': input.name } }))

const list: Effect.Effect<ReadonlyArray<SessionInfo>, PtyError> = wrapPromise({
  method: 'list',
  reason: 'ConnectFailed',
  thunk: () => upstreamListSessions(),
}).pipe(Effect.withSpan('pty-client.list'))

const exists = (input: { readonly name: PtyName }) =>
  pipe(
    list,
    Effect.map((sessions) => sessions.some((s) => s.name === input.name)),
  ).pipe(Effect.withSpan('pty-client.exists', { attributes: { 'span.label': input.name } }))

const kill = (input: { readonly name: PtyName }) =>
  Effect.gen(function* () {
    const sessions = yield* list
    const session = sessions.find((s) => s.name === input.name)
    if (session === undefined || session.pid === null) {
      return yield* new PtyError({
        reason: 'ConnectFailed',
        method: 'kill',
        name: input.name,
      })
    }
    yield* wrapSync({
      method: 'kill',
      name: input.name,
      thunk: () => process.kill(session.pid!, 'SIGTERM'),
    })
  }).pipe(Effect.withSpan('pty-client.kill', { attributes: { 'span.label': input.name } }))

/**
 * Build a `PtyClientSession` from a fresh `SessionConnection`.
 *
 * Lifecycle: the connection itself is acquired via `acquireRelease` so the
 * surrounding scope owns the *socket* (not the daemon — daemon stays up).
 * The byte stream + exit Deferred are wired in `acquire`, before the
 * upstream `connect()` call resolves, so we never miss the initial frames.
 *
 * **Runtime caveat**: Event handlers (`conn.on(...)`) use `Effect.runFork`
 * with the global default runtime. If the consumer provides a custom
 * runtime (e.g. with different loggers, spans, or error handlers), these
 * fire-and-forget effects bypass it. Capturing the runtime properly would
 * require `Effect.runtime` plumbing through the event handlers — tracked
 * as a v2 improvement.
 */
const attach = (spec: PtyAttachSpec): Effect.Effect<PtyClientSession, PtyError, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<Uint8Array>(1024)
    const exitDeferred = yield* Deferred.make<{ readonly code: number }, PtyError>()
    const enc = new TextEncoder()

    const opts: SessionConnectionOptions = {
      name: spec.name,
      rows: spec.size.rows,
      cols: spec.size.cols,
    }

    const conn = yield* wrapSync({
      method: 'attach.construct',
      reason: 'ConnectFailed',
      name: spec.name,
      thunk: () => new SessionConnection(opts),
    })

    conn.on('data', (chunk: string) => {
      Effect.runFork(Queue.offer(queue, enc.encode(chunk)))
    })
    conn.on('exit', (code: number) => {
      Effect.runFork(
        Deferred.succeed(exitDeferred, { code }).pipe(Effect.andThen(Queue.shutdown(queue))),
      )
    })
    conn.on('error', (err: Error) => {
      Effect.runFork(
        Deferred.fail(
          exitDeferred,
          new PtyError({
            reason: 'ConnectFailed',
            method: 'attach.error',
            name: spec.name,
            cause: err,
          }),
        ).pipe(Effect.andThen(Queue.shutdown(queue))),
      )
    })
    conn.on('close', () => {
      Effect.runFork(
        Deferred.fail(
          exitDeferred,
          new PtyError({ reason: 'Closed', method: 'attach.close', name: spec.name }),
        ).pipe(Effect.andThen(Queue.shutdown(queue))),
      )
    })

    const initialScreen = yield* Effect.acquireReleaseInterruptible(
      wrapPromise({
        method: 'attach.connect',
        reason: 'ConnectFailed',
        name: spec.name,
        thunk: (signal) => connectSessionConnection({ conn, signal }),
      }),
      () => Effect.sync(() => conn.disconnect()),
    )

    const bytes: Stream.Stream<Uint8Array, PtyError> = Stream.fromQueue(queue)

    const write: PtyClientSession['write'] = ({ data }) =>
      wrapSync({ method: 'write', name: spec.name, thunk: () => conn.write(data) })

    const typeText: PtyClientSession['type'] = ({ text }) =>
      wrapSync({ method: 'type', name: spec.name, thunk: () => conn.write(text) })

    const press: PtyClientSession['press'] = ({ key }) =>
      wrapSync({ method: 'press', name: spec.name, thunk: () => conn.press(key) })

    const resize: PtyClientSession['resize'] = ({ rows, cols }) =>
      wrapSync({
        method: 'resize',
        reason: 'ResizeFailed',
        name: spec.name,
        thunk: () => conn.resize(rows, cols),
      })

    const screenshot: PtyClientSession['screenshot'] = Effect.gen(function* () {
      const ansi = yield* peek({ name: spec.name, plain: false })
      const text = yield* peek({ name: spec.name, plain: true })
      const lines = text.split('\n')
      return { lines, text, ansi } satisfies Screenshot
    }).pipe(Effect.withSpan('pty-client.screenshot', { attributes: { 'span.label': spec.name } }))

    const waitForText: PtyClientSession['waitForText'] = ({ needle, schedule }) =>
      pipe(
        Stream.repeatEffectWithSchedule(screenshot, schedule ?? defaultPollSchedule),
        Stream.filterMap((ss) =>
          matches({ haystack: ss.text, needle }) === true ? Option.some(ss) : Option.none(),
        ),
        Stream.runHead,
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new PtyError({
                  reason: 'Timeout',
                  method: `waitForText(${String(needle)})`,
                  name: spec.name,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      ).pipe(
        Effect.withSpan('pty-client.waitForText', {
          attributes: { 'span.label': `${spec.name}: ${String(needle)}` },
        }),
      )

    const waitForAbsent: PtyClientSession['waitForAbsent'] = ({ needle, schedule }) =>
      pipe(
        Stream.repeatEffectWithSchedule(screenshot, schedule ?? defaultPollSchedule),
        Stream.filterMap((ss) =>
          matches({ haystack: ss.text, needle }) === false ? Option.some(ss) : Option.none(),
        ),
        Stream.runHead,
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new PtyError({
                  reason: 'Timeout',
                  method: `waitForAbsent(${String(needle)})`,
                  name: spec.name,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      ).pipe(
        Effect.withSpan('pty-client.waitForAbsent', {
          attributes: { 'span.label': `${spec.name}: ${String(needle)}` },
        }),
      )

    return {
      name: spec.name,
      initialScreen,
      bytes,
      write,
      type: typeText,
      press,
      resize,
      screenshot,
      exit: Deferred.await(exitDeferred),
      waitForText,
      waitForAbsent,
    } satisfies PtyClientSession
  }).pipe(Effect.withSpan('pty-client.attach', { attributes: { 'span.label': spec.name } }))

/* ───────────────────────────── layer ────────────────────────────── */

/** Default in-process layer wrapping upstream `@myobie/pty/client` functions. */
export const layer: Layer.Layer<PtyClient> = Layer.succeed(
  PtyClient,
  PtyClient.of({
    spawnDaemon,
    attach,
    peek,
    list,
    exists,
    kill,
  }),
)

/* ───────────────────────── re-exports ────────────────────────────── */

export type { SessionInfo } from '@myobie/pty/client'
export type { Screenshot } from './Screenshot.ts'
