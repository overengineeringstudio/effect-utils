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

import {
  type SessionConnectionOptions,
  type SessionInfo,
  type SpawnDaemonOptions,
  SessionConnection,
  listSessions as upstreamListSessions,
  peekScreen as upstreamPeekScreen,
  spawnDaemon as upstreamSpawnDaemon,
  validateName,
} from '@myobie/pty/client'
import { Cause, Context, Deferred, Effect, Layer, Queue, Schema, Stream, pipe } from 'effect'
import type { Scope } from 'effect'

import { PtyError } from './PtyError.ts'
import { PtyName, type TerminalSize } from './PtySpec.ts'

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
  /** Extra environment variables to set for the spawned daemon process.
   *  Applied via `process.env` mutation before calling upstream `spawnDaemon`
   *  (which inherits parent env) and restored after the call returns. This
   *  avoids callers having to do the mutation themselves.
   *
   *  Common use: `{ PTY_SESSION_DIR: '/path/to/sessions' }` to route the
   *  daemon's socket/pid/json files into a specific directory. */
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
})
export type PtyDaemonSpec = typeof PtyDaemonSpec.Type

/**
 * Initial terminal dimensions sent on attach. The pty server will resize
 * the underlying tty to match.
 */
export interface PtyAttachSpec {
  readonly name: string
  readonly size: TerminalSize
}

/* ──────────────────────── client session handle ─────────────────── */

/**
 * Effect-native handle for a *connected* client session.
 *
 * Acquired via `PtyClient.attach`. The session itself (the daemon) is NOT
 * owned by the surrounding scope — only this connection is. Closing the
 * scope detaches and drops the socket; the daemon keeps running and is
 * reattachable by name.
 *
 * `bytes` and `screens` are bounded queues drained on demand; if no fiber
 * is consuming them, output is buffered. Single-consumer pattern: a stream
 * is intended to be `runForEach`'d once.
 */
export interface PtyClientSession {
  readonly name: string
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
  /** Press a named key (`return`, `up`, `ctrl+c`, etc.). */
  readonly press: (input: { readonly key: string }) => Effect.Effect<void, PtyError>
  /** Renegotiate terminal dimensions. */
  readonly resize: (input: TerminalSize) => Effect.Effect<void, PtyError>
  /**
   * Resolves with the session's exit code when the daemon's child process
   * exits. Fails with `PtyError(reason='Closed')` if the connection is
   * dropped before the session exits.
   */
  readonly exit: Effect.Effect<{ readonly code: number }, PtyError>
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
    /** Spawn a detached daemon session. Resolves once its socket is reachable. */
    readonly spawnDaemon: (spec: PtyDaemonSpec) => Effect.Effect<void, PtyError>
    /**
     * Attach to an existing session by name. Returns a session handle bound
     * to the surrounding scope; closing the scope cleanly detaches.
     */
    readonly attach: (spec: PtyAttachSpec) => Effect.Effect<PtyClientSession, PtyError, Scope.Scope>
    /** Read the current rendered screen of a session, no attach side effects. */
    readonly peek: (input: {
      readonly name: string
      readonly plain?: boolean
    }) => Effect.Effect<string, PtyError>
    /** List all known sessions (running and recently exited). */
    readonly list: Effect.Effect<ReadonlyArray<SessionInfo>, PtyError>
    /** Whether a session by this name currently exists. */
    readonly exists: (input: { readonly name: string }) => Effect.Effect<boolean, PtyError>
  }
>() {}

/* ─────────────────────────── implementation ─────────────────────── */

const wrapPromise = <A>(opts: {
  readonly method: string
  readonly reason?: PtyError['reason']
  readonly thunk: () => Promise<A>
}) =>
  Effect.tryPromise({
    try: opts.thunk,
    catch: (cause) =>
      new PtyError({
        reason: opts.reason ?? 'WriteFailed',
        method: opts.method,
        cause,
        description: Cause.pretty(Cause.die(cause)),
      }),
  })

const wrapSync = <A>(opts: {
  readonly method: string
  readonly reason?: PtyError['reason']
  readonly thunk: () => A
}) =>
  Effect.try({
    try: opts.thunk,
    catch: (cause) =>
      new PtyError({
        reason: opts.reason ?? 'WriteFailed',
        method: opts.method,
        cause,
        description: Cause.pretty(Cause.die(cause)),
      }),
  })

const buildSpawnOpts = (spec: PtyDaemonSpec): SpawnDaemonOptions => {
  const opts: SpawnDaemonOptions = {
    name: spec.name,
    command: spec.command,
    args: spec.args !== undefined ? [...spec.args] : [],
    displayCommand: spec.displayCommand ?? spec.command,
  }
  if (spec.cwd !== undefined) opts.cwd = spec.cwd
  if (spec.ephemeral !== undefined) opts.ephemeral = spec.ephemeral
  if (spec.size?.rows !== undefined) opts.rows = spec.size.rows
  if (spec.size?.cols !== undefined) opts.cols = spec.size.cols
  return opts
}

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
        description: cause instanceof Error ? cause.message : String(cause),
      }),
  })

const spawnDaemon = (spec: PtyDaemonSpec): Effect.Effect<void, PtyError> =>
  Effect.gen(function* () {
    yield* validateNameOrFail(spec.name)

    /** Upstream `spawnDaemon` reads env vars like `PTY_SESSION_DIR` from
     *  `process.env` (the child inherits the parent's env). To support
     *  caller-specified env overrides without leaking mutations, we
     *  set → call → restore in a `try/finally` block. */
    const envOverrides = spec.env !== undefined ? Object.entries(spec.env) : []
    const saved = envOverrides.map(([k]) => [k, process.env[k]] as const)
    for (const [k, v] of envOverrides) process.env[k] = v
    try {
      yield* wrapPromise({
        method: 'spawnDaemon',
        reason: 'SpawnFailed',
        thunk: () => upstreamSpawnDaemon(buildSpawnOpts(spec)),
      })
    } finally {
      for (const [k, prev] of saved) {
        if (prev === undefined) delete process.env[k]
        else process.env[k] = prev
      }
    }
  })

const peek = (input: { readonly name: string; readonly plain?: boolean }) =>
  wrapPromise({
    method: 'peek',
    reason: 'ConnectFailed',
    thunk: () =>
      upstreamPeekScreen(
        input.plain !== undefined ? { name: input.name, plain: input.plain } : { name: input.name },
      ),
  })

const list: Effect.Effect<ReadonlyArray<SessionInfo>, PtyError> = wrapPromise({
  method: 'list',
  reason: 'ConnectFailed',
  thunk: () => upstreamListSessions(),
})

const exists = (input: { readonly name: string }) =>
  pipe(
    list,
    Effect.map((sessions) => sessions.some((s) => s.name === input.name)),
  )

/**
 * Build a `PtyClientSession` from a fresh `SessionConnection`.
 *
 * Lifecycle: the connection itself is acquired via `acquireRelease` so the
 * surrounding scope owns the *socket* (not the daemon — daemon stays up).
 * The byte stream + exit Deferred are wired in `acquire`, before the
 * upstream `connect()` call resolves, so we never miss the initial frames.
 */
const attach = (spec: PtyAttachSpec): Effect.Effect<PtyClientSession, PtyError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* validateNameOrFail(spec.name)

    /** Bytes queue. Bounded to 1024 to apply backpressure if the consumer
     *  (e.g. a slow WebSocket) falls behind a fast-printing tty. */
    const queue = yield* Queue.bounded<Uint8Array>(1024)
    const exitDeferred = yield* Deferred.make<{ readonly code: number }, PtyError>()
    const enc = new TextEncoder()

    const opts: SessionConnectionOptions = {
      name: spec.name,
      rows: spec.size.rows,
      cols: spec.size.cols,
    }

    /** Build the connection up-front so listeners can be attached *before*
     *  `connect()` is awaited. SessionConnection extends EventEmitter and is
     *  side-effect-free in its constructor. */
    const conn = yield* wrapSync({
      method: 'attach.construct',
      reason: 'ConnectFailed',
      thunk: () => new SessionConnection(opts),
    })

    /** Pre-attach all listeners synchronously. Even though `connect()` only
     *  resolves after the SCREEN packet, upstream may have already enqueued
     *  DATA bytes by then — we want them all. */
    conn.on('data', (chunk: string) => {
      Effect.runFork(Queue.offer(queue, enc.encode(chunk)))
    })
    conn.on('exit', (code: number) => {
      Effect.runFork(Deferred.succeed(exitDeferred, { code }))
      Effect.runFork(Queue.shutdown(queue))
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
            description: err.message,
          }),
        ),
      )
    })
    conn.on('close', () => {
      /** If the daemon hasn't sent EXIT yet but the socket closed, surface
       *  it as `Closed`. `Deferred.fail` is a no-op if it already resolved. */
      Effect.runFork(
        Deferred.fail(
          exitDeferred,
          new PtyError({
            reason: 'Closed',
            method: 'attach.close',
            name: spec.name,
          }),
        ),
      )
      Effect.runFork(Queue.shutdown(queue))
    })

    /** Acquire the connection: actually opens the socket. Release detaches.
     *  Upstream `disconnect()` writes a DETACH frame and closes the socket;
     *  the daemon keeps running and other clients (or a future reattach)
     *  remain unaffected. */
    const initialScreen = yield* Effect.acquireRelease(
      wrapPromise({
        method: 'attach.connect',
        reason: 'ConnectFailed',
        thunk: () => conn.connect(),
      }),
      () => Effect.sync(() => conn.disconnect()),
    )

    const bytes: Stream.Stream<Uint8Array, PtyError> = Stream.fromQueue(queue)

    const write: PtyClientSession['write'] = ({ data }) =>
      wrapSync({ method: 'write', thunk: () => conn.write(data) })

    const press: PtyClientSession['press'] = ({ key }) =>
      wrapSync({ method: 'press', thunk: () => conn.press(key) })

    const resize: PtyClientSession['resize'] = ({ rows, cols }) =>
      wrapSync({
        method: 'resize',
        reason: 'ResizeFailed',
        thunk: () => conn.resize(rows, cols),
      })

    return {
      name: spec.name,
      initialScreen,
      bytes,
      write,
      press,
      resize,
      exit: Deferred.await(exitDeferred),
    } satisfies PtyClientSession
  })

/* ───────────────────────────── layer ────────────────────────────── */

/** Default in-process layer. No external state — just wraps the upstream
 *  client functions in `PtyError`-tagged Effects. */
export const layer: Layer.Layer<PtyClient> = Layer.succeed(
  PtyClient,
  PtyClient.of({
    spawnDaemon,
    attach,
    peek,
    list,
    exists,
  }),
)

/* ───────────────────────── re-exports ────────────────────────────── */

export type { SessionInfo } from '@myobie/pty/client'
