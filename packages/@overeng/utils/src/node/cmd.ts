import fs from 'node:fs'

import * as Command from '@effect/platform/Command'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import type { Process } from '@effect/platform/CommandExecutor'
import type { PlatformError } from '@effect/platform/Error'
import type { Scope } from 'effect'
import {
  Cause,
  Chunk,
  type Duration,
  Effect,
  Fiber,
  FiberId,
  FiberRefs,
  HashMap,
  identity,
  List,
  LogLevel,
  Option,
  Schema,
  Stream,
} from 'effect'

import { isNotUndefined } from '../isomorphic/mod.ts'
import { applyLoggingToCommand } from './cmd-log.ts'
import * as FileLogger from './FileLogger.ts'
import { CurrentWorkingDirectory } from './workspace.ts'

// Branded zero value so we can compare exit codes without touching internals.
const SUCCESS_EXIT_CODE: CommandExecutor.ExitCode = 0 as CommandExecutor.ExitCode

/**
 * Run a command to completion and return its exit code.
 *
 * Accepts a command string (split on spaces) or a string array (preferred).
 * When `shell` is enabled (or implied by logging), the command is executed
 * through a subshell. Logging options mirror output to a canonical log file
 * and keep a rolling archive.
 *
 * Errors:
 * - Fails with `CmdError` on non-zero exit codes.
 * - Propagates `PlatformError` for execution failures.
 */
export const cmd: (
  commandInput: string | (string | undefined)[],
  options?:
    | {
        /** Stream stderr to the terminal or keep it in memory. */
        stderr?: 'inherit' | 'pipe'
        /** Stream stdout to the terminal or keep it in memory. */
        stdout?: 'inherit' | 'pipe'
        /** Run in a subshell (required for compound commands). */
        shell?: boolean
        /** Environment overrides for the command. */
        env?: Record<string, string | undefined>
        /**
         * When provided, streams command output to terminal AND to a canonical log file (`${logDir}/dev.log`) in this directory.
         * Also archives the previous run to `${logDir}/archive/dev-<ISO>.log` and keeps only the latest 50 archives.
         */
        logDir?: string
        /** Optional basename for the canonical log file; defaults to 'dev.log' */
        logFileName?: string
        /** Optional number of archived logs to retain; defaults to 50 */
        logRetention?: number
        /** Grace period before escalating from SIGTERM to SIGKILL on cleanup. Defaults to 5 seconds. */
        killTimeout?: Duration.DurationInput
      }
    | undefined,
) => Effect.Effect<
  CommandExecutor.ExitCode,
  PlatformError | CmdError,
  CommandExecutor.CommandExecutor | CurrentWorkingDirectory
> = Effect.fn('cmd')(function* (commandInput, options) {
  const cwd = yield* CurrentWorkingDirectory

  const asArray = Array.isArray(commandInput)
  const parts = asArray
    ? (commandInput as (string | undefined)[]).filter(isNotUndefined)
    : undefined
  const [command, ...args] = asArray ? (parts as string[]) : (commandInput as string).split(' ')

  if (command === undefined) {
    return yield* Effect.die('Command is missing')
  }

  const debugEnvStr = Object.entries(options?.env ?? {})
    .map(([key, value]) => `${key}='${value}' `)
    .join('')

  const loggingOpts = {
    ...(options?.logDir !== undefined ? { logDir: options.logDir } : {}),
    ...(options?.logFileName !== undefined ? { logFileName: options.logFileName } : {}),
    ...(options?.logRetention !== undefined ? { logRetention: options.logRetention } : {}),
  } as const
  const {
    input: finalInput,
    subshell: needsShell,
    logPath,
  } = yield* applyLoggingToCommand(commandInput, loggingOpts)

  const stdoutMode = options?.stdout ?? 'inherit'
  const stderrMode = options?.stderr ?? 'inherit'
  const useShell = options?.shell === true || needsShell === true

  const commandDebugStr =
    debugEnvStr +
    (Array.isArray(finalInput) === true ? (finalInput as string[]).join(' ') : (finalInput as string))
  const subshellStr = useShell ? ' (in subshell)' : ''

  yield* Effect.logDebug(`Running '${commandDebugStr}' in '${cwd}'${subshellStr}`)
  yield* Effect.annotateCurrentSpan({
    'span.label': commandDebugStr,
    cwd,
    command,
    args,
    logDir: options?.logDir,
  })

  const baseArgs = {
    commandInput: finalInput,
    cwd,
    env: options?.env ?? {},
    stdoutMode,
    stderrMode,
    useShell,
    killTimeout: options?.killTimeout,
  } as const

  const exitCode = yield* isNotUndefined(logPath) === true
    ? Effect.gen(function* () {
        yield* Effect.log(`Logging output to ${logPath}`)
        return yield* runWithLogging({
          ...baseArgs,
          logPath,
          threadName: commandDebugStr,
        })
      })
    : runWithoutLogging(baseArgs)

  if (exitCode !== SUCCESS_EXIT_CODE) {
    return yield* new CmdError({
      command,
      args,
      cwd,
      env: options?.env ?? {},
      stderr: stderrMode,
    })
  }

  return exitCode
})

/**
 * Start a command and return a running process handle.
 *
 * Intended for long-lived tasks (dev servers, watchers) where the caller is
 * responsible for shutdown. The process inherits stdio by default to keep
 * output visible in the terminal.
 *
 * Notes:
 * - Returns a `Process` handle that supports `kill`, `exitCode`, `isRunning`, etc.
 * - Does not wait for completion; call `exitCode` on the returned process if needed.
 */
export const cmdStart: (
  commandInput: string | (string | undefined)[],
  options?:
    | {
        /** Stream stderr to the terminal or keep it in memory. */
        stderr?: 'inherit' | 'pipe'
        /** Stream stdout to the terminal or keep it in memory. */
        stdout?: 'inherit' | 'pipe'
        /** Run in a subshell (required for compound commands). */
        shell?: boolean
        /** Environment overrides for the command. */
        env?: Record<string, string | undefined>
      }
    | undefined,
) => Effect.Effect<
  CommandExecutor.Process,
  PlatformError,
  CommandExecutor.CommandExecutor | CurrentWorkingDirectory | Scope.Scope
> = Effect.fn('cmdStart')(function* (commandInput, options) {
  const cwd = yield* CurrentWorkingDirectory

  const debugEnvStr = Object.entries(options?.env ?? {})
    .map(([key, value]) => `${key}='${value}' `)
    .join('')
  const useShell = options?.shell === true
  let command: string | undefined
  let args: string[] = []
  let normalizedInput: string | string[]
  let commandDebugStr: string

  if (Array.isArray(commandInput) === true) {
    const parts = commandInput.filter(isNotUndefined)
    ;[command, ...args] = parts
    normalizedInput = parts
    commandDebugStr = debugEnvStr + parts.join(' ')
  } else {
    ;[command, ...args] = commandInput.split(' ')
    normalizedInput = commandInput
    commandDebugStr = debugEnvStr + commandInput
  }

  if (command === undefined) {
    return yield* Effect.die('Command is missing')
  }
  const subshellStr = useShell ? ' (in subshell)' : ''

  yield* Effect.logDebug(`Starting '${commandDebugStr}' in '${cwd}'${subshellStr}`)
  yield* Effect.annotateCurrentSpan({
    'span.label': commandDebugStr,
    cwd,
    command,
    args,
  })

  return yield* buildCommand({ input: normalizedInput, useShell }).pipe(
    Command.stdin('inherit'),
    Command.stdout(options?.stdout ?? 'inherit'),
    Command.stderr(options?.stderr ?? 'inherit'),
    Command.workingDirectory(cwd),
    useShell === true ? Command.runInShell(true) : identity,
    Command.env(options?.env ?? {}),
    Command.start,
  )
})

/**
 * Run a command and return stdout as a string.
 *
 * Errors:
 * - Propagates `PlatformError` for execution failures.
 */
export const cmdText: (
  commandInput: string | (string | undefined)[],
  options?: {
    /** Stream stderr to the terminal or pipe to stdout. */
    stderr?: 'inherit' | 'pipe'
    /** Run in a subshell (required for compound commands). */
    runInShell?: boolean
    /** Environment overrides for the command. */
    env?: Record<string, string | undefined>
  },
) => Effect.Effect<
  string,
  PlatformError,
  CommandExecutor.CommandExecutor | CurrentWorkingDirectory
> = Effect.fn('cmdText')(function* (commandInput, options) {
  const cwd = yield* CurrentWorkingDirectory
  const [command, ...args] = Array.isArray(commandInput) === true
    ? commandInput.filter(isNotUndefined)
    : commandInput.split(' ')

  if (command === undefined) {
    return yield* Effect.die('Command is missing')
  }
  const debugEnvStr = Object.entries(options?.env ?? {})
    .map(([key, value]) => `${key}='${value}' `)
    .join('')

  const commandDebugStr = debugEnvStr + [command, ...args].join(' ')
  const subshellStr = options?.runInShell ? ' (in subshell)' : ''

  yield* Effect.logDebug(`Running '${commandDebugStr}' in '${cwd}'${subshellStr}`)
  yield* Effect.annotateCurrentSpan({
    'span.label': commandDebugStr,
    command,
    cwd,
  })

  return yield* Command.make(command, ...args).pipe(
    // inherit = Stream stderr to process.stderr, pipe = Stream stderr to process.stdout
    Command.stderr(options?.stderr ?? 'inherit'),
    Command.workingDirectory(cwd),
    options?.runInShell ? Command.runInShell(true) : identity,
    Command.env(options?.env ?? {}),
    Command.string,
  )
})

/** Result of collecting stdout/stderr from a command. */
export interface CmdCollectResult {
  readonly stdout: readonly string[]
  readonly stderr: readonly string[]
  readonly exitCode: number
}

/**
 * Run a command and collect stdout/stderr as line arrays.
 *
 * Each stream is decoded as UTF-8 and split into lines. An optional
 * `onOutput` callback is invoked for every line (useful for streaming
 * progress to a UI). The callback may return an Effect that requires
 * additional context `R` – this requirement propagates to the return type.
 *
 * Errors:
 * - Propagates `PlatformError` for execution failures.
 */
export const cmdCollect = <R = never>(opts: {
  readonly commandInput: string | (string | undefined)[]
  readonly onOutput?: (stream: 'stdout' | 'stderr', line: string) => Effect.Effect<void, never, R>
  readonly env?: Record<string, string | undefined>
  readonly shell?: boolean
  readonly workingDirectory?: string
}): Effect.Effect<
  CmdCollectResult,
  PlatformError,
  CommandExecutor.CommandExecutor | CurrentWorkingDirectory | R
> =>
  Effect.gen(function* () {
    const cwd = opts.workingDirectory ?? (yield* CurrentWorkingDirectory)

    const useShell = !!opts.shell

    // Preserve raw string input for buildCommand's shell-mode path (avoids
    // splitting on spaces, which would break leading-whitespace commands).
    const normalizedInput: string | string[] = Array.isArray(opts.commandInput) === true
      ? (opts.commandInput as (string | undefined)[]).filter(isNotUndefined)
      : useShell
        ? (opts.commandInput as string)
        : (opts.commandInput as string).split(' ')

    const debugStr = Array.isArray(normalizedInput) === true ? normalizedInput.join(' ') : normalizedInput

    yield* Effect.logDebug(`Collecting '${debugStr}' in '${cwd}'`)

    const cmd = buildCommand({ input: normalizedInput, useShell }).pipe(
      Command.stdout('pipe'),
      Command.stderr('pipe'),
      Command.workingDirectory(cwd),
      useShell ? Command.runInShell(true) : identity,
      Command.env(opts.env ?? {}),
    )

    const { onOutput } = opts

    return yield* Effect.scoped(
      Command.start(cmd).pipe(
        Effect.flatMap((proc) =>
          Effect.all(
            {
              stdout: proc.stdout.pipe(
                Stream.decodeText('utf8'),
                Stream.splitLines,
                Stream.tap((line) => (onOutput ? onOutput('stdout', line) : Effect.void)),
                Stream.runCollect,
                Effect.map(Chunk.toReadonlyArray),
              ),
              stderr: proc.stderr.pipe(
                Stream.decodeText('utf8'),
                Stream.splitLines,
                Stream.tap((line) => (onOutput ? onOutput('stderr', line) : Effect.void)),
                Stream.runCollect,
                Effect.map(Chunk.toReadonlyArray),
              ),
              exitCode: proc.exitCode,
            },
            { concurrency: 'unbounded' },
          ),
        ),
      ),
    )
  }).pipe(Effect.withSpan('cmdCollect'))

/** Internal error for process signal operations */
class ProcessSignalError extends Schema.TaggedError<ProcessSignalError>()('ProcessSignalError', {
  cause: Schema.Defect,
  code: Schema.optionalWith(Schema.String, { as: 'Option' }),
}) {}

/** Error thrown when a shell command exits with non-zero status */
export class CmdError extends Schema.TaggedError<CmdError>()('CmdError', {
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.String,
  env: Schema.Record({
    key: Schema.String,
    value: Schema.String.pipe(Schema.UndefinedOr),
  }),
  stderr: Schema.Literal('inherit', 'pipe'),
}) {}

type TRunBaseArgs = {
  readonly commandInput: string | string[]
  readonly cwd: string
  readonly env: Record<string, string | undefined>
  readonly stdoutMode: 'inherit' | 'pipe'
  readonly stderrMode: 'inherit' | 'pipe'
  readonly useShell: boolean
  readonly killTimeout: Duration.DurationInput | undefined
}

const runWithoutLogging = ({
  commandInput,
  cwd,
  env,
  stdoutMode,
  stderrMode,
  useShell,
}: TRunBaseArgs) =>
  buildCommand({ input: commandInput, useShell }).pipe(
    Command.stdin('inherit'),
    Command.stdout(stdoutMode),
    Command.stderr(stderrMode),
    Command.workingDirectory(cwd),
    useShell ? Command.runInShell(true) : identity,
    Command.env(env),
    Command.exitCode,
  )

type TRunWithLoggingArgs = TRunBaseArgs & {
  readonly logPath: string
  readonly threadName: string
}

/**
 * When logging is enabled we have to replace the `2>&1 | tee` pipeline the
 * shell used to give us. We now pipe both streams through Effect so we can
 * mirror to the terminal (only when requested) and append formatted entries
 * into the canonical log ourselves.
 */
const runWithLogging = ({
  commandInput,
  cwd,
  env,
  stdoutMode,
  stderrMode,
  useShell,
  killTimeout,
  logPath,
  threadName,
}: TRunWithLoggingArgs) =>
  Effect.scoped(
    Effect.gen(function* () {
      const envWithColor = env.FORCE_COLOR === undefined ? { ...env, FORCE_COLOR: '1' } : env

      const logFile = yield* Effect.acquireRelease(
        Effect.sync(() => fs.openSync(logPath, 'a', 0o666)),
        (fd) => Effect.sync(() => fs.closeSync(fd)),
      )

      const prettyLogger = FileLogger.prettyLoggerTty({
        colors: true,
        stderr: false,
        formatDate: (date) => `${FileLogger.defaultDateFormat(date)} ${threadName}`,
      })

      const appendLog = ({ channel, content }: { channel: 'stdout' | 'stderr'; content: string }) =>
        Effect.sync(() => {
          const formatted = prettyLogger.log({
            fiberId: FiberId.none,
            logLevel: channel === 'stdout' ? LogLevel.Info : LogLevel.Warning,
            message: [`[${channel}]${content.length > 0 ? ` ${content}` : ''}`],
            cause: Cause.empty,
            context: FiberRefs.empty(),
            spans: List.empty(),
            annotations: HashMap.empty(),
            date: new Date(),
          })
          fs.writeSync(logFile, formatted)
        })

      const command = buildCommand({ input: commandInput, useShell }).pipe(
        Command.stdin('inherit'),
        Command.stdout('pipe'),
        Command.stderr('pipe'),
        Command.workingDirectory(cwd),
        useShell ? Command.runInShell(true) : identity,
        Command.env(envWithColor),
      )

      // Acquire/start the command and make sure we kill the process group on interruption.
      const runningProcess = yield* Effect.acquireRelease(command.pipe(Command.start), (proc) =>
        proc.isRunning.pipe(
          Effect.flatMap((running) =>
            running
              ? killProcessGroup({
                  proc,
                  ...(killTimeout !== undefined ? { timeout: killTimeout } : {}),
                })
              : Effect.void,
          ),
          Effect.ignore,
        ),
      )

      const stdoutHandler = makeStreamHandler({
        channel: 'stdout',
        ...(stdoutMode === 'inherit' ? { mirrorTarget: process.stdout } : {}),
        appendLog,
      })
      const stderrHandler = makeStreamHandler({
        channel: 'stderr',
        ...(stderrMode === 'inherit' ? { mirrorTarget: process.stderr } : {}),
        appendLog,
      })

      const stdoutFiber = yield* runningProcess.stdout.pipe(
        Stream.decodeText('utf8'),
        Stream.runForEach((chunk) => stdoutHandler.onChunk(chunk)),
        Effect.forkScoped,
      )

      const stderrFiber = yield* runningProcess.stderr.pipe(
        Stream.decodeText('utf8'),
        Stream.runForEach((chunk) => stderrHandler.onChunk(chunk)),
        Effect.forkScoped,
      )

      // Dump any buffered data and finish both stream fibers before we return.
      const flushOutputs = Effect.gen(function* () {
        const stillRunning = yield* runningProcess.isRunning.pipe(
          Effect.catchAll(() => Effect.succeed(false)),
        )
        if (stillRunning === true) {
          yield* killProcessGroup({
            proc: runningProcess,
            ...(killTimeout !== undefined ? { timeout: killTimeout } : {}),
          })
        }
        yield* Fiber.join(stdoutFiber).pipe(Effect.ignore)
        yield* Fiber.join(stderrFiber).pipe(Effect.ignore)
        yield* stdoutHandler.flush()
        yield* stderrHandler.flush()
      })

      const exitCode = yield* runningProcess.exitCode.pipe(Effect.ensuring(flushOutputs))

      return exitCode
    }),
  ).pipe(Effect.withSpan('cmd.runWithLogging'))

/** Default grace period before escalating from SIGTERM to SIGKILL */
const DEFAULT_KILL_TIMEOUT: Duration.DurationInput = '5 seconds'

/**
 * Send a signal to a process group (or individual process as fallback).
 * On Unix, uses negative PID to signal the entire group.
 */
const sendSignalToProcessGroup = (opts: {
  proc: Process
  signal: NodeJS.Signals
}): Effect.Effect<void> => {
  const { proc, signal } = opts
  const isUnix = process.platform !== 'win32'

  if (isUnix === true) {
    // Negative PID sends signal to entire process group
    return Effect.try({
      try: () => process.kill(-proc.pid, signal),
      catch: (e) => {
        const errno = e as NodeJS.ErrnoException
        return new ProcessSignalError({
          cause: e,
          code: Option.fromNullable(errno.code),
        })
      },
    }).pipe(
      Effect.catchAll((e) => {
        // ESRCH = no such process (already dead) - that's fine
        if (Option.getOrUndefined(e.code) === 'ESRCH') return Effect.void
        // Other errors: fall back to individual kill (ignore errors)
        return proc.kill(signal).pipe(Effect.ignore)
      }),
    )
  }

  // Windows: just use individual kill (taskkill /T would need shell)
  return proc.kill(signal).pipe(Effect.ignore)
}

/**
 * Kill a process group with SIGTERM → wait → SIGKILL escalation.
 * Sends SIGTERM first, waits for graceful exit, then SIGKILL if needed.
 */
const killProcessGroup = Effect.fn('cmd/killProcessGroup')(function* (opts: {
  proc: Process
  timeout?: Duration.DurationInput
}) {
  const { proc } = opts
  const timeout = opts.timeout ?? DEFAULT_KILL_TIMEOUT

  // Send SIGTERM first
  yield* sendSignalToProcessGroup({ proc, signal: 'SIGTERM' })

  // Wait for process to exit gracefully (with timeout)
  const exited = yield* proc.exitCode.pipe(Effect.timeout(timeout), Effect.option)

  // If still running after timeout, escalate to SIGKILL
  if (Option.isNone(exited) === true) {
    yield* Effect.logDebug(`Process ${proc.pid} didn't exit gracefully, sending SIGKILL`)
    yield* sendSignalToProcessGroup({ proc, signal: 'SIGKILL' })
  }
}, Effect.ignore)

const buildCommand = (opts: { input: string | string[]; useShell: boolean }) => {
  const { input, useShell } = opts
  if (Array.isArray(input) === true) {
    const [command, ...args] = input
    if (!command) throw new Error('Command cannot be empty')
    return Command.make(command, ...args)
  }

  if (useShell === true) {
    return Command.make(input)
  }

  const [command, ...args] = input.split(' ')
  if (!command) throw new Error('Command cannot be empty')
  return Command.make(command, ...args)
}

type TLineTerminator = 'newline' | 'carriage-return' | 'none'

type TStreamHandler = {
  readonly onChunk: (chunk: string) => Effect.Effect<void, never>
  readonly flush: () => Effect.Effect<void, never>
}

const makeStreamHandler = ({
  channel,
  mirrorTarget,
  appendLog,
}: {
  readonly channel: 'stdout' | 'stderr'
  readonly mirrorTarget?: NodeJS.WriteStream
  readonly appendLog: (args: {
    channel: 'stdout' | 'stderr'
    content: string
  }) => Effect.Effect<void, never>
}): TStreamHandler => {
  let buffer = ''

  /**
   * Effect's FileLogger expects line-oriented messages, but the subprocess
   * gives us arbitrary UTF-8 chunks. We keep a tiny line splitter here so the
   * log and console stay readable (and consistent with the previous `tee`
   * behaviour).
   */
  const emit = (opts: { content: string; terminator: TLineTerminator }) =>
    emitSegment({
      channel,
      content: opts.content,
      terminator: opts.terminator,
      ...(mirrorTarget ? { mirrorTarget } : {}),
      appendLog,
    })

  const consumeBuffer: Effect.Effect<void, never> = Effect.suspend(() => {
    if (buffer.length === 0) return Effect.void

    const lastChar = buffer[buffer.length - 1]
    if (lastChar === '\r') {
      const line = buffer.slice(0, -1)
      buffer = ''
      return emit({ content: line, terminator: 'carriage-return' })
    }

    const line = buffer
    buffer = ''
    return line.length === 0 ? Effect.void : emit({ content: line, terminator: 'none' })
  })

  return {
    onChunk: Effect.fnUntraced(function* (chunk: string) {
      buffer += chunk
      while (buffer.length > 0) {
        const newlineIndex = buffer.indexOf('\n')
        const carriageIndex = buffer.indexOf('\r')

        if (newlineIndex === -1 && carriageIndex === -1) {
          break
        }

        let index: number
        let terminator: TLineTerminator
        let skip = 1

        if (carriageIndex !== -1 && (newlineIndex === -1 || carriageIndex < newlineIndex)) {
          index = carriageIndex
          if (carriageIndex + 1 < buffer.length && buffer[carriageIndex + 1] === '\n') {
            skip = 2
            terminator = 'newline'
          } else {
            terminator = 'carriage-return'
          }
        } else if (newlineIndex !== -1) {
          index = newlineIndex
          terminator = 'newline'
        } else {
          throw new Error('Expected newline or carriage return')
        }

        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + skip)
        yield* emit({ content: line, terminator })
      }
    }),
    flush: () => consumeBuffer,
  }
}

const emitSegment = Effect.fn('cmd.emitSegment')(function* ({
  channel,
  content,
  terminator,
  mirrorTarget,
  appendLog,
}: {
  readonly channel: 'stdout' | 'stderr'
  readonly content: string
  readonly terminator: TLineTerminator
  readonly mirrorTarget?: NodeJS.WriteStream
  readonly appendLog: (args: {
    channel: 'stdout' | 'stderr'
    content: string
  }) => Effect.Effect<void, never>
}) {
  if (mirrorTarget !== undefined) {
    yield* Effect.sync(() => mirrorSegment({ target: mirrorTarget, content, terminator }))
  }

  const contentForLog = terminator === 'carriage-return' ? `${content}\r` : content

  yield* appendLog({ channel, content: contentForLog })
})

const mirrorSegment = (opts: {
  target: NodeJS.WriteStream
  content: string
  terminator: TLineTerminator
}) => {
  const { target, content, terminator } = opts
  switch (terminator) {
    case 'newline': {
      target.write(`${content}\n`)
      break
    }
    case 'carriage-return': {
      target.write(`${content}\r`)
      break
    }
    case 'none': {
      target.write(content)
      break
    }
  }
}
