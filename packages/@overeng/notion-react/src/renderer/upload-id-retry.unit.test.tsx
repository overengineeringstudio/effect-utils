import type { HttpClient } from '@effect/platform'
import { Cause, Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { NotionConfig } from '@overeng/notion-effect-client'

import { InMemoryCache } from '../cache/in-memory-cache.ts'
import { Image, Paragraph } from '../components/blocks.ts'
import { createFakeNotion, type FakeNotion } from '../test/mock-client.ts'
import { NotionSyncError } from './errors.ts'
import { sync } from './sync.ts'
import type { OnUploadIdRejected } from './upload-id-retry.ts'

const ROOT = '00000000-0000-4000-8000-000000000001'

const runWith = <A,>(
  fake: FakeNotion,
  eff: Effect.Effect<A, unknown, HttpClient.HttpClient | NotionConfig>,
): Promise<A> => Effect.runPromise(eff.pipe(Effect.provide(fake.layer)))

describe('onUploadIdRejected hook', () => {
  it('retries the op once with a fresh id provided by the consumer', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    // Reject only the stale id; the replacement is accepted.
    const stale = 'stale-upload-id'
    fake.rejectUploadIds((id) => id === stale)

    const calls: {
      blockId: string | undefined
      tmpId: string | undefined
      fileUploadId: string
    }[] = []
    const hook: OnUploadIdRejected = (ctx) =>
      Effect.sync(() => {
        calls.push({ blockId: ctx.blockId, tmpId: ctx.tmpId, fileUploadId: ctx.fileUploadId })
        return { newUploadId: 'fresh-upload-id' }
      })

    const res = await runWith(
      fake,
      sync(<Image fileUploadId={stale} />, {
        pageId: ROOT,
        cache,
        onUploadIdRejected: hook,
      }).pipe(Effect.mapError((cause) => new Error(String(cause)))),
    )
    expect(res.appends).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.fileUploadId).toBe(stale)
    expect(calls[0]!.tmpId).toBeTruthy()
    expect(calls[0]!.blockId).toBeUndefined()

    // Server state carries the replacement id.
    const image = fake.childrenOf(ROOT).find((b) => b.type === 'image')!
    expect(image.payload).toMatchObject({ file_upload: { id: 'fresh-upload-id' } })
  })

  it('caps retries at 1 — second failure surfaces a typed NotionSyncError', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    // Every id is rejected — even the replacement.
    fake.rejectUploadIds(() => true)

    let callCount = 0
    const hook: OnUploadIdRejected = () =>
      Effect.sync(() => {
        callCount += 1
        return { newUploadId: `replacement-${callCount}` }
      })

    const exit = await Effect.runPromiseExit(
      sync(<Image fileUploadId="initial" />, {
        pageId: ROOT,
        cache,
        onUploadIdRejected: hook,
      }).pipe(Effect.provide(fake.layer)),
    )
    expect(exit._tag).toBe('Failure')
    // Hook called exactly once (one retry attempt).
    expect(callCount).toBe(1)
    // The retry attempt also failed — surfaces as upload-id-rejected reason.
    if (exit._tag === 'Failure') {
      const err = Cause.failureOption(exit.cause)
      expect(err._tag).toBe('Some')
      if (err._tag === 'Some') {
        expect((err.value as NotionSyncError).reason).toBe('notion-upload-id-rejected')
      }
    }
  })

  it('no hook provided → surfaces NotionSyncError { reason: notion-upload-id-rejected }', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    fake.rejectUploadIds(() => true)

    const exit = await Effect.runPromiseExit(
      sync(<Image fileUploadId="will-fail" />, { pageId: ROOT, cache }).pipe(
        Effect.provide(fake.layer),
      ),
    )
    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure') {
      const err = Cause.failureOption(exit.cause)
      expect(err._tag).toBe('Some')
      if (err._tag === 'Some') {
        expect((err.value as NotionSyncError).reason).toBe('notion-upload-id-rejected')
      }
    }
  })

  it('leaves non-upload-id errors alone (hook not called)', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    // Fail every append with a generic error.
    fake.failOn((req) =>
      req.method === 'PATCH' && req.path.endsWith('/children')
        ? Object.assign(new Error('boom'), { name: 'RandomError' })
        : undefined,
    )
    let called = 0
    const hook: OnUploadIdRejected = () =>
      Effect.sync(() => {
        called += 1
        return { newUploadId: 'x' }
      })
    const exit = await Effect.runPromiseExit(
      sync(<Paragraph>hi</Paragraph>, {
        pageId: ROOT,
        cache,
        onUploadIdRejected: hook,
      }).pipe(Effect.provide(fake.layer)),
    )
    expect(exit._tag).toBe('Failure')
    expect(called).toBe(0)
  })

  it('propagates errors raised by the hook as NotionSyncError', async () => {
    const fake = createFakeNotion()
    const cache = InMemoryCache.make()
    fake.rejectUploadIds(() => true)
    const hook: OnUploadIdRejected = () =>
      Effect.fail(new NotionSyncError({ reason: 'consumer-reupload-failed' }))

    const exit = await Effect.runPromiseExit(
      sync(<Image fileUploadId="stale" />, {
        pageId: ROOT,
        cache,
        onUploadIdRejected: hook,
      }).pipe(Effect.provide(fake.layer)),
    )
    expect(exit._tag).toBe('Failure')
    if (exit._tag === 'Failure') {
      const err = Cause.failureOption(exit.cause)
      expect(err._tag).toBe('Some')
      if (err._tag === 'Some') {
        expect((err.value as NotionSyncError).reason).toBe('consumer-reupload-failed')
      }
    }
  })
})
