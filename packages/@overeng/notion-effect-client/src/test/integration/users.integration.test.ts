import { Effect, Stream } from 'effect'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { NotionUsers } from '../../users.ts'
import { IntegrationTestLayer, SKIP_INTEGRATION } from './setup.ts'

const USER_REQUEST_TIMEOUT = 30_000
const USER_STREAM_TIMEOUT = 60_000

Vitest.describe.skipIf(SKIP_INTEGRATION)('NotionUsers (integration)', () => {
  Vitest.describe('me', () => {
    Vitest.it.effect(
      'fetches the bot user',
      () =>
        Effect.gen(function* () {
          const user = yield* NotionUsers.me()

          expect(user.object).toBe('user')
          expect(user.id).toBeDefined()
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: USER_REQUEST_TIMEOUT },
    )
  })

  Vitest.describe('list', () => {
    Vitest.it.effect(
      'lists workspace users',
      () =>
        Effect.gen(function* () {
          const result = yield* NotionUsers.list()

          expect(result.results.length).toBeGreaterThanOrEqual(1)
          expect(result.results[0]?.object).toBe('user')
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: USER_REQUEST_TIMEOUT },
    )

    Vitest.it.effect(
      'lists with page size limit',
      () =>
        Effect.gen(function* () {
          const result = yield* NotionUsers.list({ pageSize: 1 })

          expect(result.results.length).toBe(1)
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: USER_REQUEST_TIMEOUT },
    )
  })

  Vitest.describe('listStream', () => {
    Vitest.it.effect(
      'streams all users',
      () =>
        Effect.gen(function* () {
          const stream = NotionUsers.listStream({ pageSize: 1 })

          const items = yield* Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]))

          expect(items.length).toBeGreaterThanOrEqual(1)
          for (const item of items) {
            expect(item.object).toBe('user')
          }
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: USER_STREAM_TIMEOUT },
    )
  })

  Vitest.describe('retrieve', () => {
    Vitest.it.effect(
      'fetches a specific user by ID',
      () =>
        Effect.gen(function* () {
          // First get the bot user ID
          const bot = yield* NotionUsers.me()

          // Then retrieve that user
          const user = yield* NotionUsers.retrieve({ userId: bot.id })

          expect(user.object).toBe('user')
          expect(user.id).toBe(bot.id)
        }).pipe(Effect.provide(IntegrationTestLayer)),
      { timeout: USER_REQUEST_TIMEOUT },
    )
  })
})
