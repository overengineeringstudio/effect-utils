import { Effect, FiberMap, Stream } from 'effect'

/**
 * Keeps one fiber per key of the latest emitted map: new keys start `run(key, value)`,
 * vanished keys interrupt theirs. Everything is interrupted when the stream ends or the
 * effect is interrupted. (Fibers are not restarted if they finish on their own.)
 */
export const runKeyed = <TValue, TError, TContext, TRunContext>({
  desired,
  run,
}: {
  desired: Stream.Stream<ReadonlyMap<string, TValue>, TError, TContext>
  run: (key: string, value: TValue) => Effect.Effect<unknown, never, TRunContext>
}): Effect.Effect<void, TError, TContext | TRunContext> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fibers = yield* FiberMap.make<string>()
      const running = new Set<string>()
      yield* desired.pipe(
        Stream.runForEach((next) =>
          Effect.gen(function* () {
            for (const key of running)
              if (next.has(key) === false) {
                running.delete(key)
                yield* FiberMap.remove(fibers, key)
              }
            for (const [key, value] of next)
              if (running.has(key) === false) {
                running.add(key)
                yield* FiberMap.run(fibers, key, run(key, value))
              }
          }),
        ),
      )
    }),
  )
