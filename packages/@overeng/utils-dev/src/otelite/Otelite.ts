import { Command, CommandExecutor, FileSystem } from '@effect/platform'
import { Deferred, Effect, Fiber, Ref, Schedule, Schema, type Scope, Stream } from 'effect'

import {
  cliReasonForExitCode,
  OteliteChildFailed,
  OteliteCliError,
  OteliteDecodeError,
  OteliteSpawnError,
} from './errors.ts'
import {
  EndpointsEvent,
  LogRow,
  LogSummary,
  MetricRow,
  MetricSummary,
  SpanRow,
  Summary,
  TraceSummary,
} from './schema.ts'

/** The three OTLP signals `inspect` understands. */
export type Signal = 'traces' | 'metrics' | 'logs'

/** Options for {@link Otelite.run}. */
export interface RunOptions {
  /** The child command to run under capture, e.g. `["node", "app.js"]`. */
  readonly command: ReadonlyArray<string>
  /** Capture out-dir; when omitted otelite mints a unique one (auto-cleaned on scope close). */
  readonly out?: string
  /** Sets `--service` (wins over the child's `OTEL_SERVICE_NAME`). */
  readonly service?: string
  /** Sets `--drain-idle <ms>` for fire-and-forget emitters. */
  readonly drainIdleMs?: number
  /** Force a fixed HTTP receiver port (`--http-port`); default ephemeral `:0`. */
  readonly httpPort?: number
  /** Force a fixed gRPC receiver port (`--grpc-port`); default ephemeral `:0`. */
  readonly grpcPort?: number
}

/** Options for {@link Otelite.capture}. */
export interface CaptureOptions {
  /** Capture out-dir; when omitted otelite mints a unique one (auto-cleaned on scope close). */
  readonly out?: string
  /** Force a fixed HTTP receiver port (`--http-port`); default ephemeral `:0`. */
  readonly httpPort?: number
  /** Force a fixed gRPC receiver port (`--grpc-port`); default ephemeral `:0`. */
  readonly grpcPort?: number
}

/** Filters/signal for {@link CaptureHandle.inspect} — `src` is pinned to the out-dir. */
interface CaptureInspectBase {
  /** Exact-match `--service` filter (rows only). */
  readonly service?: string
  /** Exact-match `--name` filter (rows only). */
  readonly name?: string
  /** Exact-match `--attr k=v` filters (rows only). */
  readonly attrs?: Readonly<Record<string, string>>
}

/**
 * A live capture handle yielded by {@link Otelite.capture} as a scoped resource.
 * The receiver is serving while the handle is open; closing the scope stops it
 * (stdin EOF), drains in-flight exports, and resolves {@link CaptureHandle.summary}.
 */
export interface CaptureHandle {
  /** The ephemeral receiver endpoints (base URLs), from the `otelite.endpoints/v1` event. */
  readonly endpoints: { readonly http: string; readonly grpc: string }
  /** The capture out-dir (otelite-minted or the caller's `out`). */
  readonly outDir: string
  /**
   * Inspect the LIVE capture, `src` pinned to {@link CaptureHandle.outDir}.
   * Same typed overloads as {@link Otelite.inspect}. Row reads short-poll-retry
   * on a transient 0-row result (see capture's bounded-retry note).
   */
  readonly inspect: {
    <S extends Signal>(
      options: CaptureInspectBase & { readonly signal: S; readonly summary: true },
    ): Effect.Effect<InspectSummary<S>, OteliteSpawnError | OteliteCliError | OteliteDecodeError>
    <S extends Signal>(
      options: CaptureInspectBase & { readonly signal: S; readonly summary?: false },
    ): Effect.Effect<
      ReadonlyArray<InspectRow<S>>,
      OteliteSpawnError | OteliteCliError | OteliteDecodeError
    >
  }
  /**
   * The drained `otelite.summary/v1`, available only after the scope closes
   * (the receiver stopped). Awaiting it before release blocks until stop.
   */
  readonly summary: Effect.Effect<Summary, OteliteDecodeError>
}

/** Options shared by all {@link Otelite.inspect} overloads. */
interface InspectBase {
  /** Capture source: a dir, a single `*.ndjson` file, or `-` for stdin. */
  readonly src: string
  /** Exact-match `--service` filter (rows only). */
  readonly service?: string
  /** Exact-match `--name` filter (rows only). */
  readonly name?: string
  /** Exact-match `--attr k=v` filters (rows only). */
  readonly attrs?: Readonly<Record<string, string>>
}

/** The decoded result of `inspect <src> --summary`, keyed by signal. */
type InspectSummary<S extends Signal> = S extends 'traces'
  ? TraceSummary
  : S extends 'metrics'
    ? MetricSummary
    : LogSummary

/** The decoded flat-row result of `inspect <src>`, keyed by signal. */
type InspectRow<S extends Signal> = S extends 'traces'
  ? SpanRow
  : S extends 'metrics'
    ? MetricRow
    : LogRow

const decodeSummary = Schema.decodeUnknown(Schema.parseJson(Summary))
const decodeEndpointsEvent = Schema.decodeUnknown(Schema.parseJson(EndpointsEvent))

const rowSchema = { traces: SpanRow, metrics: MetricRow, logs: LogRow } as const
const rowKind = { traces: 'span', metrics: 'metric', logs: 'log' } as const
const summarySchema = { traces: TraceSummary, metrics: MetricSummary, logs: LogSummary } as const
const summaryKind = {
  traces: 'trace-summary',
  metrics: 'metric-summary',
  logs: 'log-summary',
} as const

/**
 * Effect-native wrapper around the `otelite` CLI. Shells out via
 * `@effect/platform` `Command` (never `node:child_process`), decodes the CLI's
 * JSON contract with `Schema`, and surfaces otelite's `sysexits.h` taxonomy as
 * tagged errors. The CLI's JSON output is the single source of truth — this
 * service never reimplements capture/inspect logic.
 *
 * The `otelite` binary is resolved from `PATH`. Tests put the nix-built binary
 * on `PATH` (see the package README).
 */
export class Otelite extends Effect.Service<Otelite>()('@overeng/utils-dev/otelite/Otelite', {
  accessors: true,
  effect: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor
    const fs = yield* FileSystem.FileSystem

    const binary = 'otelite'

    /**
     * Run otelite and collect its stdout + exit code. Spawn failures become
     * {@link OteliteSpawnError}; the caller decides how to interpret the exit.
     */
    const exec = (args: ReadonlyArray<string>) =>
      Effect.scoped(
        Effect.gen(function* () {
          const process = yield* executor.start(Command.make(binary, ...args))
          const collect = (stream: typeof process.stdout) =>
            Stream.runCollect(Stream.decodeText(stream)).pipe(
              Effect.map((chunks) => Array.from(chunks).join('')),
            )
          const [exitCode, stdout, stderr] = yield* Effect.all(
            [process.exitCode, collect(process.stdout), collect(process.stderr)],
            { concurrency: 'unbounded' },
          )
          return { exitCode, stdout, stderr }
        }),
      ).pipe(
        Effect.mapError((cause) => new OteliteSpawnError({ argv: [binary, ...args], cause })),
        Effect.withSpan('otelite.exec', { attributes: { 'otelite.argv': args } }),
      )

    /**
     * Run a child command under capture (`otelite run [flags] -- <command>`),
     * returning the decoded `otelite.summary/v1`.
     *
     * Scoped: when otelite mints the out-dir (no `out` given), it is removed on
     * scope close so concurrent test runs leave no residue.
     *
     * A non-zero child surfaces as {@link OteliteChildFailed} (the summary is
     * still available on the error's capture path); otelite's own `sysexits.h`
     * failures (empty stdout) surface as {@link OteliteCliError}.
     */
    const run = (options: RunOptions) =>
      Effect.gen(function* () {
        const flags: Array<string> = ['run']
        if (options.out !== undefined) flags.push('--out', options.out)
        if (options.service !== undefined) flags.push('--service', options.service)
        if (options.drainIdleMs !== undefined)
          flags.push('--drain-idle', String(options.drainIdleMs))
        if (options.httpPort !== undefined) flags.push('--http-port', String(options.httpPort))
        if (options.grpcPort !== undefined) flags.push('--grpc-port', String(options.grpcPort))
        const args = [...flags, '--', ...options.command]

        const { exitCode, stdout, stderr } = yield* exec(args)

        // Empty stdout + non-zero exit ⇒ otelite's own sysexits failure.
        if (stdout.trim() === '' && exitCode !== 0) {
          return yield* new OteliteCliError({
            exitCode,
            reason: cliReasonForExitCode(exitCode),
            argv: [binary, ...args],
            stderr,
          })
        }

        const summary = yield* decodeSummary(stdout).pipe(
          Effect.mapError(
            (cause) => new OteliteDecodeError({ kind: 'summary', raw: stdout, cause }),
          ),
        )

        // Clean up an otelite-minted out-dir when the caller's scope closes.
        if (options.out === undefined) {
          yield* Effect.addFinalizer(() =>
            fs.remove(summary.out, { recursive: true }).pipe(Effect.ignore),
          )
        }

        // Non-zero child: summary was emitted, but the child failed.
        if (exitCode !== 0) {
          return yield* new OteliteChildFailed({
            exitCode,
            argv: options.command,
            stderr,
          })
        }

        return summary
      }).pipe(Effect.withSpan('otelite.run'))

    const runCli = <A>(
      args: ReadonlyArray<string>,
      decode: (stdout: string) => Effect.Effect<A, OteliteDecodeError>,
    ) =>
      Effect.gen(function* () {
        const { exitCode, stdout, stderr } = yield* exec(args)
        if (exitCode !== 0) {
          return yield* new OteliteCliError({
            exitCode,
            reason: cliReasonForExitCode(exitCode),
            argv: [binary, ...args],
            stderr,
          })
        }
        return yield* decode(stdout)
      })

    const inspectArgs = (signal: Signal, base: InspectBase, summary: boolean) => {
      const args: Array<string> = ['inspect', base.src, '--signal', signal]
      if (base.service !== undefined) args.push('--service', base.service)
      if (base.name !== undefined) args.push('--name', base.name)
      for (const [k, v] of Object.entries(base.attrs ?? {})) args.push('--attr', `${k}=${v}`)
      if (summary === true) args.push('--summary')
      return args
    }

    /**
     * Inspect a capture. Without `summary`, decodes the NDJSON flat rows
     * (`otelite.span/v1` / `otelite.metric/v1` / `otelite.log/v1`) into typed
     * arrays. With `summary: true`, decodes the single report object for the
     * signal. Filters (`service`/`name`/`attrs`) narrow flat rows only.
     */
    function inspect<S extends Signal>(
      options: InspectBase & { readonly signal: S; readonly summary: true },
    ): Effect.Effect<InspectSummary<S>, OteliteSpawnError | OteliteCliError | OteliteDecodeError>
    function inspect<S extends Signal>(
      options: InspectBase & { readonly signal: S; readonly summary?: false },
    ): Effect.Effect<
      ReadonlyArray<InspectRow<S>>,
      OteliteSpawnError | OteliteCliError | OteliteDecodeError
    >
    function inspect(
      options: InspectBase & { readonly signal: Signal; readonly summary?: boolean },
    ): Effect.Effect<unknown, OteliteSpawnError | OteliteCliError | OteliteDecodeError> {
      const { signal, summary = false, ...base } = options
      const args = inspectArgs(signal, base, summary)
      if (summary === true) {
        const schema = summarySchema[signal]
        const kind = summaryKind[signal]
        return runCli(args, (stdout) =>
          Schema.decodeUnknown(Schema.parseJson(schema))(stdout).pipe(
            Effect.mapError((cause) => new OteliteDecodeError({ kind, raw: stdout, cause })),
          ),
        ).pipe(Effect.withSpan('otelite.inspect.summary', { attributes: { signal } }))
      }
      const schema = rowSchema[signal]
      const kind = rowKind[signal]
      const decodeRow = Schema.decodeUnknown(Schema.parseJson(schema))
      return runCli(args, (stdout) =>
        Effect.forEach(
          stdout.split('\n').filter((line) => line.trim() !== ''),
          (line) =>
            decodeRow(line).pipe(
              Effect.mapError((cause) => new OteliteDecodeError({ kind, raw: line, cause })),
            ),
        ),
      ).pipe(Effect.withSpan('otelite.inspect', { attributes: { signal } }))
    }

    /**
     * Bounded short-poll retry for a LIVE row read that returns 0 rows.
     *
     * Why: the handle's `inspect` reads a capture the receiver is still serving.
     * The sink writes each export with a raw `write_all` to the file *before*
     * acking (no `BufWriter`), so a captured span is durable in the file the
     * instant the POST returns. But an independent reader process started right
     * after can still transiently observe 0 rows for a few ms — pure scheduler /
     * fs-visibility latency between the writing process's `write_all` and the
     * reader's `open`+`read` landing. So we re-read a handful of times over a few
     * tens of ms before concluding the capture is genuinely empty. A real empty
     * capture costs the full (still small, bounded) budget exactly once.
     */
    const liveRowRetry = Schedule.recurs(5).pipe(Schedule.addDelay(() => '8 millis'))

    /**
     * A scoped, receiver-only capture (`otelite capture`). Yields a
     * {@link CaptureHandle} for a harness that owns the system-under-test
     * lifecycle itself (vs {@link run}, which spawns the SUT). The handle's scope
     * IS the capture's lifetime: on scope close we stop the receiver by closing
     * the child's stdin (EOF — no signal/PID plumbing), await its exit, and
     * decode the final `otelite.summary/v1` line.
     *
     * stdout is a tagged event stream (`otelite.endpoints/v1` first,
     * `otelite.summary/v1` last). We dispatch by `schema` via `Schema` decode —
     * never string-scrape. A background fiber drains the WHOLE stdout stream
     * (otelite panics on a broken stdout pipe, so we must never close it early);
     * the first line resolves the readiness `Deferred`, the last line is the
     * summary.
     */
    const capture = (
      options: CaptureOptions = {},
    ): Effect.Effect<
      CaptureHandle,
      OteliteSpawnError | OteliteCliError | OteliteDecodeError,
      Scope.Scope
    > =>
      Effect.gen(function* () {
        const flags: Array<string> = ['capture']
        if (options.out !== undefined) flags.push('--out', options.out)
        if (options.httpPort !== undefined) flags.push('--http-port', String(options.httpPort))
        if (options.grpcPort !== undefined) flags.push('--grpc-port', String(options.grpcPort))

        // Stop signal: a stdin Stream that emits nothing and completes when this
        // resolves. The Node executor pumps the stream into the child's stdin and
        // calls `writable.end()` on completion → the child sees EOF and stops.
        const stop = yield* Deferred.make<void>()
        const stdinStream = Stream.fromEffect(Deferred.await(stop)).pipe(Stream.drain)

        const command = Command.make(binary, ...flags).pipe(
          Command.stdin(stdinStream),
          Command.stdout('pipe'),
        )

        const process = yield* executor
          .start(command)
          .pipe(
            Effect.mapError((cause) => new OteliteSpawnError({ argv: [binary, ...flags], cause })),
          )

        const ready = yield* Deferred.make<EndpointsEvent, OteliteDecodeError>()
        const lastLine = yield* Ref.make<string | undefined>(undefined)
        const seenFirst = yield* Ref.make(false)

        // Drain the entire tagged event stream; resolve `ready` on the first line
        // (decoded as `otelite.endpoints/v1`), keep the latest line for the summary.
        const drain = yield* process.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.filter((line) => line.trim() !== ''),
          Stream.tap((line) =>
            Effect.gen(function* () {
              yield* Ref.set(lastLine, line)
              const wasFirst = yield* Ref.getAndSet(seenFirst, true)
              if (wasFirst === false) {
                yield* decodeEndpointsEvent(line).pipe(
                  Effect.matchEffect({
                    onSuccess: (event) => Deferred.succeed(ready, event),
                    onFailure: (cause) =>
                      Deferred.fail(
                        ready,
                        new OteliteDecodeError({ kind: 'summary', raw: line, cause }),
                      ),
                  }),
                )
              }
            }),
          ),
          Stream.runDrain,
          Effect.forkScoped,
        )

        // Bounded readiness wait: a healthy `capture` emits the endpoints line the
        // instant both listeners bind. If the process dies before that, await the
        // drain failure / exit instead of hanging on the Deferred.
        const endpoints = yield* Deferred.await(ready).pipe(
          Effect.race(
            Fiber.join(drain).pipe(
              Effect.matchEffect({
                onFailure: () => process.exitCode.pipe(Effect.orElseSucceed(() => 74)),
                onSuccess: () => process.exitCode.pipe(Effect.orElseSucceed(() => 0)),
              }),
              Effect.flatMap(
                (exitCode) =>
                  new OteliteCliError({
                    exitCode,
                    reason: cliReasonForExitCode(exitCode),
                    argv: [binary, ...flags],
                  }),
              ),
            ),
          ),
          Effect.timeoutFail({
            duration: '10 seconds',
            onTimeout: () =>
              new OteliteCliError({
                exitCode: 74,
                reason: 'io-err',
                argv: [binary, ...flags],
                stderr: 'otelite capture did not emit endpoints within the readiness bound',
              }),
          }),
        )

        // Stop + drain on scope close: close stdin (EOF), await the stdout drain
        // and the process exit, then decode the final line as the summary. Made
        // idempotent + interrupt-safe so an interrupted scope still tears the
        // child down (no leaked `otelite capture`).
        const summaryDeferred = yield* Deferred.make<Summary, OteliteDecodeError>()
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(stop, undefined)
            // Await the drained stdout, but never hang teardown: if the child is
            // wedged, fall back to a kill so the scope always closes.
            yield* Fiber.join(drain).pipe(
              Effect.zipRight(process.exitCode),
              Effect.timeout('10 seconds'),
              Effect.catchAll(() => process.kill().pipe(Effect.ignore)),
            )
            const line = yield* Ref.get(lastLine)
            yield* decodeSummary(line ?? '').pipe(
              Effect.matchEffect({
                onSuccess: (summary) => Deferred.succeed(summaryDeferred, summary),
                onFailure: (cause) =>
                  Deferred.fail(
                    summaryDeferred,
                    new OteliteDecodeError({ kind: 'summary', raw: line ?? '', cause }),
                  ),
              }),
            )
            // Clean up an otelite-minted out-dir on scope close.
            if (options.out === undefined) {
              yield* fs.remove(endpoints.out, { recursive: true }).pipe(Effect.ignore)
            }
          }).pipe(Effect.uninterruptible),
        )

        const handleInspect = ((
          inspectOptions: CaptureInspectBase & {
            readonly signal: Signal
            readonly summary?: boolean
          },
        ) => {
          const pinned = { ...inspectOptions, src: endpoints.out }
          if (inspectOptions.summary === true) {
            return inspect(pinned as never)
          }
          // Live row read: bounded short-poll retry on a transient 0-row result.
          const readRows = inspect(pinned as never) as unknown as Effect.Effect<
            ReadonlyArray<unknown>,
            OteliteSpawnError | OteliteCliError | OteliteDecodeError
          >
          return readRows.pipe(
            Effect.flatMap((rows) =>
              rows.length === 0 ? Effect.fail('empty' as const) : Effect.succeed(rows),
            ),
            Effect.retry({ schedule: liveRowRetry, while: (e) => e === 'empty' }),
            Effect.catchIf(
              (e): e is 'empty' => e === 'empty',
              () => readRows,
            ),
          )
        }) as CaptureHandle['inspect']

        return {
          endpoints: { http: endpoints.http, grpc: endpoints.grpc },
          outDir: endpoints.out,
          inspect: handleInspect,
          summary: Deferred.await(summaryDeferred),
        } satisfies CaptureHandle
      }).pipe(Effect.withSpan('otelite.capture'))

    /** otelite's own version string (`otelite --version`). */
    const version = Effect.suspend(() =>
      runCli(['--version'], (stdout) => Effect.succeed(stdout.trim())),
    ).pipe(Effect.withSpan('otelite.version'))

    return { run, capture, inspect, version } as const
  }),
}) {}
