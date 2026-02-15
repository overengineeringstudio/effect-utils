import * as fs from 'node:fs'
import path from 'node:path'
import util from 'node:util'

import {
  Cause,
  Effect,
  FiberId,
  HashMap,
  Inspectable,
  Layer,
  List,
  Logger,
  type LogLevel,
  LogSpan,
} from 'effect'
import * as EffectArray from 'effect/Array'

/**
 * Creates a Layer that replaces the default logger with a pretty-printed file logger.
 *
 * The logger writes human-readable, optionally colorized output to the specified file.
 * It automatically creates parent directories and manages file handle lifecycle via Effect's
 * scope (closes on scope finalization).
 *
 * Output format per log entry:
 * ```
 * [HH:MM:SS.mmm threadName] LEVEL (fiber-id) span1 (123ms) span2 (45ms): Message
 *   Additional structured data indented
 *   key: value (for annotations)
 * ```
 *
 * @example
 * ```ts
 * import { Effect } from 'effect'
 * import { makeFileLogger } from '@overeng/utils/node'
 *
 * const program = Effect.gen(function* () {
 *   yield* Effect.log('Hello from file logger')
 *   yield* Effect.logDebug('Debug info', { userId: 123 })
 * }).pipe(
 *   Effect.provide(makeFileLogger({ logFilePath: '/tmp/app.log', threadName: 'main' }))
 * )
 * ```
 */
export interface MakeFileLoggerOptions {
  /** Absolute or relative path to the log file. Parent directories are created if needed. */
  readonly logFilePath: string
  /** Label shown in log output to identify the source (e.g., 'main', 'worker-1') */
  readonly threadName?: string
  /** Whether to include ANSI color codes. Defaults to false (plain text). */
  readonly colors?: boolean
}

/** Creates a Layer that replaces the default logger with a pretty-printed file logger */
export const makeFileLogger = ({ logFilePath, threadName, colors }: MakeFileLoggerOptions) =>
  Layer.unwrapScoped(
    Effect.gen(function* () {
      yield* Effect.sync(() => fs.mkdirSync(path.dirname(logFilePath), { recursive: true }))

      const logFile = yield* Effect.acquireRelease(
        Effect.sync(() => fs.openSync(logFilePath, 'a', 0o666)),
        (fd) => Effect.sync(() => fs.closeSync(fd)),
      )

      return Logger.replace(
        Logger.defaultLogger,
        prettyLoggerTty({
          colors: colors ?? false,
          stderr: false,
          formatDate: (date) => `${defaultDateFormat(date)} ${threadName ?? ''}`,
          onLog: (str) => fs.writeSync(logFile, str),
        }),
      )
    }),
  )

const withColor = (text: string, ...colors: readonly string[]) => {
  let out = ''
  for (let i = 0; i < colors.length; i++) {
    out += `\x1b[${colors[i]}m`
  }
  return `${out}${text}\x1b[0m`
}
const withColorNoop = (text: string, ..._colors: readonly string[]) => text

const colors = {
  bold: '1',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  cyan: '36',
  white: '37',
  gray: '90',
  black: '30',
  bgBrightRed: '101',
} as const

const logLevelColors: Record<LogLevel.LogLevel['_tag'], readonly string[]> = {
  None: [],
  All: [],
  Trace: [colors.gray],
  Debug: [colors.blue],
  Info: [colors.green],
  Warning: [colors.yellow],
  Error: [colors.red],
  Fatal: [colors.bgBrightRed, colors.black],
}

/** Formats date as HH:MM:SS.mmm (24-hour local time with milliseconds) */
export const defaultDateFormat = (date: Date): string =>
  `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}:${date
    .getSeconds()
    .toString()
    .padStart(2, '0')}.${date.getMilliseconds().toString().padStart(3, '0')}`

/** Converts a value to a JSON-serializable form for logging */
export const structuredMessage = (input: unknown): unknown => {
  switch (typeof input) {
    case 'bigint':
    case 'function':
    case 'symbol': {
      return String(input)
    }
    default: {
      return Inspectable.toJSON(input)
    }
  }
}

const consoleLogToString = (...inputs: any[]) => {
  if (inputs.length === 0) return ''
  const [first, ...rest] = inputs
  if (typeof first === 'string') {
    return rest.length > 0 ? util.format(first, ...rest.map(structuredMessage)) : first
  }
  return inputs
    .map((value) => {
      if (typeof value === 'string') return value
      return util.inspect(structuredMessage(value), {
        depth: 3,
        colors: false,
        compact: false,
        breakLength: 120,
      })
    })
    .join(' ')
}

/**
 * Creates a pretty-printing logger suitable for TTY or file output.
 *
 * This is a lower-level building block used by `makeFileLogger`. Use this directly
 * when you need custom output handling (e.g., sending to a remote endpoint).
 *
 * @param options.colors - Include ANSI color codes in output
 * @param options.stderr - Unused (legacy parameter)
 * @param options.formatDate - Custom date formatter, receives Date and returns string prefix
 * @param options.onLog - Callback invoked with each formatted log string
 */
export const prettyLoggerTty = (options: {
  readonly colors: boolean
  readonly stderr: boolean
  readonly formatDate: (date: Date) => string
  readonly onLog?: (str: string) => void
}) => {
  const color = options.colors ? withColor : withColorNoop
  return Logger.make<unknown, string>(
    ({ annotations, cause, date, fiberId, logLevel, message: message_, spans }) => {
      let str = ''

      const log = (...inputs: any[]) => {
        str += `${consoleLogToString(...inputs)}\n`
        options.onLog?.(str)
      }

      const logIndented = (...inputs: any[]) => {
        str += `${consoleLogToString(...inputs).replace(/^/gm, '  ')}\n`
        options.onLog?.(str)
      }

      const message = EffectArray.ensure(message_)

      let firstLine =
        color(`[${options.formatDate(date)}]`, colors.white) +
        ` ${color(logLevel.label, ...logLevelColors[logLevel._tag])}` +
        ` (${FiberId.threadName(fiberId)})`

      if (List.isCons(spans) === true) {
        const now = date.getTime()
        const render = LogSpan.render(now)
        for (const span of spans) {
          firstLine += ` ${render(span)}`
        }
      }

      firstLine += ':'
      let messageIndex = 0
      if (message.length > 0) {
        const firstMaybeString = structuredMessage(message[0])
        if (typeof firstMaybeString === 'string') {
          firstLine += ` ${color(firstMaybeString, colors.bold, colors.cyan)}`
          messageIndex++
        }
      }

      log(firstLine)

      if (Cause.isEmpty(cause) === false) {
        logIndented(Cause.pretty(cause, { renderErrorCause: true }))
      }

      if (messageIndex < message.length) {
        for (; messageIndex < message.length; messageIndex++) {
          const msg = message[messageIndex]
          if (typeof msg === 'object' && msg !== null) {
            logIndented(
              util.inspect(structuredMessage(msg), {
                depth: 3,
                colors: false,
                compact: false,
                breakLength: 120,
              }),
            )
          } else {
            logIndented(Inspectable.redact(msg))
          }
        }
      }

      if (HashMap.size(annotations) > 0) {
        for (const [key, value] of annotations) {
          const formattedValue =
            typeof value === 'object' && value !== null
              ? util.inspect(structuredMessage(value), {
                  depth: 3,
                  colors: false,
                  compact: false,
                  breakLength: 120,
                })
              : Inspectable.redact(value)
          logIndented(color(`${key}:`, colors.bold, colors.white), formattedValue)
        }
      }

      return str
    },
  )
}
