import { expect, it } from '@effect/vitest'
import { Clock, Effect, Fiber, Result } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import { TestClock } from 'effect/testing'

import { netlifyLookupRetryPolicy, resolveNetlifySite } from './deploy-netlify.ts'

const lookup = (headers: Record<string, string>, recover = false) => {
  let requests = 0
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests += 1
      return HttpClientResponse.fromWeb(
        request,
        new Response('{}', { status: recover === true && requests > 1 ? 200 : 429, headers }),
      )
    }),
  )
  return {
    requests: () => requests,
    effect: resolveNetlifySite({
      target: 'storybook',
      siteId: 'site',
      authToken: 'test-token',
      apiBaseUrl: 'https://api.netlify.com',
    }).pipe(
      Effect.retry(netlifyLookupRetryPolicy),
      Effect.provideService(HttpClient.HttpClient, client),
    ),
  }
}

it.effect.each(['seconds', 'date', 'reset', 'invalid', 'absent'] as const)(
  'waits for %s headers before recovering',
  (header) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const headers: Record<string, string> =
        header === 'seconds'
          ? { 'retry-after': '2' }
          : header === 'date'
            ? { 'retry-after': new Date(now + 2000).toUTCString() }
            : header === 'reset'
              ? { 'retry-after': 'invalid', 'x-ratelimit-reset': String(now / 1000 + 2) }
              : header === 'invalid'
                ? { 'retry-after': 'invalid', 'x-ratelimit-reset': 'invalid' }
                : {}
      const test = lookup(headers, true)
      const fiber = yield* test.effect.pipe(Effect.forkChild)
      const delay = header === 'invalid' || header === 'absent' ? 1000 : 2000
      yield* TestClock.adjust(delay - 1)
      expect(test.requests()).toBe(1)
      yield* TestClock.adjust(1)
      yield* Fiber.join(fiber)
      expect(test.requests()).toBe(2)
    }),
)

it.effect.each(['1e309', '1e308', 'Infinity', 'NaN', '-1', '61', 'Fri, 01 Jan 2100 00:00:00 GMT'])(
  'rejects unsafe Retry-After=%s without retry or fallback',
  (value) =>
    Effect.gen(function* () {
      const test = lookup({ 'retry-after': value, 'x-ratelimit-reset': '0' })
      const result = yield* test.effect.pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result) === true) {
        expect(result.failure).toMatchObject({
          _tag: 'ProviderProjectLookupFailed',
          transient: false,
        })
        expect(result.failure.message).toMatch(/invalid numeric|60-second/u)
      }
      expect(test.requests()).toBe(1)
    }),
)

it.effect.each(['1e309', '1e308', 'Infinity', 'NaN', '-1'])(
  'rejects unsafe reset timestamp %s',
  (value) =>
    Effect.gen(function* () {
      const test = lookup({ 'x-ratelimit-reset': value })
      const result = yield* test.effect.pipe(Effect.result)
      expect(Result.isFailure(result)).toBe(true)
      expect(test.requests()).toBe(1)
    }),
)

it.effect('bounds repeated rate limits to three retries with exponential backoff', () =>
  Effect.gen(function* () {
    const test = lookup({})
    const fiber = yield* test.effect.pipe(Effect.result, Effect.forkChild)
    for (const [index, delay] of [1000, 2000, 4000].entries()) {
      yield* TestClock.adjust(delay - 1)
      expect(test.requests()).toBe(index + 1)
      yield* TestClock.adjust(1)
    }
    expect(Result.isFailure(yield* Fiber.join(fiber))).toBe(true)
    expect(test.requests()).toBe(4)
  }),
)

it.effect('includes the next provider wait in the 60-second total cap', () =>
  Effect.gen(function* () {
    const test = lookup({ 'retry-after': '30' })
    const fiber = yield* test.effect.pipe(Effect.result, Effect.forkChild)
    yield* TestClock.adjust(29_999)
    expect(test.requests()).toBe(1)
    yield* TestClock.adjust(1)
    expect(test.requests()).toBe(2)
    yield* TestClock.adjust(30_000)
    expect(Result.isFailure(yield* Fiber.join(fiber))).toBe(true)
    expect(test.requests()).toBe(3)
  }),
)
