import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Deferred, Effect, Fiber, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import { runBatchWatch, type BatchResult } from './batch.ts'
import {
  commentWebhookBoundary,
  decodeNotionWebhookSignal,
  notionWebhookTriggerSource,
  webhookSignalToWatchTriggers,
} from './webhook.ts'

const pageId = '00000000-0000-4000-8000-000000000001'
const otherPageId = '00000000-0000-4000-8000-000000000002'

const pageWebhook = (id = pageId): string =>
  JSON.stringify({
    id: 'event-page-edited',
    type: 'page.content_updated',
    timestamp: '2026-06-12T09:00:00.000Z',
    api_version: '2026-03-11',
    attempt_number: 1,
    entity: { id, type: 'page' },
  })

const commentWebhook = (): string =>
  JSON.stringify({
    id: 'event-comment-created',
    type: 'comment.created',
    entity: { id: '00000000-0000-4000-8000-000000000003', type: 'comment' },
    data: { parent: { page_id: pageId } },
  })

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'notion-md-webhook-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('Notion webhook trigger ingestion', () => {
  it('schema-decodes a page webhook into a secret-safe trigger signal', async () => {
    const signal = await Effect.runPromise(decodeNotionWebhookSignal(pageWebhook()))

    expect(signal).toMatchObject({
      _tag: 'NotionWebhookSignal',
      provider: 'notion',
      eventId: 'event-page-edited',
      eventType: 'page.content_updated',
      surface: 'page',
      pageId,
      apiVersion: '2026-03-11',
      attemptNumber: 1,
    })
    expect(JSON.stringify(signal)).not.toContain('verification')
  })

  it('keeps comments as an explicit non-body boundary until comments API support exists', async () => {
    const signal = await Effect.runPromise(decodeNotionWebhookSignal(commentWebhook()))

    expect(signal.surface).toBe('comments')
    expect(commentWebhookBoundary(signal)).toEqual({
      _tag: 'CommentWebhookBoundary',
      eventId: 'event-comment-created',
      eventType: 'comment.created',
      commentId: '00000000-0000-4000-8000-000000000003',
      pageId,
      reason: 'comments-api-not-implemented',
    })

    const triggers = await Effect.runPromise(
      webhookSignalToWatchTriggers({ signal, pagePathIndex: { [pageId]: ['doc.nmd'] } }),
    )
    expect(triggers).toEqual([])
  })

  it('maps page webhook signals to existing watch triggers by tracked page id', async () => {
    const signal = await Effect.runPromise(decodeNotionWebhookSignal(pageWebhook()))

    await expect(
      Effect.runPromise(
        webhookSignalToWatchTriggers({
          signal,
          pagePathIndex: { [pageId]: ['a.nmd', 'b.nmd'], [otherPageId]: ['other.nmd'] },
        }),
      ),
    ).resolves.toEqual([
      { path: 'a.nmd', reason: 'webhook' },
      { path: 'b.nmd', reason: 'webhook' },
    ])
  })

  it('feeds decoded webhook triggers through the same batch watch scheduler', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      await writeFile(path, '')
      const webhookSynced = await Effect.runPromise(Deferred.make<void>())
      const events: unknown[] = []

      const rawPayloads = Stream.succeed(pageWebhook())
      const triggerSource = notionWebhookTriggerSource({
        rawPayloads,
        pagePathIndex: { [pageId]: [path] },
      }).pipe(Stream.catchCause((cause) => Stream.die(cause)))

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkChild(
              runBatchWatch({
                paths: [path],
                pollIntervalMs: 60_000,
                triggerSource,
                runSyncMany: (opts) =>
                  Effect.sync(() => {
                    const result = {
                      _tag: 'batch',
                      operation: 'sync',
                      total: opts.targets.length,
                      succeeded: opts.targets.length,
                      failed: 0,
                      items: opts.targets.map((target) => ({
                        _tag: 'success',
                        operation: 'sync',
                        path: target,
                        result: { _tag: 'noop', path: target, pageId },
                      })),
                    } satisfies BatchResult<{
                      readonly _tag: 'noop'
                      readonly path: string
                      readonly pageId: string
                    }>
                    return result
                  }),
                emit: (event) =>
                  Effect.gen(function* () {
                    events.push(event)
                    if (
                      typeof event === 'object' &&
                      event !== null &&
                      'reason' in event &&
                      event.reason === 'webhook'
                    ) {
                      yield* Deferred.succeed(webhookSynced, undefined)
                    }
                  }),
              }),
            )
            yield* Deferred.await(webhookSynced)
            yield* Fiber.interrupt(fiber)
          }),
        ).pipe(Effect.provide(NodeServices.layer)),
      )

      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'sync',
          reason: 'webhook',
          paths: [path],
          result: expect.objectContaining({ _tag: 'batch', succeeded: 1 }),
        }),
      )
    })
  })
})
