import { Effect, FiberMap, Stream } from 'effect'

/**
 * Keeps one fiber per key of the latest emitted map: new keys start `run(key, value)`,
 * vanished keys interrupt theirs. Everything is interrupted when the stream ends or the
 * effect is interrupted. (Fibers are not restarted if they finish on their own.)
 */
export const runKeyed = <A, E, R, R2>(
  desired: Stream.Stream<ReadonlyMap<string, A>, E, R>,
  run: (key: string, value: A) => Effect.Effect<unknown, never, R2>,
): Effect.Effect<void, E, R | R2> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fibers = yield* FiberMap.make<string>()
      const running = new Set<string>()
      yield* desired.pipe(
        Stream.runForEach((next) =>
          Effect.gen(function* () {
            for (const key of [...running])
              if (!next.has(key)) {
                running.delete(key)
                yield* FiberMap.remove(fibers, key)
              }
            for (const [key, value] of next)
              if (!running.has(key)) {
                running.add(key)
                yield* FiberMap.run(fibers, key, run(key, value))
              }
          }),
        ),
      )
    }),
  )
