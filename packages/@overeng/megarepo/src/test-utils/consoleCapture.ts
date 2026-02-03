import { Console, Effect, Ref } from 'effect'

/**
 * Capture Console output as an in-memory line buffer.
 */
export const makeConsoleCapture = Effect.gen(function* () {
  const lines = yield* Ref.make<ReadonlyArray<string>>([])

  const appendLines = (...args: ReadonlyArray<unknown>) =>
    Ref.update(lines, (current) => [...current, ...args.map(String)])

  const consoleService: Console.Console = {
    [Console.TypeId]: Console.TypeId,
    log: (...args) => appendLines(...args),
    error: (...args) => appendLines(...args),
    info: (...args) => appendLines(...args),
    warn: (...args) => appendLines(...args),
    debug: (...args) => appendLines(...args),
    trace: (...args) => appendLines(...args),
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
    getLines: Ref.get(lines),
  }
})
