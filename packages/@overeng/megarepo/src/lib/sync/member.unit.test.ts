import { describe, expect, test } from 'vitest'
import { Effect, Fiber } from 'effect'

import { getRepoSemaphore, makeRepoSemaphoreMap } from './member.ts'

describe('getRepoSemaphore', () => {
  test('returns the same semaphore for the same URL', async () => {
    const program = Effect.gen(function* () {
      const semaphoreMap = yield* makeRepoSemaphoreMap()
      const sem1 = yield* getRepoSemaphore(semaphoreMap, 'https://github.com/owner/repo.git')
      const sem2 = yield* getRepoSemaphore(semaphoreMap, 'https://github.com/owner/repo.git')
      return sem1 === sem2
    })

    const result = await Effect.runPromise(program)
    expect(result).toBe(true)
  })

  test('returns different semaphores for different URLs', async () => {
    const program = Effect.gen(function* () {
      const semaphoreMap = yield* makeRepoSemaphoreMap()
      const sem1 = yield* getRepoSemaphore(semaphoreMap, 'https://github.com/owner/repo1.git')
      const sem2 = yield* getRepoSemaphore(semaphoreMap, 'https://github.com/owner/repo2.git')
      return sem1 !== sem2
    })

    const result = await Effect.runPromise(program)
    expect(result).toBe(true)
  })

  test('is race-condition safe with concurrent access', async () => {
    // This test verifies that multiple concurrent fibers get the same semaphore
    // for the same URL, demonstrating that the Ref-based implementation is atomic.
    const program = Effect.gen(function* () {
      const semaphoreMap = yield* makeRepoSemaphoreMap()
      const url = 'https://github.com/owner/repo.git'

      // Launch multiple fibers concurrently to get/create semaphore for same URL
      const fibers = yield* Effect.all(
        Array.from({ length: 100 }, () =>
          Effect.fork(getRepoSemaphore(semaphoreMap, url)),
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
      return semaphores.every((sem) => sem === first)
    })

    const result = await Effect.runPromise(program)
    expect(result).toBe(true)
  })
})
