/**
 * `@overeng/pty-effect/client` — Effect-native wrapper around
 * `@myobie/pty/client`.
 *
 * Where the root `@overeng/pty-effect` module wraps `@myobie/pty/testing`
 * (in-process, scope-bound, kill-on-close — useful for TUI testing), this
 * subpath wraps the detached daemon client API for long-lived sessions that
 * survive process restarts.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'

import {
  type EventRecord,
  type ProcessResources,
  type SessionConnectionOptions,
  type SessionInfo,
  type SessionMetadata,
  type SpawnDaemonOptions,
  type StatsResult,
  EventFollower,
  SessionConnection,
  gc as upstreamGc,
  getSession as upstreamGetSession,
  listSessions as upstreamListSessions,
  peekScreen as upstreamPeekScreen,
  queryStats as upstreamQueryStats,
  readRecentEvents as upstreamReadRecentEvents,
  spawnDaemon as upstreamSpawnDaemon,
  updateTags as upstreamUpdateTags,
  validateName,
  waitForSocket as upstreamWaitForSocket,
  getSocketPath,
} from '@myobie/pty/client'
import {
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Predicate,
  Queue,
  Runtime,
  Schedule,
  Schema,
  Stream,
  pipe,
} from 'effect'
import type { Scope } from 'effect'

import { PtyError } from './PtyError.ts'
import { decodePtyEvent, type PtyEvent } from './PtyEvent.ts'
import { PtyName, type TerminalSize } from './PtySpec.ts'
import type { Screenshot } from './Screenshot.ts'

/* ───────────────────────────── specs ────────────────────────────── */

const PtyTags = Schema.Record({ key: Schema.String, value: Schema.String })
const require = createRequire(import.meta.url)

/**
 * Spec for spawning a daemon-mode pty session via `@myobie/pty/client`'s
 * `spawnDaemon`. The daemon is detached and outlives the spawning process.
 *
 * `displayCommand` defaults to `command` and is what `pty list` shows.
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
   *  Applied by temporarily mutating `process.env` around upstream
   *  `spawnDaemon`, which still inherits from the current process. */
  env: Schema.optional(PtyTags),
  /** Structured session metadata persisted by PTY and visible in list/get/events. */
  tags: Schema.optional(PtyTags),
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

/** Lookup a daemon-backed PTY session by name. */
export interface PtyGetSessionSpec {
  readonly name: PtyName
}

/** Send one or more data chunks to a PTY session. */
export interface PtySendDataSpec {
  readonly name: PtyName
  readonly data: ReadonlyArray<string>
  readonly delayMs?: number
}

/** Request live process and terminal stats for a PTY session. */
export interface PtyQueryStatsSpec {
  readonly name: PtyName
  readonly timeoutMs?: number
}

/** Read a bounded number of recent PTY lifecycle events. */
export interface PtyReadRecentEventsSpec {
  readonly name: PtyName
  readonly count?: number
}

/** Follow appended PTY lifecycle events, optionally filtered by session name. */
export interface PtyFollowEventsSpec {
  readonly names?: ReadonlyArray<PtyName>
}

/** Add, replace, or remove persisted PTY tags for a session. */
export interface PtyUpdateTagsSpec {
  readonly name: PtyName
  readonly tags?: Readonly<Record<string, string>>
  readonly removals?: ReadonlyArray<string>
}

/** Default polling schedule for `waitFor*` (50ms fixed). */
export const defaultPollSchedule: Schedule.Schedule<unknown> = Schedule.spaced('50 millis')

/* ──────────────────────── client session handle ─────────────────── */

/** Live attachment handle for a daemon-backed PTY session. */
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
  /** Read the current rendered screen via peek. */
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

/** Effect service wrapping the detached `@myobie/pty/client` API. */
export class PtyClient extends Context.Tag('@overeng/pty-effect/PtyClient')<
  PtyClient,
  {
    readonly spawnDaemon: (spec: PtyDaemonSpec) => Effect.Effect<void, PtyError>
    readonly attach: (spec: PtyAttachSpec) => Effect.Effect<PtyClientSession, PtyError, Scope.Scope>
    readonly peek: (input: {
      readonly name: PtyName
      readonly plain?: boolean
      readonly full?: boolean
    }) => Effect.Effect<string, PtyError>
    readonly list: Effect.Effect<ReadonlyArray<SessionInfo>, PtyError>
    readonly get: (spec: PtyGetSessionSpec) => Effect.Effect<SessionInfo | null, PtyError>
    readonly exists: (input: { readonly name: PtyName }) => Effect.Effect<boolean, PtyError>
    readonly gc: Effect.Effect<ReadonlyArray<string>, PtyError>
    readonly updateTags: (spec: PtyUpdateTagsSpec) => Effect.Effect<void, PtyError>
    readonly sendData: (spec: PtySendDataSpec) => Effect.Effect<void, PtyError>
    readonly queryStats: (spec: PtyQueryStatsSpec) => Effect.Effect<StatsResult, PtyError>
    readonly readRecentEvents: (
      spec: PtyReadRecentEventsSpec,
    ) => Effect.Effect<ReadonlyArray<PtyEvent>, PtyError>
    readonly followEvents: (spec: PtyFollowEventsSpec) => Stream.Stream<PtyEvent, PtyError>
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
  if (spec.tags !== undefined && Object.keys(spec.tags).length > 0) opts.tags = { ...spec.tags }
  return opts
}

/** Regex matching helper — clones RegExp to avoid stateful `lastIndex`. */
const matches = (input: { readonly haystack: string; readonly needle: string | RegExp }) => {
  if (Predicate.isString(input.needle) === true) return input.haystack.includes(input.needle)
  const re = new RegExp(input.needle.source, input.needle.flags)
  return re.test(input.haystack)
}

/** Convenience re-export: decode a raw string into a branded PtyName. */
export const decodePtyName = Schema.decodeUnknown(PtyName)

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

const decodeEvent =
  (opts: { readonly method: string; readonly name?: string }) => (event: EventRecord) =>
    Effect.try({
      try: () => decodePtyEvent(event),
      catch: (cause) =>
        new PtyError({
          reason: 'ConnectFailed',
          method: opts.method,
          name: opts.name,
          cause,
        }),
    })

const withEnvOverrides = <A, E, R>({
  env,
  effect,
}: {
  readonly env: Readonly<Record<string, string>> | undefined
  readonly effect: Effect.Effect<A, E, R>
}): Effect.Effect<A, E, R> => {
  const envOverrides = env !== undefined ? Object.entries(env) : []
  if (envOverrides.length === 0) return effect

  const restore = (saved: ReadonlyArray<readonly [string, string | undefined]>) =>
    Effect.sync(() => {
      for (const [key, previous] of saved) {
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }
    })

  return Effect.sync(() => {
    const saved = envOverrides.map(([key]) => [key, process.env[key]] as const)
    for (const [key, value] of envOverrides) {
      process.env[key] = value
    }
    return saved
  }).pipe(Effect.flatMap((saved) => effect.pipe(Effect.ensuring(restore(saved)))))
}

const resolvePtyServerModulePath = () => require.resolve('@myobie/pty/server')

const spawnDaemonViaNode = (spec: PtyDaemonSpec) =>
  wrapPromise({
    method: 'spawnDaemon',
    reason: 'SpawnFailed',
    name: spec.name,
    thunk: async () => {
      const stdout = process.stdout
      const rows = spec.size?.rows ?? stdout.rows ?? 24
      const cols = spec.size?.cols ?? stdout.columns ?? 80
      const serverModule = resolvePtyServerModulePath()
      const config = JSON.stringify({
        name: spec.name,
        command: spec.command,
        args: spec.args ?? [],
        displayCommand: spec.displayCommand ?? spec.command,
        cwd: spec.cwd ?? process.cwd(),
        rows,
        cols,
        ephemeral: spec.ephemeral ?? false,
        ...(spec.tags !== undefined && Object.keys(spec.tags).length > 0
          ? { tags: spec.tags }
          : {}),
      })

      const child = spawn(process.env['NODE_BIN'] ?? 'node', [serverModule], {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...process.env,
          ...spec.env,
          PTY_SERVER_CONFIG: config,
        },
      })

      let stderrOutput = ''
      let earlyExit = false
      let earlyExitCode: number | null = null

      child.stderr?.on('data', (data) => {
        stderrOutput += data.toString()
      })
      child.on('exit', (code) => {
        earlyExit = true
        earlyExitCode = code
      })

      ;(child.stderr as { unref?: () => void } | null)?.unref?.()
      child.unref()

      try {
        await upstreamWaitForSocket(spec.name, 3_000, () => {
          if (earlyExit === false) return
          const details = stderrOutput.trim()
          const message = `Daemon process exited immediately (code ${earlyExitCode ?? 'unknown'}).`
          throw new Error(
            details.length > 0 ? `${message}\n${details}` : `${message} Is the command valid?`,
          )
        })
      } catch (error) {
        if (earlyExit === false && child.pid !== undefined) {
          try {
            process.kill(child.pid, 'SIGTERM')
          } catch {
            // best effort cleanup
          }
        }
        throw error
      }
    },
  })

const spawnDaemonCompat = (spec: PtyDaemonSpec) =>
  process.versions.bun !== undefined
    ? spawnDaemonViaNode(spec)
    : withEnvOverrides({
        env: spec.env,
        effect: wrapPromise({
          method: 'spawnDaemon',
          reason: 'SpawnFailed',
          name: spec.name,
          thunk: () => upstreamSpawnDaemon(buildSpawnOpts(spec)),
        }),
      })

const spawnDaemon = (spec: PtyDaemonSpec): Effect.Effect<void, PtyError> =>
  Effect.gen(function* () {
    yield* validateNameOrFail(spec.name)
    yield* spawnDaemonCompat(spec)
  }).pipe(Effect.withSpan('pty-client.spawnDaemon', { attributes: { 'span.label': spec.name } }))

const peek = (input: {
  readonly name: PtyName
  readonly plain?: boolean
  readonly full?: boolean
}) =>
  wrapPromise({
    method: 'peek',
    reason: 'ConnectFailed',
    name: input.name,
    thunk: () =>
      upstreamPeekScreen({
        name: input.name,
        ...(input.plain !== undefined ? { plain: input.plain } : {}),
        ...(input.full !== undefined ? { full: input.full } : {}),
      }),
  }).pipe(Effect.withSpan('pty-client.peek', { attributes: { 'span.label': input.name } }))

const list: Effect.Effect<ReadonlyArray<SessionInfo>, PtyError> = wrapPromise({
  method: 'list',
  reason: 'ConnectFailed',
  thunk: () => upstreamListSessions(),
}).pipe(Effect.withSpan('pty-client.list'))

const get = ({ name }: PtyGetSessionSpec) =>
  Effect.gen(function* () {
    yield* validateNameOrFail(name)
    return yield* wrapPromise({
      method: 'getSession',
      reason: 'ConnectFailed',
      name,
      thunk: () => upstreamGetSession(name),
    })
  }).pipe(Effect.withSpan('pty-client.getSession', { attributes: { 'span.label': name } }))

const exists = (input: { readonly name: PtyName }) =>
  pipe(
    list,
    Effect.map((sessions) => sessions.some((session) => session.name === input.name)),
    Effect.withSpan('pty-client.exists', { attributes: { 'span.label': input.name } }),
  )

const gc: Effect.Effect<ReadonlyArray<string>, PtyError> = wrapPromise({
  method: 'gc',
  reason: 'ConnectFailed',
  thunk: () => upstreamGc(),
}).pipe(Effect.withSpan('pty-client.gc'))

const updateTags = (spec: PtyUpdateTagsSpec) =>
  Effect.gen(function* () {
    yield* validateNameOrFail(spec.name)
    yield* wrapSync({
      method: 'updateTags',
      reason: 'WriteFailed',
      name: spec.name,
      thunk: () => upstreamUpdateTags(spec.name, { ...spec.tags }, spec.removals?.slice() ?? []),
    })
  }).pipe(Effect.withSpan('pty-client.updateTags', { attributes: { 'span.label': spec.name } }))

/**
 * Encode a DATA packet for the pty server protocol:
 * `[type: uint8(0)][length: uint32BE][payload: utf8]`
 *
 * Inlined from `@myobie/pty/dist/protocol.js` (MessageType.DATA = 0) to
 * avoid depending on the upstream `sendData` which resolves on `'close'`
 * (requires server to send FIN back). We resolve on `'finish'` instead —
 * our FIN is flushed to the OS kernel, which is sufficient for Unix domain
 * sockets and avoids hangs in Linux namespace CI containers where the
 * server-side `allowHalfOpen: false` automatic FIN is unreliable.
 */
const encodeDataPacket = (data: string): Buffer => {
  const payload = Buffer.from(data)
  const header = Buffer.alloc(5)
  header.writeUInt8(0, 0)
  header.writeUInt32BE(payload.length, 1)
  return Buffer.concat([header, payload])
}

const sendData = (spec: PtySendDataSpec) =>
  Effect.gen(function* () {
    yield* validateNameOrFail(spec.name)
    const socketPath = getSocketPath(spec.name)
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          const socket = createConnection(socketPath)
          socket.on('connect', () => {
            const writeNext = (i: number) => {
              if (i >= spec.data.length) {
                socket.end()
                return
              }
              socket.write(encodeDataPacket(spec.data[i]!))
              if (spec.delayMs !== undefined && i + 1 < spec.data.length) {
                setTimeout(() => writeNext(i + 1), spec.delayMs)
              } else {
                writeNext(i + 1)
              }
            }
            writeNext(0)
          })
          socket.on('finish', resolve)
          socket.on('error', reject)
        }),
      catch: (cause) =>
        new PtyError({ reason: 'WriteFailed', method: 'sendData', name: spec.name, cause }),
    })
  }).pipe(Effect.withSpan('pty-client.sendData', { attributes: { 'span.label': spec.name } }))

const queryStats = (spec: PtyQueryStatsSpec) =>
  Effect.gen(function* () {
    yield* validateNameOrFail(spec.name)
    return yield* wrapPromise({
      method: 'queryStats',
      reason: 'ConnectFailed',
      name: spec.name,
      thunk: () => upstreamQueryStats(spec.name, spec.timeoutMs),
    })
  }).pipe(Effect.withSpan('pty-client.queryStats', { attributes: { 'span.label': spec.name } }))

const readRecentEvents = (spec: PtyReadRecentEventsSpec) =>
  Effect.gen(function* () {
    yield* validateNameOrFail(spec.name)
    const events = yield* wrapSync({
      method: 'readRecentEvents',
      reason: 'ConnectFailed',
      name: spec.name,
      thunk: () => upstreamReadRecentEvents(spec.name, spec.count),
    })
    return yield* Effect.forEach(
      events,
      decodeEvent({ method: 'readRecentEvents', name: spec.name }),
    )
  }).pipe(
    Effect.withSpan('pty-client.readRecentEvents', { attributes: { 'span.label': spec.name } }),
  )

const followEvents = (spec: PtyFollowEventsSpec): Stream.Stream<PtyEvent, PtyError> =>
  Stream.asyncPush<PtyEvent, PtyError>((emit) =>
    Effect.gen(function* () {
      const names = spec.names !== undefined ? [...spec.names] : undefined

      if (names !== undefined) {
        for (const name of names) {
          yield* validateNameOrFail(name)
        }
      }

      const onEvent = (event: EventRecord) => {
        try {
          emit.single(decodePtyEvent(event))
        } catch {
          // Ignore malformed lines from the append-only event log.
        }
      }

      const follower = new EventFollower(names !== undefined ? { names, onEvent } : { onEvent })

      follower.start()

      yield* Effect.addFinalizer(() => Effect.sync(() => follower.stop()))
    }).pipe(Effect.withSpan('pty-client.followEvents')),
  )

const kill = (input: { readonly name: PtyName }) =>
  Effect.gen(function* () {
    const session = yield* get({ name: input.name })
    if (session === null || session.pid === null) {
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

const attach = (spec: PtyAttachSpec): Effect.Effect<PtyClientSession, PtyError, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* Queue.bounded<Uint8Array>(1024)
    const exitDeferred = yield* Deferred.make<{ readonly code: number }, PtyError>()
    const runtime = yield* Effect.runtime<Scope.Scope>()
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

    const runAsync = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => {
      void Runtime.runFork(runtime)(effect)
    }

    conn.on('data', (chunk: string) => {
      runAsync(Queue.offer(queue, enc.encode(chunk)))
    })
    conn.on('exit', (code: number) => {
      runAsync(Deferred.succeed(exitDeferred, { code }).pipe(Effect.andThen(Queue.shutdown(queue))))
    })
    conn.on('error', (err: Error) => {
      runAsync(
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
      runAsync(
        Deferred.fail(
          exitDeferred,
          new PtyError({ reason: 'Closed', method: 'attach.close', name: spec.name }),
        ).pipe(Effect.andThen(Queue.shutdown(queue))),
      )
    })

    const initialScreen = yield* Effect.acquireRelease(
      wrapPromise({
        method: 'attach.connect',
        reason: 'ConnectFailed',
        name: spec.name,
        thunk: () => conn.connect(),
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

/** Default live layer for the detached PTY client wrapper. */
export const layer: Layer.Layer<PtyClient> = Layer.succeed(
  PtyClient,
  PtyClient.of({
    spawnDaemon,
    attach,
    peek,
    list,
    get,
    exists,
    gc,
    updateTags,
    sendData,
    queryStats,
    readRecentEvents,
    followEvents,
    kill,
  }),
)

/* ───────────────────────── re-exports ────────────────────────────── */

export type {
  ProcessResources,
  SessionInfo,
  SessionMetadata,
  StatsResult,
} from '@myobie/pty/client'
export type { Screenshot } from './Screenshot.ts'
