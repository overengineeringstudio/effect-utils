import { Clock, Effect, Fiber, Queue } from 'effect'
import { adjust as testClockAdjust } from 'effect/testing/TestClock'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { NotionThrottle, NotionThrottleLive } from './throttle.ts'

Vitest.describe('NotionThrottle', () => {
  Vitest.it.effect('spaces requests by ceil(1000 / requestsPerSecond) ms', () =>
    Effect.gen(function* () {
      const completedAt = yield* Queue.unbounded<number>()
      const throttle = yield* NotionThrottle

      // burst defaults to 1, so the first request is immediate and each
      // subsequent request is released one interval (1000 ms for 1 rps) later.
      const fiber = yield* Effect.forEach(
        [0, 1, 2],
        () =>
          throttle.apply(
            Effect.gen(function* () {
              const millis = yield* Clock.currentTimeMillis
              yield* Queue.offer(completedAt, millis)
            }),
          ),
        { discard: true },
      ).pipe(Effect.forkChild)

      yield* testClockAdjust('5 seconds')
      yield* Fiber.join(fiber)

      const stamps = [...(yield* Queue.takeAll(completedAt))]
      expect(stamps).toEqual([0, 1000, 2000])
    }).pipe(Effect.provide(NotionThrottleLive({ requestsPerSecond: 1 }))),
  )

  Vitest.it.effect('allows a burst before pacing resumes', () =>
    Effect.gen(function* () {
      const completedAt = yield* Queue.unbounded<number>()
      const throttle = yield* NotionThrottle

      const fiber = yield* Effect.forEach(
        [0, 1, 2],
        () =>
          throttle.apply(
            Effect.gen(function* () {
              const millis = yield* Clock.currentTimeMillis
              yield* Queue.offer(completedAt, millis)
            }),
          ),
        { discard: true },
      ).pipe(Effect.forkChild)

      yield* testClockAdjust('5 seconds')
      yield* Fiber.join(fiber)

      const stamps = [...(yield* Queue.takeAll(completedAt))]
      // burst of 2 ⇒ the bucket starts with 2 tokens (first two requests
      // immediate), and the token-bucket refills 1 token per interval/limit
      // (1000/2 = 500 ms), so the third request is released at 500 ms.
      expect(stamps).toEqual([0, 0, 500])
    }).pipe(Effect.provide(NotionThrottleLive({ requestsPerSecond: 1, burst: 2 }))),
  )
})
