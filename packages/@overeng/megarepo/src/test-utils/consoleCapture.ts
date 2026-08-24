import { Console, Effect, Layer } from 'effect'

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

  return {
    consoleLayer: Layer.succeed(Console.Console, consoleService),
    getStdoutLines: Effect.succeed(stdoutLines.slice()),
    getStderrLines: Effect.succeed(stderrLines.slice()),
  }
})
