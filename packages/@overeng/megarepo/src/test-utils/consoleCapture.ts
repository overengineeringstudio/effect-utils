import { Writable } from 'node:stream'

import { Console, Effect, Layer } from 'effect'

import { ViewOutputStreamTag } from '@overeng/tui-react'

/**
 * Capture Console output as an in-memory line buffer.
 */
export const makeConsoleCapture = Effect.sync(() => {
  const stdoutLines: Array<string> = []
  const stderrLines: Array<string> = []

  const appendStdout = (...args: ReadonlyArray<unknown>) => {
    stdoutLines.push(...args.map(String))
  }
  const appendStderr = (...args: ReadonlyArray<unknown>) => {
    stderrLines.push(...args.map(String))
  }

  const consoleService: Console.Console = Object.assign(Object.create(globalThis.console), {
    log: appendStdout,
    error: appendStderr,
    info: appendStdout,
    warn: appendStderr,
    debug: appendStdout,
    trace: appendStdout,
    assert: () => {},
    clear: () => {},
    count: () => {},
    countReset: () => {},
    dir: () => {},
    dirxml: () => {},
    group: () => {},
    groupCollapsed: () => {},
    groupEnd: () => {},
    table: () => {},
    time: () => {},
    timeEnd: () => {},
    timeLog: () => {},
  })
  // TUI JSON/final output bypasses Console and writes directly to
  // ViewOutputStreamTag (defaulting to process.stdout), so bind it to a
  // capturing stream too.
  const viewStream = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split('\n')) {
        if (line !== '') stdoutLines.push(line)
      }
      callback()
    },
  })

  return {
    consoleLayer: Layer.mergeAll(
      Layer.succeed(Console.Console, consoleService),
      Layer.succeed(ViewOutputStreamTag, viewStream),
    ),
    getStdoutLines: Effect.sync(() => stdoutLines.slice()),
    getStderrLines: Effect.sync(() => stderrLines.slice()),
  }
})
