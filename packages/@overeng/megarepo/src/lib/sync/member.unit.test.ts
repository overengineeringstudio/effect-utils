import { it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { describe, expect } from 'vitest'

import { getRepoSemaphore, makeRepoSemaphoreMap } from './member.ts'

describe('getRepoSemaphore', () => {
  it.effect('returns the same semaphore for the same URL', () =>
    Effect.gen(function* () {
      const semaphoreMap = yield* makeRepoSemaphoreMap()
      const sem1 = yield* getRepoSemaphore({
        semaphoreMapRef: semaphoreMap,
        url: 'https://github.com/owner/repo.git',
      })
      const sem2 = yield* getRepoSemaphore({
        semaphoreMapRef: semaphoreMap,
        url: 'https://github.com/owner/repo.git',
      })
      expect(sem1 === sem2).toBe(true)
    }),
  )

  it.effect('returns different semaphores for different URLs', () =>
    Effect.gen(function* () {
      const semaphoreMap = yield* makeRepoSemaphoreMap()
      const sem1 = yield* getRepoSemaphore({
        semaphoreMapRef: semaphoreMap,
        url: 'https://github.com/owner/repo1.git',
      })
      const sem2 = yield* getRepoSemaphore({
        semaphoreMapRef: semaphoreMap,
        url: 'https://github.com/owner/repo2.git',
      })
      expect(sem1 !== sem2).toBe(true)
    }),
  )

  it.effect('is race-condition safe with concurrent access', () =>
    // This test verifies that multiple concurrent fibers get the same semaphore
    // for the same URL, demonstrating that the Ref-based implementation is atomic.
    Effect.gen(function* () {
      const semaphoreMap = yield* makeRepoSemaphoreMap()
      const url = 'https://github.com/owner/repo.git'

      // Launch multiple fibers concurrently to get/create semaphore for same URL
      const fibers = yield* Effect.all(
        Array.from({ length: 100 }, () =>
          Effect.fork(getRepoSemaphore({ semaphoreMapRef: semaphoreMap, url })),
        ),
        { concurrency: 'unbounded' },
      )

      // Join all fibers and collect results
      const semaphores = yield* Effect.all(
        fibers.map((fiber) => Fiber.join(fiber)),
        { concurrency: 'unbounded' },
      )

      // All semaphores should be the same instance
      const first = semaphores[0]
      expect(semaphores.every((sem) => sem === first)).toBe(true)
    }),
  )
})
