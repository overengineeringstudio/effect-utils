import { Session as UpstreamSession } from '@myobie/pty/testing'
import { Cause, Effect, Option, Predicate, Schedule, Stream, pipe } from 'effect'
import type { Scope } from 'effect'

import { PtyError } from './PtyError.ts'
import type { Key } from './PtyKey.ts'
import type { PtySpec, TerminalSize } from './PtySpec.ts'
import type { Screenshot } from './Screenshot.ts'

/**
 * Effect-native handle around upstream's `Session`.
 *
 * Lifecycle is bound to a `Scope`: `make` returns an `Effect` that requires a
 * `Scope` and registers a finalizer calling `session.close()`. For `Spawn`
 * specs that kills the child process; for `Server` specs that destroys the
 * socket and the owned `PtyServer`.
 *
 * Design tradeoff — kill-on-close is the default and only mode. We
 * deliberately do not expose a "leak the daemon" escape hatch. Effect's
 * scoping contract is: when the scope closes, resources are released. A pty
 * that survives its owning scope is either (a) a long-lived service that
 * should own its own root scope (use `Layer.scopedDiscard`), or (b) a bug.
 */
export interface PtySession {
  readonly spec: PtySpec
  readonly screenshot: Effect.Effect<Screenshot, PtyError>
  readonly write: (input: { readonly data: string }) => Effect.Effect<void, PtyError>
  readonly type: (input: { readonly text: string }) => Effect.Effect<void, PtyError>
  readonly press: (input: { readonly key: Key }) => Effect.Effect<void, PtyError>
  readonly resize: (input: TerminalSize) => Effect.Effect<void, PtyError>
  /** Server-mode only. Fails with `ConnectFailed` in spawn mode. */
  readonly attach: Effect.Effect<void, PtyError>
  /** Server-mode only. Fails with `ConnectFailed` in spawn mode. */
  readonly reconnect: Effect.Effect<void, PtyError>
  /**
   * Stream of screenshots polled on the given `Schedule`. Unbounded; combine
   * with `Stream.take`, `Stream.takeUntil`, or scope finalization to terminate.
   */
  readonly screenshots: (input: {
    readonly schedule: Schedule.Schedule<unknown>
  }) => Stream.Stream<Screenshot, PtyError>
  /**
   * Polls the terminal on a `Schedule` until `predicate` returns `Some`.
   * Compose with `Effect.timeout` for deadlines, `Effect.race` for cancellation.
   */
  readonly waitFor: <A>(input: {
    readonly predicate: (snapshot: Screenshot) => Option.Option<A>
    readonly schedule?: Schedule.Schedule<unknown>
    readonly label?: string
  }) => Effect.Effect<A, PtyError>
  readonly waitForText: (input: {
    readonly needle: string | RegExp
    readonly schedule?: Schedule.Schedule<unknown>
  }) => Effect.Effect<Screenshot, PtyError>
  readonly waitForAbsent: (input: {
    readonly needle: string | RegExp
    readonly schedule?: Schedule.Schedule<unknown>
  }) => Effect.Effect<Screenshot, PtyError>
}

/** Default polling schedule for `waitFor*` (50ms fixed). */
export const defaultPollSchedule: Schedule.Schedule<unknown> = Schedule.spaced('50 millis')

interface WrapSyncOpts<A> {
  readonly method: string
  readonly reason?: PtyError['reason']
  readonly thunk: () => A
}

const wrapSync = <A>(opts: WrapSyncOpts<A>) =>
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

interface WrapPromiseOpts<A> {
  readonly method: string
  readonly reason?: PtyError['reason']
  readonly thunk: () => Promise<A>
}

const wrapPromise = <A>(opts: WrapPromiseOpts<A>) =>
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

const matches = (input: { readonly haystack: string; readonly needle: string | RegExp }) =>
  Predicate.isString(input.needle) === true
    ? input.haystack.includes(input.needle)
    : input.needle.test(input.haystack)

// Build options objects that omit undefined fields entirely. Required because
// both upstream and our tsconfig use `exactOptionalPropertyTypes`, which
// forbids passing `field: undefined` for optional fields.
const buildSpawnOpts = (
  spec: Extract<PtySpec, { _tag: 'Spawn' }>,
): Parameters<typeof UpstreamSession.spawn>[2] => {
  const opts: NonNullable<Parameters<typeof UpstreamSession.spawn>[2]> = {}
  if (spec.size?.rows !== undefined) opts.rows = spec.size.rows
  if (spec.size?.cols !== undefined) opts.cols = spec.size.cols
  if (spec.cwd !== undefined) opts.cwd = spec.cwd
  if (spec.env !== undefined) opts.env = spec.env as Record<string, string>
  return opts
}

const buildServerOpts = (
  spec: Extract<PtySpec, { _tag: 'Server' }>,
): Parameters<typeof UpstreamSession.server>[2] => {
  const opts: NonNullable<Parameters<typeof UpstreamSession.server>[2]> = {}
  if (spec.size?.rows !== undefined) opts.rows = spec.size.rows
  if (spec.size?.cols !== undefined) opts.cols = spec.size.cols
  if (spec.cwd !== undefined) opts.cwd = spec.cwd
  if (spec.name !== undefined) opts.name = spec.name as string
  return opts
}

const acquire = (spec: PtySpec): Effect.Effect<UpstreamSession, PtyError> => {
  const args = spec.args !== undefined ? [...spec.args] : []
  return spec._tag === 'Spawn'
    ? wrapSync({
        method: 'PtySession.acquire',
        reason: 'SpawnFailed',
        thunk: () => UpstreamSession.spawn(spec.command, args, buildSpawnOpts(spec)),
      })
    : wrapPromise({
        method: 'PtySession.acquire',
        reason: 'SpawnFailed',
        thunk: () => UpstreamSession.server(spec.command, args, buildServerOpts(spec)),
      })
}

const release = (raw: UpstreamSession): Effect.Effect<void> =>
  Effect.promise(() => raw.close()).pipe(Effect.orDie)

/**
 * Build a `PtySession` bound to the current scope. The underlying upstream
 * `Session` is created in the acquire step and closed (killing the child or
 * destroying the server) in the finalizer.
 */
export const make = (spec: PtySpec): Effect.Effect<PtySession, PtyError, Scope.Scope> =>
  Effect.gen(function* () {
    const raw = yield* Effect.acquireRelease(acquire(spec), release)

    const screenshot: Effect.Effect<Screenshot, PtyError> = wrapSync({
      method: 'screenshot',
      thunk: () => {
        const ss = raw.screenshot()
        return {
          lines: [...ss.lines],
          text: ss.text,
          ansi: ss.ansi,
        } satisfies Screenshot
      },
    })

    const write: PtySession['write'] = ({ data }) =>
      wrapSync({ method: 'write', thunk: () => raw.sendKeys(data) })

    const typeText: PtySession['type'] = ({ text }) =>
      wrapSync({ method: 'type', thunk: () => raw.type(text) })

    const press: PtySession['press'] = ({ key }) =>
      wrapSync({ method: 'press', thunk: () => raw.press(key as unknown as string) })

    const resize: PtySession['resize'] = ({ rows, cols }) =>
      wrapSync({
        method: 'resize',
        reason: 'ResizeFailed',
        thunk: () => raw.resize(rows, cols),
      })

    const attach: Effect.Effect<void, PtyError> = wrapPromise({
      method: 'attach',
      reason: 'ConnectFailed',
      thunk: () => raw.attach(),
    })

    const reconnect: Effect.Effect<void, PtyError> = wrapPromise({
      method: 'reconnect',
      reason: 'ConnectFailed',
      thunk: () => raw.reconnect(),
    })

    const screenshots: PtySession['screenshots'] = ({ schedule }) =>
      Stream.repeatEffectWithSchedule(screenshot, schedule)

    /**
     * Poll the terminal on a `Schedule` until `predicate` returns `Some`.
     *
     * Implementation note: built on `Stream.repeatEffectWithSchedule` +
     * `Stream.filterMap` + `Stream.runHead`. This gives us, for free:
     *   - any `Schedule` for cadence/backoff (fixed, exponential, jittered, ...)
     *   - composability with `Effect.timeout` for deadlines
     *   - composability with `Effect.race`/`Effect.interrupt` for cancellation
     *   - clean scope-bound finalization (the underlying screenshot Effect
     *     stops the moment the surrounding fiber is interrupted)
     */
    const waitForImpl = <A>(opts: {
      predicate: (snapshot: Screenshot) => Option.Option<A>
      schedule: Schedule.Schedule<unknown>
      label: string | undefined
    }): Effect.Effect<A, PtyError> =>
      pipe(
        screenshots({ schedule: opts.schedule }),
        Stream.filterMap(opts.predicate),
        Stream.runHead,
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new PtyError({
                  reason: 'Timeout',
                  method: 'waitFor',
                  description: opts.label,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      )

    const waitFor: PtySession['waitFor'] = (input) =>
      waitForImpl({
        predicate: input.predicate,
        schedule: input.schedule ?? defaultPollSchedule,
        label: input.label,
      })

    const waitForText: PtySession['waitForText'] = ({ needle, schedule }) =>
      waitForImpl({
        predicate: (ss) =>
          matches({ haystack: ss.text, needle }) === true ? Option.some(ss) : Option.none(),
        schedule: schedule ?? defaultPollSchedule,
        label: `waitForText(${String(needle)})`,
      })

    const waitForAbsent: PtySession['waitForAbsent'] = ({ needle, schedule }) =>
      waitForImpl({
        predicate: (ss) =>
          matches({ haystack: ss.text, needle }) === false ? Option.some(ss) : Option.none(),
        schedule: schedule ?? defaultPollSchedule,
        label: `waitForAbsent(${String(needle)})`,
      })

    const session: PtySession = {
      spec,
      screenshot,
      write,
      type: typeText,
      press,
      resize,
      attach,
      reconnect,
      screenshots,
      waitFor,
      waitForText,
      waitForAbsent,
    }
    return session
  })
