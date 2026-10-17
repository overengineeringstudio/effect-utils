import { Cause, Effect, Fiber, type Scope } from 'effect'

/** Fork one scoped program on the ambient runtime; unexpected causes are logged, unmount interruption is not. */
const forkScoped = <A, E>(program: Effect.Effect<A, E, Scope.Scope>): Fiber.Fiber<A, E> =>
  Effect.runFork(
    program.pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause) === true
          ? Effect.void
          : Effect.logError('Meters React effect failed', cause),
      ),
      Effect.scoped,
    ),
  )
/** Run one scoped program and return the cancel that interrupts it; its scope closes with the fiber. */
export const runScoped = <A, E>(program: Effect.Effect<A, E, Scope.Scope>): (() => void) => {
  const fiber = forkScoped(program)
  return () => {
    void Effect.runFork(Fiber.interrupt(fiber))
  }
}
