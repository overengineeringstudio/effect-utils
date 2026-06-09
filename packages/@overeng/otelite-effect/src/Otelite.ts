import { Command, CommandExecutor, FileSystem } from '@effect/platform'
import { Effect, Schema, Stream } from 'effect'

import {
  cliReasonForExitCode,
  OteliteChildFailed,
  OteliteCliError,
  OteliteDecodeError,
  OteliteSpawnError,
} from './errors.ts'
import {
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
export class Otelite extends Effect.Service<Otelite>()('@overeng/otelite-effect/Otelite', {
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

    /** otelite's own version string (`otelite --version`). */
    const version = Effect.suspend(() =>
      runCli(['--version'], (stdout) => Effect.succeed(stdout.trim())),
    ).pipe(Effect.withSpan('otelite.version'))

    return { run, inspect, version } as const
  }),
}) {}
