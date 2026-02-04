import { Console, Effect, Ref } from 'effect'

/**
 * Capture Console output as an in-memory line buffer.
 */
export const makeConsoleCapture = Effect.gen(function* () {
  const stdoutLines = yield* Ref.make<ReadonlyArray<string>>([])
  const stderrLines = yield* Ref.make<ReadonlyArray<string>>([])

  const appendStdout = (...args: ReadonlyArray<unknown>) =>
    Ref.update(stdoutLines, (current) => [...current, ...args.map(String)])
  const appendStderr = (...args: ReadonlyArray<unknown>) =>
    Ref.update(stderrLines, (current) => [...current, ...args.map(String)])

  const consoleService: Console.Console = {
    [Console.TypeId]: Console.TypeId,
    log: (...args) => appendStdout(...args),
    error: (...args) => appendStderr(...args),
    info: (...args) => appendStdout(...args),
    warn: (...args) => appendStderr(...args),
    debug: (...args) => appendStdout(...args),
    trace: (...args) => appendStdout(...args),
    assert: () => Effect.void,
    clear: Effect.void,
    count: () => Effect.void,
    countReset: () => Effect.void,
    dir: () => Effect.void,
    dirxml: () => Effect.void,
    group: () => Effect.void,
    groupEnd: Effect.void,
    table: () => Effect.void,
    time: () => Effect.void,
    timeEnd: () => Effect.void,
    timeLog: () => Effect.void,
    unsafe: globalThis.console,
  }

  return {
    consoleLayer: Console.setConsole(consoleService),
    getStdoutLines: Ref.get(stdoutLines),
    getStderrLines: Ref.get(stderrLines),
  }
})
